import type { RuntimeAssetBinding } from "./shell-state-domain-contract";

export type CommittedRuntimeBinding = RuntimeAssetBinding & {
	readonly status: "ready" | "degraded";
};

export interface CommittedViewportSelection {
	readonly slug: string;
	readonly binding: CommittedRuntimeBinding;
	readonly key: string;
}

function isCommittedStatus(value: unknown): value is "ready" | "degraded" {
	return value === "ready" || value === "degraded";
}

function isCommittedBinding(
	value: unknown,
	slug: string,
): value is CommittedRuntimeBinding {
	if (value === null || typeof value !== "object") return false;
	const candidate = value as Record<string, unknown>;
	return (
		candidate.schemaVersion === "runtime-asset-binding-v1" &&
		(candidate.catalogRoots === undefined ||
			(Array.isArray(candidate.catalogRoots) &&
				candidate.catalogRoots.every((entry: unknown) => {
					if (!entry || typeof entry !== "object") return false;
					const root = entry as Record<string, unknown>;
					return (
						typeof root.root === "string" &&
						typeof root.catalogPrefix === "string"
					);
				}))) &&
		candidate.gameId === slug &&
		typeof candidate.scopeId === "string" &&
		candidate.scopeId.trim().length > 0 &&
		typeof candidate.generation === "number" &&
		Number.isSafeInteger(candidate.generation) &&
		candidate.generation > 0 &&
		isCommittedStatus(candidate.status) &&
		typeof candidate.catalogUrl === "string" &&
		candidate.catalogUrl.trim().length > 0 &&
		typeof candidate.importUrlBase === "string" &&
		candidate.importUrlBase.trim().length > 0 &&
		typeof candidate.packageUrlBase === "string" &&
		candidate.packageUrlBase.trim().length > 0
	);
}

export function resolveCommittedViewportSelection(
	slug: string | null,
	runtime: unknown,
): CommittedViewportSelection | undefined {
	if (slug === null || runtime === null || typeof runtime !== "object")
		return undefined;
	const projection = runtime as { status?: unknown; binding?: unknown };
	if (!isCommittedStatus(projection.status)) return undefined;
	if (!isCommittedBinding(projection.binding, slug)) return undefined;
	return {
		slug,
		binding: projection.binding,
		key: `${slug}:${projection.binding.scopeId}:${projection.binding.generation}`,
	};
}
