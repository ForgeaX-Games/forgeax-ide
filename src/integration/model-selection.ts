import type { ModelCatalogEntry } from "./rest-model-config-client";

/** Preserve an explicit user choice while it remains visible in this catalog. */
export function preferredCatalogModel(
	catalog: readonly ModelCatalogEntry[],
	remembered: string | null,
): string | undefined {
	if (
		remembered &&
		catalog.some((model) => model.id === remembered && !model.hidden)
	) {
		return remembered;
	}
	return catalog.find((model) => !model.hidden)?.id ?? catalog[0]?.id;
}

/**
 * CLI sessions need a model from their provider catalog. Native sessions keep
 * their scaffold default unless the user has a still-valid remembered choice.
 */
export function initialSessionCatalogModel(
	catalog: readonly ModelCatalogEntry[],
	catalogProviderId: string | null,
	remembered: string | null,
): string | undefined {
	const rememberedEntry = remembered
		? catalog.find((model) => model.id === remembered && !model.hidden)
		: undefined;
	if (rememberedEntry) return rememberedEntry.id;
	return catalogProviderId ? preferredCatalogModel(catalog, null) : undefined;
}
