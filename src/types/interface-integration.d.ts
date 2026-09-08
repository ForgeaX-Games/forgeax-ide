declare module '@forgeax/interface/application' {
  import type { AppExtension, AppHost } from '@forgeax/app-shell/application';
  export interface AppHostBootstrapOverrides {
    readonly extensions?: readonly AppExtension[];
  }
  export interface InterfaceApplicationRuntime {
    readonly host: AppHost;
    readonly control: Record<string, unknown>;
    dispose(): void | Promise<void>;
  }
  export function startInterfaceApplication(
    overrides?: AppHostBootstrapOverrides,
  ): Promise<InterfaceApplicationRuntime>;
}

declare module '@forgeax/interface/ApplicationShell' {
  import type { AppHost } from '@forgeax/app-shell/application';
  import type { ComponentType } from 'react';
  export const ApplicationShell: ComponentType<{
    runtime: {
      readonly host: AppHost;
      readonly control: Record<string, unknown>;
      dispose(): void | Promise<void>;
    };
    onboarding?: { enabled?: boolean; tourEnabled?: boolean };
  }>;
}

declare module '@forgeax/interface/brand' {
  import type { ComponentType, PropsWithChildren } from 'react';
  export const BrandProvider: ComponentType<PropsWithChildren>;
}

declare module '@forgeax/interface/i18n' {
  export type Locale = 'zh' | 'en';
  export function getLocale(): Locale;
  export function initI18n(): void;
  export function setLocale(locale: Locale): void;
  export function subscribe(listener: () => void): () => void;
  export function t(key: string, values?: Record<string, unknown>): string;
  export function useTranslation(): {
    t: (key: string, values?: Record<string, unknown>) => string;
    i18n: { language: 'en' | 'zh'; changeLanguage(locale: 'en' | 'zh'): void };
  };
}

declare module '@forgeax/interface/lib/bus' {
  export interface BusTopics {}
  export function publish(topic: string, payload: any, options?: { retain?: boolean }): void;
  export function subscribe<T = unknown>(topic: string, listener: (payload: T) => void): () => void;
  export function peek<T = unknown>(topic: string): T | undefined;
}

declare module '@forgeax/interface/lib/lucide-icon' {
  import type { ComponentType } from 'react';
  export function lucideIconOrBox(name?: string): ComponentType<{ size?: number; strokeWidth?: number }>;
}

declare module '@forgeax/interface/lib/aegis' {
  export function reportError(
    error: Error,
    componentStack?: string | null,
    scope?: string,
  ): void;
}

declare module '@forgeax/interface/store' {
  export interface RuntimeScopeState {
    [key: string]: unknown;
  }

  export interface ActiveProjectSelection {
    activeSlug: string | null;
    runtime?: RuntimeScopeState;
  }

  export interface AgentCatalogClient {
    listAgents(options?: { lang?: 'zh' | 'en' }): Promise<{ agents: Array<Record<string, unknown>> }>;
  }
  export interface StudioProjectClient {
    getActiveProject(): Promise<ActiveProjectSelection>;
    setActiveProject(slug: string): Promise<ActiveProjectSelection>;
    subscribeActiveProject(listener: (selection: ActiveProjectSelection) => void): () => void;
    listProjects(): Promise<{ games: Array<{ slug: string; [key: string]: unknown }>; activeSlug: string | null }>;
    createProject(input: { slug: string; name: string; brief: string; template?: string }): Promise<{ ok: boolean; error?: string }>;
    linkProject(path: string): Promise<{ ok: boolean; error?: string; slug?: string }>;
    deleteProject(slug: string): Promise<void>;
  }
  export interface StudioBuildClient {
    buildProject(slug: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
    pollBuildJob(jobId: string): Promise<Record<string, unknown>>;
    getEngineRoots(): Promise<{ roots: Array<Record<string, unknown>> }>;
    cleanBuilds(): Promise<Record<string, unknown>>;
    listBuildHistory(): Promise<{ records: Array<Record<string, unknown>> }>;
    deleteBuildHistory(id: string, options?: { clean?: boolean }): Promise<void>;
  }
  export interface StudioDomainClients {
    agents: AgentCatalogClient;
    projects: StudioProjectClient;
    builds: StudioBuildClient;
  }
  export type SessionClient = Record<string, unknown>;
  export function configureStudioDomainClients(clients: StudioDomainClients): void;
  export function configureSessionClient(client: SessionClient): void;
  export interface ShellStoreState {
    readonly activeOverlay: string | null;
    readonly overlayParam: string | null;
    readonly providerOverride: string | null;
    readonly activeSid: string | null;
    readonly activeGameSlug: string | null;
    readonly activeGameRuntime: RuntimeScopeState;
    readonly activeGameResolved: boolean;
    closeOverlay(): void;
    setOverlayParam(id: string): void;
    openOverlay(overlay: string, section?: string): void;
    switchToSession(sid: string): Promise<unknown> | void;
    initActiveGame(): Promise<unknown>;
    initSessions(): Promise<unknown> | void;
    pushTelemetry(records: unknown[]): void;
  }
  export const useShellStore: {
    <T>(selector: (state: ShellStoreState) => T): T;
    getState(): ShellStoreState;
    setState: (...args: any[]) => any;
    subscribe: (...args: any[]) => any;
  };
}

declare module '@forgeax/ide-integration/interface-store-source' {
  export * from '@forgeax/interface/store';
}

declare module '@forgeax/interface/styles/global.css';

declare module '@forgeax/interface/lib/global-shortcuts' {
  export type KeyboardRouterDeps = unknown;
  export function buildShortcuts(): any[];
  export function registerKeyboardRouterDeps(deps: KeyboardRouterDeps): void;
}

declare module '@forgeax/interface/lib/model-route' {
  export function applyModelRoute(source: any): Promise<void>;
  export function currentCatalogProvider(providerOverride: string | null): string | null;
  export function deriveActiveSource(
    providerOverride: string | null,
    forgeaxModel: string | null,
  ): string | null;
  export function resetOpenSessionsModelToProviderDefault(
    providerId: string | null,
  ): Promise<{ selected: string; count: number } | null>;
}

declare module '@forgeax/interface/components/ModelPicker/useModelCatalog' {
  import type { ModelCatalogEntry } from '@forgeax/chat/runtime';

  export interface ModelCatalogState {
    models: ModelCatalogEntry[] | null;
    driver: {
      id: string;
      source: string;
      error?: string;
      ids: number;
      cached?: boolean;
    } | null;
    error: string | null;
    refresh(): Promise<void>;
  }

  export function useModelCatalog(providerId?: string | null): ModelCatalogState;
  export function refreshAllModelCatalogs(): Promise<void>;
}

declare module '@forgeax/interface/lib/ui-bridge' {
  export function bootUiBridge(): void;
}

declare module '@forgeax/interface/components/Onboarding/types' {
  export const loadOnboarding: (...args: any[]) => any;
  export const saveOnboarding: (...args: any[]) => any;
}

declare module '@forgeax/interface/lib/broadcast-stream' {
  export const subscribeBroadcast: (...args: any[]) => any;
}

declare module '@forgeax/interface/lib/bus' {
  export const clearRetained: (...args: any[]) => any;
  export const publish: (...args: any[]) => any;
}

declare module '@forgeax/interface/lib/composer-bridge' {
  export const clearComposerPendingInsert: (...args: any[]) => any;
  export const requestComposerInsert: (...args: any[]) => any;
  export const useComposerPendingInsert: (...args: any[]) => any;
}

declare module '@forgeax/interface/lib/dialog' {
  export const alertDialog: (...args: any[]) => any;
}

declare module '@forgeax/interface/lib/model-route' {
  export const initialSessionCatalogModel: (...args: any[]) => any;
  export const preferredCatalogModel: (...args: any[]) => any;
}

declare module '@forgeax/interface/lib/dialog' {
  export function confirmDialog(options: { body: string; danger?: boolean }): Promise<boolean>;
  export function alertDialog(options: { body: string }): Promise<void>;
}

declare module '@forgeax/interface/i18n' {
  export type TFunction = (key: string, vars?: Record<string, string | number>) => string;
  export function useTranslation(): {
    t: TFunction;
    i18n: { language: 'en' | 'zh'; changeLanguage(locale: 'en' | 'zh'): void };
  };
}

declare module '@forgeax/chat' {
  import type { ComponentType } from 'react';
  export const ChatPanel: ComponentType;
}

declare module '@forgeax/chat/session-store' {
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

declare module '@forgeax/dashboard' {
  import type { ComponentType } from 'react';
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

declare module '@forgeax/extension-gallery' {
  import type { AppExtension } from '@forgeax/app-shell/application';
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
      readonly pages?: readonly { readonly id?: string; readonly icon?: string }[];
      readonly activities?: readonly { readonly icon?: string }[];
    };
  }
  export interface ExtensionGalleryRuntime {
    useTranslation(): {
      readonly t: (key: string) => string;
      readonly locale: string;
    };
    listExtensions(): Promise<{ readonly items: readonly ExtensionGalleryInfo[] }>;
  }
  export function createExtensionGalleryContribution(runtime: ExtensionGalleryRuntime): AppExtension;
}

declare module '@forgeax/files' {
  import type { AppExtension } from '@forgeax/app-shell/application';
  export type PreviewKind = 'text' | 'image' | 'audio' | 'video' | 'model' | 'binary';
  export type ReadFileResult =
    | { ok: true; kind: PreviewKind; mime: string; size: number; content?: string }
    | { ok: false; status: number; statusText: string; error?: string };
  export interface FilesClient {
    readFile(path: string): Promise<ReadFileResult>;
    saveFile(path: string, content: string): Promise<{ ok: boolean; bytes?: number; error?: string }>;
    rawUrl(path: string): string;
  }
  export interface FilesRuntime {
    readonly client: FilesClient;
    peek(topic: string): unknown;
    publish(topic: string, payload: unknown, options?: { retain?: boolean }): void;
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

declare module '@forgeax/settings' {
  import type { ComponentType, ReactNode } from 'react';
  export interface SettingsRuntime {
    t(key: string, values?: Record<string, string | number>): string;
    locale: 'en' | 'zh';
    changeLanguage(locale: 'en' | 'zh'): void;
    providerOverride: string | null;
    buildShortcuts(): Array<{
      combo: string;
      label: string;
      group: 'layout' | 'mode' | 'overlay' | 'focus' | 'general' | 'edit';
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
        kind: 'skill' | 'command' | 'mcp' | 'extension' | 'memory' | 'tool';
        extensionId: string;
        extensionVersion: string;
        origin: 'builtin' | 'user' | 'project';
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
      source: { kind: 'api-key'; model: string } | { kind: 'cli'; providerId: string },
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
    publish(topic: string, payload: unknown, options?: { retain?: boolean }): void;
    peek(topic: string): unknown;
    subscribe(topic: string, listener: (payload: unknown) => void): () => void;
  }): void;
}

declare module '@forgeax/editor/bridge' {
  import type { AppExtension } from '@forgeax/app-shell/application';
  export function bindViewportRuntimeClient(...args: any[]): () => void;
  export function createEditorPanelContributionsExtension(): AppExtension;
  export function createEditorPageExtension(render: unknown): AppExtension;
  export function installInterfaceBridge(...args: any[]): () => void;
  export function resetEditRealm(options?: { nextRuntimeGeneration?: number }): void;
  export function setContextMenuRenderer(...args: any[]): () => void;
}

declare module '@forgeax/editor/default-dock-layout' {
  import type { SerializedDockview } from '@forgeax/app-shell/application';
  export const DEFAULT_EDITOR_DOCK_LAYOUT: SerializedDockview;
}

declare module '@forgeax/editor/keyboard-router-deps' {
  export function buildKeyboardRouterDeps(): unknown;
}

declare module '@forgeax/editor/panels' {
  import type { ComponentType } from 'react';
  import type { AppExtension } from '@forgeax/app-shell/application';
  export function createEditorPanelsExtension(options: { SceneEditor: ComponentType }): AppExtension;
  export function renderEditorPanel(id: string): unknown;
}

declare module '@forgeax/editor/previews' {
  export function registerEditorPreviewViewports(): void;
}

declare module '@forgeax/editor/viewport' {
  import type { ComponentType } from 'react';
  export const ViewportComponent: ComponentType<any>;
}

declare module '@forgeax/editor/viewport-runtime' {
  export interface ViewportRuntimeIdentity {
    readonly runtimeId: string;
    readonly runtimeGeneration: string | number;
    readonly carrierId: string;
    readonly carrierKind: string;
  }
  export interface MessagePortTransportClient {
    dispose(): void;
  }
  export function createBroadcastViewportRuntimeClient(options: { runtime: ViewportRuntimeIdentity }): MessagePortTransportClient;
  export function subscribeBroadcastViewportRuntimeReady(listener: (runtime: ViewportRuntimeIdentity) => void): () => void;
}

declare module '@forgeax/editor/ui/overlays' {
  import type { ComponentType, PropsWithChildren } from 'react';
  export const EditorOverlayProvider: ComponentType<PropsWithChildren>;
}

declare module '@forgeax/editor/vite-preset' {
  export function engineVitePreset(options: {
    base: string;
    gameDirAbs: string | null;
    preserveSymlinks: boolean;
  }): {
    plugins: unknown[];
    optimizeDeps: { exclude: string[]; include: string[]; holdUntilCrawlEnd: false };
    resolve: { dedupe: string[]; preserveSymlinks: boolean };
    build: { target: 'esnext' };
  };
}
