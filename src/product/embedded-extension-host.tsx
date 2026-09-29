import type { EditorAssetImportSourceHandler } from "@forgeax/app-shell/application";
import { usePanelRenderers } from "@forgeax/app-shell/application";
import type { SurfacePane } from "@forgeax/app-shell/window";
import type { ExtensionCatalogEntry } from "@forgeax/extension-host/browser";
import { ExtensionFrame } from "@forgeax/extension-host/react";
import {
	type ComponentType,
	type SyntheticEvent,
	useCallback,
	useEffect,
	useRef,
} from "react";
import type { ExtensionCatalogInfo } from "../integration/rest-extension-catalog-client";
import { useExtensionCatalogEntry } from "./embedded-extension-catalog";
import { attachExtensionEditorAssetImportBridge } from "./embedded-extension-editor-bridge";
import {
	extensionFrameContext,
	extensionRuntimeUrl,
	hasExternalIframeRuntime,
	shouldUseIdeEmbeddedExtensionHost,
} from "./embedded-extension-runtime";
import { getLocale, useTranslation } from "./product-locale";
import { useShellStore } from "./shell-state-runtime";
import "./embedded-extension-host.css";

interface ExtensionPanelProps {
	extensionId: string;
	pane?: SurfacePane;
}

export interface IdeExtensionHostPanelProps extends ExtensionPanelProps {
	manifest: ExtensionCatalogInfo;
	LegacyPanel: ComponentType<ExtensionPanelProps>;
}

function catalogText(
	value: string | { zh?: string; en?: string; ja?: string },
): string {
	if (typeof value === "string") return value;
	const locale = getLocale();
	return value[locale] ?? value.en ?? value.zh ?? value.ja ?? "";
}

/** IDE owns inline, placeholder and selected embedded iframe placements. */
export function IdeExtensionHostPanel({
	extensionId,
	pane,
	manifest,
	LegacyPanel,
}: IdeExtensionHostPanelProps) {
	const { extensionPanels, editor } = usePanelRenderers();
	const InlinePanel = extensionPanels?.[extensionId];
	if (InlinePanel) {
		return (
			<div className="ide-extension-panel ide-extension-panel--inline">
				<InlinePanel />
			</div>
		);
	}
	if (shouldUseIdeEmbeddedExtensionHost(manifest, false)) {
		return (
			<HostedExtensionRuntimePanel
				extensionId={extensionId}
				pane={pane}
				onEditorAssetImport={editor?.importAssetSource}
			/>
		);
	}
	if (
		manifest.runtimeMode === "native-module" ||
		hasExternalIframeRuntime(manifest)
	)
		return <LegacyPanel extensionId={extensionId} pane={pane} />;
	const description = catalogText(manifest.description ?? "");
	return (
		<div className="ide-extension-panel ide-extension-panel--placeholder">
			<div className="ide-extension-panel-name">
				{catalogText(manifest.displayName)}
			</div>
			{description && (
				<div className="ide-extension-panel-description">{description}</div>
			)}
			<div className="ide-extension-panel-id">{manifest.id}</div>
		</div>
	);
}

function HostedExtensionRuntimePanel({
	extensionId,
	pane,
	onEditorAssetImport,
}: ExtensionPanelProps & {
	onEditorAssetImport?: EditorAssetImportSourceHandler;
}) {
	const { t } = useTranslation();
	const activeGameSlug = useShellStore((state) => state.activeGameSlug);
	const activeGameResolved = useShellStore((state) => state.activeGameResolved);
	const runtime = useExtensionCatalogEntry(
		extensionId,
		activeGameSlug,
		activeGameResolved,
	);

	if (runtime.loading) {
		return (
			<div className="page-dock-loading">
				{t("extensionDock.loadingExtensionHost")}
			</div>
		);
	}
	if (runtime.error) {
		return (
			<div className="page-dock-loading page-dock-error" role="alert">
				<div>
					{t("extensionDock.extensionHostFailed", {
						error: runtime.error.message,
					})}
				</div>
				<button type="button" onClick={runtime.retry}>
					{t("extensionDock.retry")}
				</button>
			</div>
		);
	}
	if (runtime.descriptor && activeGameSlug) {
		return (
			<div className="page-dock-panel page-dock-standalone">
				<EmbeddedExtensionRuntimeFrame
					descriptor={runtime.descriptor}
					gameId={activeGameSlug}
					pane={pane}
					onEditorAssetImport={onEditorAssetImport}
				/>
			</div>
		);
	}
	return (
		<div className="page-dock-loading page-dock-error" role="alert">
			<div>
				{activeGameSlug
					? t("extensionDock.extensionExtensionMissing", { extensionId })
					: t("extensionDock.extensionGameRequired")}
			</div>
			<button type="button" onClick={runtime.retry}>
				{t("extensionDock.retry")}
			</button>
		</div>
	);
}

function EmbeddedExtensionRuntimeFrame({
	descriptor,
	gameId,
	pane,
	onEditorAssetImport,
}: {
	descriptor: ExtensionCatalogEntry;
	gameId: string;
	pane?: SurfacePane;
	onEditorAssetImport?: EditorAssetImportSourceHandler;
}) {
	const frameRef = useRef<HTMLIFrameElement | null>(null);
	const importHandlerRef = useRef(onEditorAssetImport);
	importHandlerRef.current = onEditorAssetImport;

	const onFrameLoad = useCallback(
		(event: SyntheticEvent<HTMLIFrameElement>) => {
			frameRef.current = event.currentTarget;
		},
		[],
	);

	useEffect(
		() =>
			attachExtensionEditorAssetImportBridge({
				ownerWindow: window,
				frameWindow: () => frameRef.current?.contentWindow ?? null,
				importAssetSource: (request) => {
					const handler = importHandlerRef.current;
					return handler
						? handler(request)
						: { ok: false, error: "当前 Studio 没有可用的 Editor Gateway" };
				},
			}),
		[],
	);

	return (
		<ExtensionFrame
			runtimeUrl={extensionRuntimeUrl(
				descriptor.runtimeUrl,
				pane,
				window.location.href,
			)}
			context={extensionFrameContext(descriptor, gameId, getLocale())}
			sandbox="allow-scripts allow-same-origin"
			title={pane ? `${descriptor.title} — ${pane}` : descriptor.title}
			data-extension-runtime={descriptor.extensionId}
			data-extension-pane={pane}
			style={{ display: "block", width: "100%", height: "100%", border: 0 }}
			onLoad={onFrameLoad}
		/>
	);
}
