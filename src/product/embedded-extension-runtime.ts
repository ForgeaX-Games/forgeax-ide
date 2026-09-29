import type { SurfacePane } from "@forgeax/app-shell/window";
import type { ExtensionCatalogInfo } from "../integration/rest-extension-catalog-client";
import { isIdeExtensionHostExtension } from "./catalog-page-extensions";

export const EXTENSION_API_BASE = "/__extension__/v1/";

export function hasExternalIframeRuntime(
	manifest: ExtensionCatalogInfo,
): boolean {
	return Boolean(
		manifest.frontendUrl ||
			manifest.entry?.standalone ||
			manifest.entry?.frontend ||
			manifest.runtimeMode === "embedded",
	);
}

/** The selected embedded iframe extensions use the IDE runtime host. */
export function shouldUseIdeEmbeddedExtensionHost(
	manifest: ExtensionCatalogInfo,
	hasInlinePanel: boolean,
): boolean {
	return (
		!hasInlinePanel &&
		isIdeExtensionHostExtension(manifest.id) &&
		manifest.runtimeMode !== "native-module" &&
		hasExternalIframeRuntime(manifest)
	);
}

export function extensionRuntimeUrl(
	runtimeUrl: string,
	pane: SurfacePane | undefined,
	baseHref: string,
): string {
	if (!pane) return runtimeUrl;
	const url = new URL(runtimeUrl, baseHref);
	url.searchParams.set("pane", pane);
	return url.origin === new URL(baseHref).origin
		? `${url.pathname}${url.search}${url.hash}`
		: url.toString();
}

export interface EmbeddedExtensionDescriptor {
	readonly extensionId: string;
	readonly runtimeId: string;
	readonly title: string;
	readonly runtimeUrl: string;
}

export function extensionFrameContext(
	descriptor: EmbeddedExtensionDescriptor,
	gameId: string,
	locale: string,
) {
	const runtimeId = encodeURIComponent(descriptor.runtimeId);
	const encodedGameId = encodeURIComponent(gameId);
	return {
		extensionId: descriptor.extensionId,
		runtimeId: descriptor.runtimeId,
		gameId,
		locale,
		theme: "dark" as const,
		endpoints: {
			toolCall: `${EXTENSION_API_BASE}tools/call`,
			gamePackage: `${EXTENSION_API_BASE}games/${encodedGameId}/package?runtimeId=${runtimeId}`,
			extensionApi: `${EXTENSION_API_BASE}extension/${runtimeId}?gameId=${encodedGameId}`,
			gameVersions: `${EXTENSION_API_BASE}games/${encodedGameId}/versions`,
			gameComponents: `${EXTENSION_API_BASE}games/${encodedGameId}/components`,
		},
		capabilities: [
			"tools.call",
			"project.files",
			"game.package",
			"media",
			"versioning",
			"extension.http",
		],
	};
}
