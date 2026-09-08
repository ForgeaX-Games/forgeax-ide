import { createRoot, type Root } from 'react-dom/client';
import { useEffect, useMemo, useRef, useState, type ComponentProps, type ComponentType, type ReactNode } from 'react';
import { ChatPanel } from '@forgeax/chat';
import { subscribePermissionStream } from '@forgeax/chat/runtime';
import {
  connectForgeaXWs,
  createSession,
  deleteSession,
  disconnectForgeaXWs,
  emitForgeaXMessage,
  ensureSession,
  fetchSessionList,
  listSessionAgents,
  onSessionEvent,
  subscribeDaemonTick,
  subscribeSessionStream,
} from '@forgeax/chat/session-store';
import { Dashboard, type DashboardRuntime } from '@forgeax/dashboard';
import {
  createExtensionGalleryContribution,
  type ExtensionGalleryRuntime,
} from '@forgeax/extension-gallery';
import {
  configureFilesRuntime,
  createFilesContribution,
  initFiles,
  type FilesRuntime,
} from '@forgeax/files';
import {
  AgentsMainArea,
  AgentsPanel,
  PageAgentPicker,
} from '@forgeax/agents/react';
import '@forgeax/agents/style.css';
import {
  initAgentPrefs,
  SettingsPanel,
  SettingsRuntimeProvider,
  SettingsSectionsRegister,
  type SettingsRuntime,
} from '@forgeax/settings';
import { createExtensionPort, createWindowTransport } from '@forgeax/extension-platform/transport';
import {
  bindViewportRuntimeClient,
  createEditorPanelContributionsExtension,
  createEditorPageExtension,
  installInterfaceBridge,
  resetEditRealm,
  setContextMenuRenderer,
} from '@forgeax/editor/bridge';
import {
  createBroadcastViewportRuntimeClient,
  subscribeBroadcastViewportRuntimeReady,
} from '@forgeax/editor/viewport-runtime';
import type {
  MessagePortTransportClient,
  ViewportRuntimeIdentity,
} from '@forgeax/editor/viewport-runtime';
import { DEFAULT_EDITOR_DOCK_LAYOUT } from '@forgeax/editor/default-dock-layout';
import { buildKeyboardRouterDeps } from '@forgeax/editor/keyboard-router-deps';
import { createEditorPanelsExtension, renderEditorPanel } from '@forgeax/editor/panels';
import { registerEditorPreviewViewports } from '@forgeax/editor/previews';
import { ViewportComponent } from '@forgeax/editor/viewport';
import { EditorOverlayProvider } from '@forgeax/editor/ui/overlays';
import { openResource } from '@forgeax/app-shell/application';
import type { AppExtension, PanelRenderers } from '@forgeax/app-shell/application';
import type { AppHostBootstrapOverrides } from '@forgeax/interface/application';
import {
  buildShortcuts,
  registerKeyboardRouterDeps,
  type KeyboardRouterDeps,
} from '@forgeax/interface/lib/global-shortcuts';
import { useTranslation } from '@forgeax/interface/i18n';
import { clearRetained, publish, peek, subscribe } from '@forgeax/interface/lib/bus';
import {
  applyModelRoute,
  currentCatalogProvider,
  deriveActiveSource,
  resetOpenSessionsModelToProviderDefault,
} from '@forgeax/interface/lib/model-route';
import { refreshAllModelCatalogs } from '@forgeax/interface/components/ModelPicker/useModelCatalog';
import { bootUiBridge } from '@forgeax/interface/lib/ui-bridge';
import { alertDialog, confirmDialog } from '@forgeax/interface/lib/dialog';
import {
  configureSessionClient,
  useShellStore,
} from '@forgeax/interface/store';
import { restExtensionCatalogClient } from '../integration/rest-extension-catalog-client';
import { fetchCliProviders } from '../integration/rest-cli-provider-client';
import { createRestFilesClient } from '../integration/rest-files-client';
import { createUseBusSnapshot } from '../integration/react-bus-snapshot';
import { createRetainedDeepLinkBridge } from '../integration/retained-deep-link-bridge';
import {
  subscribeNarrativeCopilot,
  subscribePerceptionStream,
} from '../integration/product-session-streams';
import { configureIdeChatRuntime } from './chat-runtime-adapter';

const { clearDeepLink, emitDeepLink } = createRetainedDeepLinkBridge({ publish, clearRetained });
const useBusSnapshot = createUseBusSnapshot({ peek, subscribe });

registerEditorPreviewViewports();

const extensionGalleryRuntime: ExtensionGalleryRuntime = {
  useTranslation() {
    const { t, i18n } = useTranslation();
    return { t, locale: i18n.language };
  },
  listExtensions: restExtensionCatalogClient.listExtensions,
};

const filesRuntime: FilesRuntime = {
  client: createRestFilesClient(),
  peek,
  publish,
  subscribe,
  useBusSnapshot,
  openResource,
};

type ViewportProps = ComponentProps<typeof ViewportComponent>;
type RuntimeBinding = NonNullable<ViewportProps['runtimeBinding']>;

function isRuntimeBinding(value: unknown): value is RuntimeBinding {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<Record<keyof RuntimeBinding, unknown>>;
  return typeof candidate.scopeId === 'string'
    && candidate.scopeId.trim().length > 0
    && typeof candidate.generation === 'number'
    && Number.isSafeInteger(candidate.generation)
    && typeof candidate.catalogUrl === 'string'
    && candidate.catalogUrl.trim().length > 0
    && typeof candidate.importUrlBase === 'string'
    && candidate.importUrlBase.trim().length > 0
    && typeof candidate.packageUrlBase === 'string'
    && candidate.packageUrlBase.trim().length > 0;
}

function runtimeBindingKey(binding: RuntimeBinding | undefined): string {
  return binding === undefined
    ? 'unbound'
    : `${binding.scopeId}:${binding.generation}:${binding.catalogUrl}:${binding.importUrlBase}:${binding.packageUrlBase}`;
}

function hasCatalogRoots(binding: RuntimeBinding | undefined): boolean {
  if (binding === undefined) return false;
  const roots = (binding as { catalogRoots?: unknown }).catalogRoots;
  return Array.isArray(roots) && roots.length > 0;
}

function SettingsInjection(): ReactNode {
  const { t, i18n } = useTranslation();
  const open = useShellStore((state) => state.activeOverlay === 'settings');
  const activeId = useShellStore((state) => state.overlayParam);
  const providerOverride = useShellStore((state) => state.providerOverride);
  const closeOverlay = useShellStore((state) => state.closeOverlay);
  const setOverlayParam = useShellStore((state) => state.setOverlayParam);
  const runtime = useMemo<SettingsRuntime>(() => ({
    t,
    locale: i18n.language,
    changeLanguage: i18n.changeLanguage,
    providerOverride,
    buildShortcuts,
    fetchCliProviders,
    listSharedCapabilities: restExtensionCatalogClient.listSharedCapabilities,
    refreshAllModelCatalogs,
    deriveActiveSource,
    currentCatalogProvider,
    resetOpenSessionsModelToProviderDefault,
    applyModelRoute,
  }), [i18n.language, providerOverride, t]);

  return (
    <SettingsRuntimeProvider runtime={runtime}>
      <SettingsSectionsRegister
        activeId={activeId}
        onActiveIdChange={setOverlayParam}
      />
      <SettingsPanel
        open={open}
        activeId={activeId}
        onClose={closeOverlay}
        onActiveIdChange={setOverlayParam}
      />
    </SettingsRuntimeProvider>
  );
}

function AgentsBrowserView(): ReactNode {
  return <AgentsMainArea />;
}

function DashboardInjection() {
  const { t } = useTranslation();
  const open = useShellStore((state) => state.activeOverlay === 'dashboard');
  const activeSessionId = useShellStore((state) => state.activeSid);
  const closeOverlay = useShellStore((state) => state.closeOverlay);
  const openOverlay = useShellStore((state) => state.openOverlay);
  const switchToSession = useShellStore((state) => state.switchToSession);
  const runtime = useMemo<DashboardRuntime>(() => ({
    open,
    activeSessionId,
    translate: t,
    close: closeOverlay,
    openSession: (sid) => {
      void switchToSession(sid);
      closeOverlay();
    },
    openBus: (options) => {
      if (options?.kind) emitDeepLink('bus:filter-kind', options.kind);
      else clearDeepLink('bus:filter-kind');
      if (options?.extensionId) emitDeepLink('bus:expand-plugin', options.extensionId);
      else clearDeepLink('bus:expand-plugin');
      openOverlay('settings', 'plugins');
    },
    confirm: ({ body, danger }) => confirmDialog({ body, danger }),
    alert: ({ body }) => alertDialog({ body }),
  }), [activeSessionId, closeOverlay, open, openOverlay, switchToSession, t]);

  return <Dashboard runtime={runtime} />;
}

function StudioSceneEditor(): ReactNode {
  const activeGameSlug = useShellStore((state) => state.activeGameSlug);
  const activeGameRuntime = useShellStore((state) => state.activeGameRuntime);
  const activeGameResolved = useShellStore((state) => state.activeGameResolved);
  const mountedRef = useRef(false);
  const [viewportEpoch, setViewportEpoch] = useState(0);
  const runtimeBinding = isRuntimeBinding(activeGameRuntime?.binding)
    ? activeGameRuntime.binding
    : undefined;
  const bindingKey = runtimeBindingKey(runtimeBinding);
  const viewportKey = `${activeGameSlug ?? 'default'}:${bindingKey}`;

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    resetEditRealm({ nextRuntimeGeneration: runtimeBinding?.generation });
    setViewportEpoch((epoch) => epoch + 1);
  }, [viewportKey, runtimeBinding?.generation]);

  if (!activeGameResolved || activeGameSlug === null || runtimeBinding === undefined) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: '#8f94a3', background: '#16161a' }}>
        Preparing editor viewport…
      </div>
    );
  }

  if (!hasCatalogRoots(runtimeBinding)) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: '#8f94a3', background: '#16161a', textAlign: 'center', padding: 24 }}>
        <div>
          <div style={{ color: '#f4f4f5', fontWeight: 700, marginBottom: 8 }}>No scene assets are available for this game.</div>
          <div>Switch to a game with an authored scene, or create/import scene assets for {activeGameSlug}.</div>
        </div>
      </div>
    );
  }

  return (
    <ViewportComponent
      key={viewportEpoch}
      gameSlug={activeGameSlug}
      gameRoot={`.forgeax/games/${activeGameSlug}`}
      runtimeBinding={runtimeBinding}
    />
  );
}

function ViewportRuntimeWindowBridge(): null {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('runtimeId') && params.has('runtimeGeneration')) return undefined;

    let currentKey: string | null = null;
    let client: MessagePortTransportClient | null = null;
    let unbind: (() => void) | null = null;
    const disconnect = (): void => {
      unbind?.();
      unbind = null;
      client?.dispose();
      client = null;
      currentKey = null;
    };
    const connect = (runtime: ViewportRuntimeIdentity): void => {
      if (runtime.carrierKind !== 'browser-page' && runtime.carrierKind !== 'tauri-webview') return;
      const key = `${runtime.runtimeId}:${runtime.runtimeGeneration}:${runtime.carrierId}`;
      if (key === currentKey) return;
      disconnect();
      client = createBroadcastViewportRuntimeClient({ runtime });
      unbind = bindViewportRuntimeClient(runtime, client);
      currentKey = key;
    };
    const unsubscribe = subscribeBroadcastViewportRuntimeReady(connect);
    return () => {
      unsubscribe();
      disconnect();
    };
  }, []);
  return null;
}

const productPanelsExtension: AppExtension = {
  id: 'forgeax-ide.product-panels',
  version: '1.0.0',
  contributes: {
    panels: {
      panels: {
        chat: {
          title: 'ForgeaX CLI',
          order: 10,
          header: { visible: true },
          content: { padding: 'none', scroll: 'none', tone: 'default' },
          dockChrome: { singleTab: 'hideTitle' },
          render: () => <ChatPanel />,
        },
        agents: {
          title: 'Agents',
          order: 20,
          header: { visible: true },
          content: { padding: 'none', scroll: 'none', tone: 'default' },
          render: () => <AgentsPanel />,
        },
      },
      overlays: {
        Dashboard: DashboardInjection,
        Settings: SettingsInjection as ComponentType,
      },
      detached: {
        AgentsBrowser: AgentsBrowserView as ComponentType,
      },
      slots: {
        SidebarAgents: AgentsPanel,
        CornerAgentPicker: PageAgentPicker,
      },
    },
  },
};

const editorIntegrationExtension: AppExtension = {
  id: 'forgeax-ide.editor-integration',
  version: '1.0.0',
  requires: ['panels'],
  setup(ctx) {
    const overlayEl = document.createElement('div');
    overlayEl.id = 'editor-overlay-root';
    document.body.appendChild(overlayEl);
    const overlayRoot: Root = createRoot(overlayEl);
    overlayRoot.render(
      <EditorOverlayProvider>
        <ViewportRuntimeWindowBridge />
      </EditorOverlayProvider>,
    );

    const cleanupPanels = ctx.contributePanels({
      builtinPageLayouts: { scene: DEFAULT_EDITOR_DOCK_LAYOUT },
      editor: {
        setContextMenuRenderer,
        installBridge: installInterfaceBridge,
      },
      extensionTransport: {
        createExtensionPort,
        createWindowTransport,
      },
    } satisfies Partial<PanelRenderers>);

    return () => {
      cleanupPanels();
      overlayRoot.unmount();
      overlayEl.remove();
    };
  },
};

export const IDE_PRODUCT_OVERRIDES: AppHostBootstrapOverrides = {
  extensions: [
    createEditorPanelsExtension({ SceneEditor: StudioSceneEditor }),
    createEditorPanelContributionsExtension(),
    createEditorPageExtension(renderEditorPanel),
    createExtensionGalleryContribution(extensionGalleryRuntime),
    createFilesContribution(),
    productPanelsExtension,
    editorIntegrationExtension,
  ],
};

let booted = false;

export async function bootIdeProductComposition(): Promise<void> {
  if (booted) return;
  booted = true;

  configureIdeChatRuntime();
  configureSessionClient({
    fetchSessionList,
    createSession,
    ensureSession,
    deleteSession,
    emitForgeaXMessage,
    listSessionAgents,
    connectForgeaXWs,
    disconnectForgeaXWs,
    onSessionEvent,
  });
  registerKeyboardRouterDeps(buildKeyboardRouterDeps() as KeyboardRouterDeps);

  initAgentPrefs({ publish, peek, subscribe });
  configureFilesRuntime(filesRuntime);
  initFiles();
  subscribeDaemonTick();
  subscribeSessionStream();
  subscribeNarrativeCopilot();
  subscribePermissionStream();
  subscribePerceptionStream();
  bootUiBridge();
  await useShellStore.getState().initActiveGame().catch(() => undefined);
  void useShellStore.getState().initSessions();
}
