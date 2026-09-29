declare module "@forgeax/chat" {
	import type { ComponentType } from "react";
	export const ChatPanel: ComponentType;
}

declare module "@forgeax/chat/session-store" {
	export const connectForgeaXWs: (...args: any[]) => any;
	export const createSession: (...args: any[]) => any;
	export const deleteSession: (...args: any[]) => any;
	export const disconnectForgeaXWs: (...args: any[]) => any;
	export const emitForgeaXMessage: (...args: any[]) => any;
	export const ensureSession: (...args: any[]) => any;
	export const fetchSessionList: (...args: any[]) => any;
	export const listSessionAgents: (...args: any[]) => any;
	export const onSessionEvent: (...args: any[]) => any;
	export const subscribeDaemonTick: (...args: any[]) => any;
	export const subscribeSessionStream: (...args: any[]) => any;
}

declare module "@forgeax/dashboard" {
	import type { ComponentType } from "react";
	export type DashboardTranslate = (
		key: string,
		values?: Record<string, string | number>,
	) => string;
	export interface DashboardRuntime {
		open: boolean;
		activeSessionId: string | null;
		translate: DashboardTranslate;
		close(): void;
		openSession(sid: string): void | Promise<void>;
		openBus(options?: { kind?: string; extensionId?: string }): void;
		confirm(options: { body: string; danger?: boolean }): Promise<boolean>;
		alert(options: { body: string }): void | Promise<void>;
	}
	export const Dashboard: ComponentType<{ runtime: DashboardRuntime }>;
}

declare module "@forgeax/extension-gallery" {
	import type { AppExtension } from "@forgeax/app-shell/application";
	export interface ExtensionGalleryInfo {
		readonly id: string;
		readonly version?: string;
		readonly displayName?: string | Record<string, string>;
		readonly description?: string | Record<string, string>;
		readonly icon?: string;
		readonly experimental?: boolean;
		readonly tools?: readonly unknown[];
		readonly events?: readonly unknown[];
		readonly contributes?: {
			readonly pages?: readonly {
				readonly id?: string;
				readonly icon?: string;
			}[];
			readonly activities?: readonly { readonly icon?: string }[];
		};
	}
	export interface ExtensionGalleryRuntime {
		useTranslation(): {
			readonly t: (key: string) => string;
			readonly locale: string;
		};
		listExtensions(): Promise<{
			readonly items: readonly ExtensionGalleryInfo[];
		}>;
	}
	export function createExtensionGalleryContribution(
		runtime: ExtensionGalleryRuntime,
	): AppExtension;
}

declare module "@forgeax/files" {
	import type { AppExtension } from "@forgeax/app-shell/application";
	export type PreviewKind =
		| "text"
		| "image"
		| "audio"
		| "video"
		| "model"
		| "binary";
	export type ReadFileResult =
		| {
				ok: true;
				kind: PreviewKind;
				mime: string;
				size: number;
				content?: string;
		  }
		| { ok: false; status: number; statusText: string; error?: string };
	export interface FilesClient {
		readFile(path: string): Promise<ReadFileResult>;
		saveFile(
			path: string,
			content: string,
		): Promise<{ ok: boolean; bytes?: number; error?: string }>;
		rawUrl(path: string): string;
	}
	export interface FilesRuntime {
		readonly client: FilesClient;
		peek(topic: string): unknown;
		publish(
			topic: string,
			payload: unknown,
			options?: { retain?: boolean },
		): void;
		subscribe(topic: string, listener: (payload: unknown) => void): () => void;
		useBusSnapshot(topic: string): unknown;
		openResource(resource: {
			canonicalId: string;
			uri: string;
			displayPath: string;
			mime: string;
			kind: PreviewKind;
		}): void | Promise<void>;
	}
	export function configureFilesRuntime(runtime: FilesRuntime): void;
	export function initFiles(): void;
	export function createFilesContribution(): AppExtension;
}

declare module "@forgeax/settings" {
	import type { ComponentType, ReactNode } from "react";
	export interface SettingsRuntime {
		t(key: string, values?: Record<string, string | number>): string;
		locale: "en" | "zh";
		changeLanguage(locale: "en" | "zh"): void;
		providerOverride: string | null;
		buildShortcuts(): Array<{
			combo: string;
			label: string;
			group: "layout" | "mode" | "overlay" | "focus" | "general" | "edit";
		}>;
		fetchCliProviders(force?: boolean): Promise<{
			providers: Array<{
				id: string;
				displayName: string;
				capabilities: Record<string, boolean>;
				health: { ok: boolean; detail?: string };
			}>;
			cachedAt: number;
		}>;
		listSharedCapabilities(): Promise<{
			generation: number;
			loadedAt: number;
			capabilities: Array<{
				capabilityId: string;
				kind: "skill" | "command" | "mcp" | "extension" | "memory" | "tool";
				extensionId: string;
				extensionVersion: string;
				origin: "builtin" | "user" | "project";
				localId: string;
				lifecycle: { requiresRestart: boolean };
			}>;
			issues: string[];
		}>;
		refreshAllModelCatalogs(): Promise<void>;
		deriveActiveSource(
			providerOverride: string | null,
			forgeaxModel: string | null,
		): string | null;
		currentCatalogProvider(providerOverride: string | null): string | null;
		resetOpenSessionsModelToProviderDefault(
			providerId: string | null,
		): Promise<{ selected: string; count: number } | null>;
		applyModelRoute(
			source:
				| { kind: "api-key"; model: string }
				| { kind: "cli"; providerId: string },
		): Promise<void>;
	}
	export const SettingsPanel: ComponentType<{
		open: boolean;
		activeId: string | null;
		onClose(): void;
		onActiveIdChange(id: string): void;
	}>;
	export const SettingsSectionsRegister: ComponentType<{
		activeId: string | null;
		onActiveIdChange(id: string): void;
	}>;
	export const SettingsRuntimeProvider: ComponentType<{
		runtime: SettingsRuntime;
		children: ReactNode;
	}>;
	export function initAgentPrefs(bus?: {
		publish(
			topic: string,
			payload: unknown,
			options?: { retain?: boolean },
		): void;
		peek(topic: string): unknown;
		subscribe(topic: string, listener: (payload: unknown) => void): () => void;
	}): void;
}

declare module "@forgeax/editor/bridge" {
	import type { ViewportRuntimeIdentity } from "@forgeax/editor/viewport-runtime";
	export interface TransportRequest {
		readonly jsonrpc: "2.0";
		readonly version: "editor-transport/v1";
		readonly id: string;
		readonly correlationId: string;
		readonly scope: string;
		readonly timeoutMs?: number;
		readonly method: string;
		readonly params: unknown;
	}
	export interface TransportResponse {
		readonly jsonrpc: "2.0";
		readonly version: "editor-transport/v1";
		readonly id: string;
		readonly correlationId: string;
		readonly runId?: string;
		readonly result?: unknown;
		readonly error?: {
			readonly code: string;
			readonly hint: string;
			readonly retryable?: boolean;
			readonly recoveryActions?: readonly string[];
		};
	}
	export interface ViewportRuntimeClientSnapshot {
		readonly status: "disconnected" | "ready";
		readonly runtime: ViewportRuntimeIdentity | null;
		readonly catalogRoots:
			| readonly { readonly root: string; readonly catalogPrefix: string }[]
			| null;
	}

	import type { AppExtension } from "@forgeax/app-shell/application";
	export function bindViewportRuntimeClient(...args: any[]): () => void;
	export function executeLiveGameplay(input: unknown): Promise<unknown>;
	export function forwardViewportRuntimeTransportRequest(
		request: TransportRequest,
	): Promise<TransportResponse>;
	export function getViewportRuntimeClientSnapshot(): ViewportRuntimeClientSnapshot;
	export function subscribePlayCarrierEvents(
		listener: (event: {
			readonly requestId?: string;
			readonly event: unknown;
		}) => void,
	): () => void;
	export function subscribeViewportRuntimeClient(
		listener: () => void,
	): () => void;
	export interface AssetsChangedEvent {
		readonly hint?: "directory-only" | "pack-changed";
		readonly source?: "local-op" | "disk-watch";
		readonly mutation?:
			| { kind: "renamed"; guid: string; name: string }
			| { kind: "deleted"; guid: string }
			| { kind: "changed"; guid: string };
	}
	export interface PanelBridge {
		on(
			event: "assetsChanged",
			listener: (event: AssetsChangedEvent) => void,
		): () => void;
	}
	export const panelBridge: PanelBridge;
	export const gateway: {
		readonly mode: string;
		readonly playPhase: string;
	};
	export function hasPendingDiskSave(): boolean;
	export function createEditorPanelContributionsExtension(): AppExtension;
	export function createEditorPageExtension(render: unknown): AppExtension;
	export function installInterfaceBridge(...args: any[]): () => void;
	export function resetEditRealm(options?: {
		nextRuntimeGeneration?: number;
		flushPendingSave?: boolean;
	}): void;
	export function setContextMenuRenderer(...args: any[]): () => void;
}

declare module "@forgeax/editor/default-dock-layout" {
	import type { SerializedDockview } from "@forgeax/app-shell/application";
	export const DEFAULT_EDITOR_DOCK_LAYOUT: SerializedDockview;
}

declare module "@forgeax/editor/keyboard-router-deps" {
	import type { AppExtension } from "@forgeax/app-shell/application";
	export interface RouterAsset {
		guid: string;
		name: string;
		packPath: string;
	}
	export interface KeyboardRouterDepsShape {
		dispatch: (
			op: { kind: string; [k: string]: unknown },
			origin?: string,
		) => void;
		getEntitySelection: () => number[];
		getAssetSelection: () => RouterAsset[];
		getLastSelectionDomain: () => "entity" | "asset" | "folder" | null;
		isPlayMode: () => boolean;
		getDisplay: () => "scene" | "game";
		getInputTarget: () => "editor" | "game";
		deleteEntities: (ids: number[]) => void;
		duplicateEntities: (ids: number[]) => void;
		hideEntities: (ids: number[]) => void;
		showAllHidden: () => void;
		hideUnselected: () => void;
		selectAllEntities: () => void;
		duplicateAsset: (guid: string, packPath: string) => void;
		undo: () => void;
		redo: () => void;
		save: () => void;
		restartPreview: () => void;
		handleViewportKeyDown: (event: KeyboardEvent) => void;
	}
	export function buildKeyboardRouterDeps(): KeyboardRouterDepsShape;
	export function createEditorKeyboardExtension(
		deps: KeyboardRouterDepsShape,
	): AppExtension;
}

declare module "@forgeax/editor/menu-contributions" {
	import type { AppExtension } from "@forgeax/app-shell/application";
	export function createEditorMenuExtension(): AppExtension;
}

declare module "@forgeax/editor/panels" {
	import type { AppExtension } from "@forgeax/app-shell/application";
	import type { ComponentType } from "react";
	export function createEditorPanelsExtension(options: {
		SceneEditor: ComponentType;
	}): AppExtension;
	export function renderEditorPanel(id: string): unknown;
}

declare module "@forgeax/editor/previews" {
	export function registerEditorPreviewViewports(): void;
}

declare module "@forgeax/editor/viewport" {
	import type { ComponentType } from "react";
	export const ViewportComponent: ComponentType<any>;
}

declare module "@forgeax/editor/viewport-runtime" {
	export interface ViewportRuntimeIdentity {
		readonly version: "viewport-runtime/v1";
		readonly runtimeId: string;
		readonly runtimeGeneration: number;
		readonly carrierId: string;
		readonly carrierKind: string;
	}
	export interface MessagePortTransportClient {
		dispose(): void;
	}
	export function createBroadcastViewportRuntimeClient(options: {
		runtime: ViewportRuntimeIdentity;
	}): MessagePortTransportClient;
	export function subscribeBroadcastViewportRuntimeReady(
		listener: (runtime: ViewportRuntimeIdentity) => void,
	): () => void;
}

declare module "@forgeax/editor/ui/overlays" {
	import type { ComponentType, PropsWithChildren } from "react";
	export const EditorOverlayProvider: ComponentType<PropsWithChildren>;
}

declare module "@forgeax/editor/vite-preset" {
	export function engineVitePreset(options: {
		base: string;
		gameDirAbs: string | null;
		preserveSymlinks: boolean;
	}): {
		plugins: unknown[];
		optimizeDeps: {
			exclude: string[];
			include: string[];
			holdUntilCrawlEnd: false;
		};
		resolve: { dedupe: string[]; preserveSymlinks: boolean };
		build: { target: "esnext" };
	};
}
