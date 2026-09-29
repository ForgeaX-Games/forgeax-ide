import { subscribeUiEvents } from "./ui-event-stream";
/** Product-owned HTTP contracts, matching the existing Studio service responses. */

export interface AgentCatalogEntry {
	id: string;
	role?: string;
	avatarRules?: unknown;
	[key: string]: unknown;
}

export interface AgentCatalogResponse {
	agents: AgentCatalogEntry[];
	agents_from_bus?: Array<{ id: string; role: string }>;
	activeSlug?: string | null;
}

export interface EngineRootCandidate {
	path: string;
	valid: boolean;
	recommended?: boolean;
}

export interface ProjectRow {
	slug: string;
	name?: string;
	brief?: string;
	[key: string]: unknown;
}

export type BuildProjectOptions = Record<string, unknown>;

export interface BuildJobStatus {
	jobId: string;
	status: "pending" | "running" | "success" | "failed" | "error" | "cancelled";
	[key: string]: unknown;
}

export interface BuildHistoryRecord {
	id: string;
	slug: string;
	platform: string;
	[key: string]: unknown;
}

export interface ActiveProjectSelection {
	activeSlug: string | null;
	runtime?: RuntimeScopeState;
}

export type RuntimeScopeStatus =
	| "unbound"
	| "transitioning"
	| "ready"
	| "degraded"
	| "unavailable";

export interface RuntimeAssetDiagnostic {
	code: string;
	severity: "info" | "warning" | "blocking";
	message?: string;
	hint?: string;
}

export interface RuntimeCatalogRoot {
	readonly root: string;
	readonly catalogPrefix: string;
}

export interface RuntimeAssetBinding {
	schemaVersion: "runtime-asset-binding-v1";
	gameId: string;
	scopeId: string;
	generation: number;
	status: RuntimeScopeStatus;
	catalogUrl: string;
	importUrlBase: string;
	packageUrlBase: string;
	catalogRoots?: readonly RuntimeCatalogRoot[];
	authority?: "authoritative" | "degraded";
	diagnostics?: readonly RuntimeAssetDiagnostic[];
}

export interface RuntimeScopeState {
	status: RuntimeScopeStatus;
	binding?: RuntimeAssetBinding;
	error?: string;
}

export interface CleanBuildResult {
	totalBytes: number;
	targets: Array<{
		path: string;
		existed: boolean;
		removed: boolean;
		bytes: number;
		error?: string;
	}>;
}

export interface AgentCatalogClient {
	listAgents(opts?: { lang?: "zh" | "en" }): Promise<AgentCatalogResponse>;
}

export interface StudioProjectClient {
	getActiveProject(): Promise<ActiveProjectSelection>;
	setActiveProject(slug: string): Promise<ActiveProjectSelection>;
	subscribeActiveProject(
		listener: (selection: ActiveProjectSelection) => void,
	): () => void;
	listProjects(): Promise<{ games: ProjectRow[]; activeSlug: string | null }>;
	createProject(input: {
		slug: string;
		name: string;
		brief: string;
		template?: string;
	}): Promise<{
		ok: boolean;
		error?: string;
		slug?: string;
		session?: { sid: string };
	}>;
	linkProject(
		path: string,
	): Promise<{ ok: boolean; error?: string; slug?: string }>;
	deleteProject(slug: string): Promise<void>;
}

export interface StudioBuildClient {
	buildProject(
		slug: string,
		options?: BuildProjectOptions,
	): Promise<{
		jobId?: string;
		async?: boolean;
		ok?: boolean;
		[key: string]: unknown;
	}>;
	pollBuildJob(jobId: string): Promise<BuildJobStatus>;
	getEngineRoots(): Promise<{ roots: EngineRootCandidate[] }>;
	cleanBuilds(): Promise<CleanBuildResult>;
	listBuildHistory(): Promise<{ records: BuildHistoryRecord[] }>;
	deleteBuildHistory(id: string, opts?: { clean?: boolean }): Promise<void>;
}

export interface RestStudioDomainClients {
	agents: AgentCatalogClient;
	projects: StudioProjectClient;
	builds: StudioBuildClient;
}

const TRANSIENT_RETRIES = 8;
const TRANSIENT_RETRY_DELAY_MS = 250;
export const ACTIVE_PROJECT_SWITCH_SUPERSEDED =
	"ACTIVE_PROJECT_SWITCH_SUPERSEDED";

function apiErrorMessage(raw: unknown, status: number): string {
	if (typeof raw === "string" && raw.trim()) return raw;
	if (raw !== null && typeof raw === "object") {
		const error = raw as {
			error?: unknown;
			hint?: unknown;
			message?: unknown;
			code?: unknown;
		};
		for (const value of [error.error, error.hint, error.message, error.code]) {
			if (typeof value === "string" && value.trim()) return value;
		}
	}
	return `HTTP ${status}`;
}

function supersededError(): Error & {
	code: typeof ACTIVE_PROJECT_SWITCH_SUPERSEDED;
} {
	return Object.assign(
		new Error("active project switch was superseded by a newer selection"),
		{
			name: "AbortError",
			code: ACTIVE_PROJECT_SWITCH_SUPERSEDED as typeof ACTIVE_PROJECT_SWITCH_SUPERSEDED,
		},
	);
}

function abortableDelay(
	milliseconds: number,
	signal: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(supersededError());
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(supersededError());
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function normalizeActiveProject(raw: unknown): ActiveProjectSelection | null {
	if (raw === null || typeof raw !== "object") return null;
	const candidate = raw as { activeSlug?: unknown; runtime?: unknown };
	if (
		!(candidate.activeSlug === null || typeof candidate.activeSlug === "string")
	)
		return null;
	return candidate.runtime !== undefined &&
		candidate.runtime !== null &&
		typeof candidate.runtime === "object"
		? {
				activeSlug: candidate.activeSlug,
				runtime: candidate.runtime as RuntimeScopeState,
			}
		: { activeSlug: candidate.activeSlug };
}

export function createRestStudioDomainClients(): RestStudioDomainClients {
	let activeProjectRevision = 0;
	let activeProjectController: AbortController | undefined;
	return {
		agents: {
			async listAgents(options) {
				const response = await fetch(
					options?.lang === "zh" ? "/api/agents?lang=zh" : "/api/agents",
				);
				if (!response.ok)
					throw new Error(`listAgents → HTTP ${response.status}`);
				return response.json();
			},
		},
		projects: {
			async getActiveProject() {
				const response = await fetch("/api/projects/active");
				if (!response.ok) return { activeSlug: null };
				const raw: unknown = await response.json();
				const normalized = normalizeActiveProject(raw);
				return normalized ?? { activeSlug: null };
			},
			async setActiveProject(slug) {
				const revision = ++activeProjectRevision;
				activeProjectController?.abort();
				const controller = new AbortController();
				activeProjectController = controller;
				try {
					for (let attempt = 0; ; attempt += 1) {
						let response: Response;
						try {
							response = await fetch("/api/projects/active", {
								method: "PUT",
								headers: { "content-type": "application/json" },
								body: JSON.stringify({ slug }),
								signal: controller.signal,
							});
						} catch (error) {
							if (
								controller.signal.aborted ||
								revision !== activeProjectRevision
							)
								throw supersededError();
							throw error;
						}
						const raw = (await response.json().catch(() => null)) as unknown;
						if (controller.signal.aborted || revision !== activeProjectRevision)
							throw supersededError();
						if (response.ok) {
							const selection = normalizeActiveProject(raw);
							if (!selection)
								throw new Error(
									"setActiveProject → invalid active-project response",
								);
							return selection;
						}
						const retryable =
							response.status === 503 &&
							raw !== null &&
							typeof raw === "object" &&
							(raw as { retryable?: unknown }).retryable === true;
						if (!retryable || attempt >= TRANSIENT_RETRIES) {
							const failure = new Error(
								`setActiveProject → ${apiErrorMessage(raw, response.status)}`,
							);
							const code =
								raw !== null && typeof raw === "object"
									? (raw as { code?: unknown }).code
									: undefined;
							if (typeof code === "string") Object.assign(failure, { code });
							throw failure;
						}
						await abortableDelay(TRANSIENT_RETRY_DELAY_MS, controller.signal);
					}
				} finally {
					if (activeProjectController === controller)
						activeProjectController = undefined;
				}
			},
			subscribeActiveProject(listener) {
				let closed = false;
				let revision = 0;
				const controller = new AbortController();
				const readAuthority = async () => {
					const requestedRevision = ++revision;
					try {
						const response = await fetch("/api/projects/active", {
							signal: controller.signal,
						});
						const raw: unknown = response.ok ? await response.json() : null;
						const selection = normalizeActiveProject(raw);
						if (!closed && requestedRevision === revision && selection)
							listener(selection);
					} catch {
						/* The next connection reads authority again. */
					}
				};
				const unsubscribe = subscribeUiEvents(
					"projects.active.changed",
					(raw) => {
						if (closed || !raw || typeof raw !== "object") return;
						const selection = normalizeActiveProject(
							(raw as { payload?: unknown }).payload,
						);
						if (selection) {
							revision++;
							listener(selection);
						}
					},
					() => {
						void readAuthority();
					},
				);
				return () => {
					closed = true;
					controller.abort();
					unsubscribe();
				};
			},
			async listProjects() {
				const response = await fetch("/api/projects");
				if (!response.ok)
					throw new Error(`listProjects → HTTP ${response.status}`);
				return response.json();
			},
			async createProject(input) {
				const response = await fetch("/api/projects", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(input),
				});
				const body = (await response.json().catch(() => null)) as {
					ok?: boolean;
					error?: unknown;
					slug?: string;
					session?: { sid: string };
				} | null;
				const ok = Boolean(response.ok && body?.ok);
				return {
					ok,
					error: ok ? undefined : apiErrorMessage(body?.error, response.status),
					...(body?.slug ? { slug: body.slug } : {}),
					...(body?.session ? { session: body.session } : {}),
				};
			},
			async linkProject(path) {
				const response = await fetch("/api/projects/link", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ path }),
				});
				const body = (await response.json().catch(() => null)) as {
					ok?: boolean;
					error?: unknown;
					slug?: string;
				} | null;
				const ok = Boolean(response.ok && body?.ok);
				return {
					ok,
					error: ok ? undefined : apiErrorMessage(body?.error, response.status),
					slug: body?.slug,
				};
			},
			async deleteProject(slug) {
				const response = await fetch(
					`/api/projects/${encodeURIComponent(slug)}`,
					{ method: "DELETE" },
				);
				if (!response.ok)
					throw new Error(`deleteProject → HTTP ${response.status}`);
			},
		},
		builds: {
			async buildProject(slug, options) {
				const hasBody = options != null;
				const response = await fetch(
					`/api/projects/${encodeURIComponent(slug)}/builds`,
					{
						method: "POST",
						headers: hasBody
							? { "content-type": "application/json" }
							: undefined,
						body: hasBody ? JSON.stringify(options) : undefined,
					},
				);
				if (!response.ok)
					throw new Error(`buildProject → HTTP ${response.status}`);
				return response.json();
			},
			async pollBuildJob(jobId) {
				const response = await fetch(
					`/api/project-builds/jobs/${encodeURIComponent(jobId)}`,
				);
				if (!response.ok)
					throw new Error(`pollBuildJob → HTTP ${response.status}`);
				return response.json();
			},
			async getEngineRoots() {
				const response = await fetch("/api/project-builds/engine-roots");
				return response.ok ? response.json() : { roots: [] };
			},
			async cleanBuilds() {
				const response = await fetch("/api/project-builds/clean", {
					method: "POST",
				});
				if (!response.ok)
					throw new Error(`cleanBuilds → HTTP ${response.status}`);
				return response.json();
			},
			async listBuildHistory() {
				const response = await fetch("/api/project-builds/history");
				return response.ok ? response.json() : { records: [] };
			},
			async deleteBuildHistory(id, options) {
				const suffix = options?.clean ? "?clean=1" : "";
				const response = await fetch(
					`/api/project-builds/history/${encodeURIComponent(id)}${suffix}`,
					{
						method: "DELETE",
					},
				);
				if (!response.ok)
					throw new Error(`deleteBuildHistory → HTTP ${response.status}`);
			},
		},
	};
}
