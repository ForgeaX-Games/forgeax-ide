import type {
	AgentModelState,
	ModelCatalogEntry,
} from "./rest-model-config-client";

export type ModelSource =
	| { kind: "api-key"; model: string }
	| { kind: "cli"; providerId: string };

export type ActiveSourceId = "api-key" | string | null;

export interface ModelRouteStateSnapshot {
	tabs: ReadonlyArray<{
		sid?: string | null;
		agentId?: string | null;
	}>;
	setProviderOverride(providerId: string | null): void;
}

type ModelConfigRequest = (
	input: string,
	init?: RequestInit,
) => Promise<Response>;

export interface ModelRouteDependencies {
	getState(): ModelRouteStateSnapshot;
	getLastModel?(providerId: string | null): string | null;
	listModels(providerId?: string | null): Promise<ModelCatalogEntry[]>;
	setAgentModels(
		sid: string,
		agentPath: string,
		models: string[],
	): Promise<
		Pick<AgentModelState, "selected" | "chain"> & { restarted: boolean }
	>;
	request?: ModelConfigRequest;
	warn?: (...args: unknown[]) => void;
}

export interface ModelRouteService {
	applyModelRoute(source: ModelSource): Promise<void>;
	resetOpenSessionsModelToProviderDefault(
		providerId: string | null,
	): Promise<{ selected: string; count: number } | null>;
}

const RE_OPENAI = /^(gpt-|o[1-9]|codex-)/i;

/** Derive the visible source from the two existing routing inputs. */
export function deriveActiveSource(
	providerOverride: string | null,
	forgeaxModel: string | null,
): ActiveSourceId {
	if (providerOverride && providerOverride !== "forgeax")
		return providerOverride;
	const model = (forgeaxModel ?? "").trim();
	if (model && RE_OPENAI.test(model)) return "api-key";
	if (model) return "api-key";
	return null;
}

/** Resolve the provider-scoped model catalog without introducing new state. */
export function currentCatalogProvider(
	providerOverride: string | null,
): string | null {
	return providerOverride && providerOverride !== "forgeax"
		? providerOverride
		: null;
}

export function createModelRouteService({
	getState,
	getLastModel = () => null,
	listModels,
	setAgentModels,
	request = (input, init) => fetch(input, init),
	warn = (...args) => console.warn(...args),
}: ModelRouteDependencies): ModelRouteService {
	async function patchEnv(patch: Record<string, string>): Promise<void> {
		const response = await request("/api/settings/env", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(patch),
		});
		const payload = (await response.json().catch(() => null)) as {
			ok?: boolean;
			error?: string;
		} | null;
		if (!response.ok || !payload?.ok) {
			throw new Error(payload?.error ?? `HTTP ${response.status}`);
		}
	}

	async function applyModelRoute(source: ModelSource): Promise<void> {
		const setProviderOverride = getState().setProviderOverride;
		switch (source.kind) {
			case "api-key":
				await patchEnv({ FORGEAX_MODEL: source.model });
				setProviderOverride(null);
				return;
			case "cli":
				setProviderOverride(source.providerId);
		}
	}

	async function resetOpenSessionsModelToProviderDefault(
		providerId: string | null,
	): Promise<{ selected: string; count: number } | null> {
		const targets = getState()
			.tabs.map(({ sid, agentId }) => ({ sid, agentPath: agentId }))
			.filter(
				(target): target is { sid: string; agentPath: string } =>
					Boolean(target.sid) && Boolean(target.agentPath),
			);
		if (targets.length === 0) return null;

		const catalog = await listModels(providerId);
		const remembered = getLastModel(providerId);
		const nextModel =
			catalog.find((model) => model.id === remembered && !model.hidden)?.id ??
			catalog.find((model) => !model.hidden)?.id ??
			catalog[0]?.id;
		if (!nextModel) return null;

		let count = 0;
		for (const { sid, agentPath } of targets) {
			try {
				await setAgentModels(sid, agentPath, [nextModel]);
				count += 1;
			} catch (error) {
				warn("[model-route] reset session model failed", {
					sid,
					agentPath,
					err: error,
				});
			}
		}
		return count > 0 ? { selected: nextModel, count } : null;
	}

	return {
		applyModelRoute,
		resetOpenSessionsModelToProviderDefault,
	};
}
