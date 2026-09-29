/**
 * Unified Lucide mapping for open document tabs — the SSOT for "what icon does
 * this page show". Uses one pure, react-free resolver so the tab strip and
 * overflow menu never drift on icon semantics.
 */

import type { ResourceDescriptor } from "@forgeax/types";
import {
	Box,
	Clapperboard,
	File,
	FileCode2,
	FileText,
	Image,
	type LucideIcon,
	Music,
	Package,
	Puzzle,
	Settings2,
	Type,
} from "lucide-react";

/** Coarse content family a page belongs to — the axis icons key off. */
export type PageKind =
	| "scene"
	| "model"
	| "image"
	| "audio"
	| "font"
	| "pack"
	| "code"
	| "doc"
	| "config"
	| "plugin";

const ICON_BY_KIND: Record<PageKind, LucideIcon> = {
	scene: Clapperboard,
	model: Box,
	image: Image,
	audio: Music,
	font: Type,
	pack: Package,
	code: FileCode2,
	doc: FileText,
	config: Settings2,
	plugin: Puzzle,
};

const EXT_KIND: ReadonlyArray<readonly [readonly string[], PageKind]> = [
	[["ts", "tsx", "js", "jsx", "mjs", "cjs", "py"], "code"],
	[["md", "markdown", "txt"], "doc"],
	[["png", "jpg", "jpeg", "webp", "gif", "svg", "ico", "hdr"], "image"],
	[["mp3", "wav", "ogg", "flac", "aac", "m4a", "opus"], "audio"],
	[["glb", "gltf", "fbx"], "model"],
	[["ttf", "otf", "woff2"], "font"],
];

/** Derive the content family from a resource path, else from the page type id. */
export function pageKindOf(input: {
	typeId: string;
	resource?: ResourceDescriptor;
}): PageKind {
	const path = (
		input.resource?.displayPath ??
		input.resource?.uri ??
		""
	).toLowerCase();
	if (path) {
		if (path.endsWith(".scene.json")) return "scene";
		if (path.endsWith(".pack.json"))
			return path.includes("scene") ? "scene" : "pack";
		const ext = path.split(/[?#]/u, 1)[0]?.split(".").pop() ?? "";
		for (const [exts, kind] of EXT_KIND) if (exts.includes(ext)) return kind;
		if (path.endsWith("forge.json") || path.endsWith("package.json"))
			return "config";
	}
	const id = input.typeId.toLowerCase();
	for (const kind of Object.keys(ICON_BY_KIND) as PageKind[]) {
		if (id.includes(kind)) return kind;
	}
	if (id.includes("scene") || id.includes("level")) return "scene";
	if (id.includes("extension") || id.includes("plugin")) return "plugin";
	return "config";
}

/** Resolve the Lucide icon for a page. Never returns undefined. */
export function iconForPage(input: {
	typeId: string;
	resource?: ResourceDescriptor;
}): LucideIcon {
	const path = (
		input.resource?.displayPath ??
		input.resource?.uri ??
		""
	).toLowerCase();
	const kind = pageKindOf(input);
	// A resource-less, unclassifiable page falls back to a neutral file glyph
	// rather than a misleading "config" icon.
	if (
		!path &&
		kind === "config" &&
		!input.typeId.toLowerCase().includes("config")
	)
		return File;
	return ICON_BY_KIND[kind];
}
