import type { AppHost } from "@forgeax/app-shell/application";
import { Box, type LucideIcon, icons as LucideIcons } from "lucide-react";

type RegisteredPage =
	| {
			readonly status: "available";
			readonly owner: string;
			readonly definition: { readonly cardinality: string };
	  }
	| {
			readonly status: "unavailable";
			readonly owner: string;
	  };

interface PageRegistrySnapshot {
	readonly pageTypes: ReadonlyMap<string, RegisteredPage>;
}

function extensionIdSlug(id: string): string {
	return id.replace(/^@forgeax-extension\//, "").replace(/^@forgeax\//, "");
}

/** Select localized catalog text using the Gallery's established fallback order. */
export function extensionGalleryText(
	text: string | Record<string, string> | undefined,
	locale: string,
	fallback = "",
): string {
	if (!text) return fallback;
	if (typeof text === "string") return text;
	return text[locale] ?? text.zh ?? text.en ?? fallback;
}

function extensionPageMatches(
	extensionId: string,
	owner: string,
	typeId: string,
): boolean {
	const requested = extensionId.trim();
	if (!requested) return false;
	const needle = extensionIdSlug(requested);
	return (
		owner === requested ||
		extensionIdSlug(owner) === needle ||
		typeId === requested ||
		extensionIdSlug(typeId) === needle
	);
}

/** Open the first available singleton page owned by an extension. */
export async function openExtensionGalleryPage(
	host: AppHost,
	extensionId: string,
): Promise<void> {
	const snapshot = host.pageRegistry.getSnapshot() as PageRegistrySnapshot;
	const page = [...snapshot.pageTypes.entries()].find(
		([typeId, resolved]) =>
			resolved.status === "available" &&
			extensionPageMatches(extensionId, resolved.owner, typeId),
	);
	if (!page)
		throw new Error(
			`extension "${extensionId}" contributes no available singleton page`,
		);
	const [typeId, resolved] = page;
	if (
		resolved.status !== "available" ||
		resolved.definition.cardinality !== "singleton"
	) {
		throw new Error(`extension "${extensionId}" has no default singleton page`);
	}
	await host.pages.open({
		typeId: typeId as Parameters<AppHost["pages"]["open"]>[0]["typeId"],
	});
}

function toPascalCase(name: string): string {
	return name
		.trim()
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
		.join("");
}

function declaredLucideIcon(name?: string): LucideIcon | undefined {
	if (!name || !/^[A-Za-z][A-Za-z0-9_\-\s]*$/.test(name.trim()))
		return undefined;
	return (LucideIcons as Record<string, LucideIcon | undefined>)[
		toPascalCase(name)
	];
}

/** Resolve an explicit Lucide name, falling back to the neutral box glyph. */
export function extensionGalleryIcon(name?: string): LucideIcon {
	return declaredLucideIcon(name) ?? Box;
}
