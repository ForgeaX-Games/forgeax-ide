/** Domain-shaped Studio service contracts injected by the product composition root. */

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

export interface AndroidConfig {
	applicationId: string;
	name: string;
	icon?: string;
	orientation?: "portrait" | "landscape";
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

export interface StudioDomainClients {
	agents: AgentCatalogClient;
	projects: StudioProjectClient;
	builds: StudioBuildClient;
}
