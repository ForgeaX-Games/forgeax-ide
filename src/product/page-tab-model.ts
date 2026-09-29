import type { PageRegistrySnapshot } from "@forgeax/app-shell/pages";
import type { QualifiedPageTypeId } from "@forgeax/types";

export interface OpenablePageType {
	readonly id: QualifiedPageTypeId;
	readonly title: string;
	readonly cardinality: "singleton" | "multi-instance";
}

/** Page types that can be opened without first selecting a resource. */
export function openablePageTypes(
	snapshot: PageRegistrySnapshot,
): OpenablePageType[] {
	return [...snapshot.pageTypes.entries()]
		.flatMap(([id, resolved]) => {
			if (resolved.status !== "available") return [];
			const cardinality = resolved.definition.cardinality;
			if (cardinality === "resource") return [];
			return [{ id, title: resolved.definition.title, cardinality }];
		})
		.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}
