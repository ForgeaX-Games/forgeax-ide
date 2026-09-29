import {
	AgentsMainArea,
	AgentsPanel,
	PageAgentPicker,
} from "@forgeax/agents/react";
import {
	type AppBusEventMap,
	type AppExtensionContext,
	type AppExtensionContributes,
	createApplicationExtensionLoader,
	createApplicationHost,
	DEFAULT_PANEL_RENDERERS,
	type PanelActionContribution,
} from "@forgeax/app-shell/application";
import { ChatPanel } from "@forgeax/chat";
import {
	getLastModel,
	type PillPayload,
	subscribePermissionStream,
} from "@forgeax/chat/runtime";
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
} from "@forgeax/chat/session-store";
import { Dashboard, type DashboardRuntime } from "@forgeax/dashboard";
import {
	createExtensionGalleryContribution,
	type ExtensionGalleryRuntime,
} from "@forgeax/extension-gallery";
import {
	configureFilesRuntime,
	createFilesContribution,
	type FilesRuntime,
	initFiles,
} from "@forgeax/files";
import {
	APPLICATION_CHAT_DEFAULT_WIDTH,
	ApplicationContextMenu,
	ApplicationDockRegion,
	ApplicationExtensionHostPanel,
	ApplicationOnboarding,
	ApplicationPassiveFeedbackHost,
	ApplicationSurfaceKeepAliveLayer,
	ApplicationTopBar,
	ApplicationViewportPanel,
	applicationChatWidthStore,
	applicationFeedbackStore,
	applicationSurfaceOverlayStatusItem,
	bootApplicationUiActionBridge,
	openApplicationOnboarding,
} from "@forgeax/interface/application";
import {
	type ComponentProps,
	type ComponentType,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { IdeActivityRail } from "./activity-rail";
import type { IdeApplicationShellViews } from "./application-shell";
import { ideBuildVersionStatusItem } from "./build-version-status";
import { createIdeBuiltinCommandsExtension } from "./builtin-commands";
import {
	chromeDrawerExtension,
	foundationBusExtension,
	foundationCommandsExtension,
	foundationStorageExtension,
	hostCommandsExtension,
	observabilityExtension,
	panelsChatExtension,
	sessionClientExtension,
	studioDomainClientsExtension,
} from "./builtin-extensions";
import { createIdeBuiltinMenusExtension } from "./builtin-menus";
import {
	createIdeStatusBarExtension,
	createIdeViewportExtension,
} from "./builtin-ui-extensions";
import { createCatalogPageExtensionRuntime } from "./catalog-page-extensions";
import { IdeCommandPalette } from "./command-palette";
import { IdeConnectModelPrompt } from "./connect-model-prompt";
import { ideDiagnosticsStatusItem } from "./diagnostics-status";
import { IdeDialogHost } from "./dialog-host";
import { IdeDrawerHost } from "./drawer-host";
import {
	IdeExtensionHostPanel,
	type IdeExtensionHostPanelProps,
} from "./embedded-extension-host";
import { IdeGameModalHost } from "./game-modal";
import { ideHostLogger } from "./host-logger";
import { IdePageTabStrip } from "./page-tab-strip";
import { IdeProjectDirectoryModalHost } from "./project-directory-modal";
import { ideRecentProjectsRuntime } from "./recent-projects-runtime";
import { idePulseStatusItems } from "./status-pulse";
import { executeFocusedTextEditAction } from "./text-edit-actions";
import { trajectoryExtension } from "./trajectory-extension";
import "@forgeax/agents/style.css";
import type {
	AppExtension,
	PanelRenderers,
} from "@forgeax/app-shell/application";
import {
	alertDialog,
	clearRetainedTopic as clearRetained,
	confirmDialog,
	openResource,
	peekTopic as peek,
	publishTopic as publish,
	subscribeTopic as subscribe,
	useHost,
} from "@forgeax/app-shell/application";
import {
	bindViewportRuntimeClient,
	createEditorPageExtension,
	createEditorPanelContributionsExtension,
	gateway,
	hasPendingDiskSave,
	installInterfaceBridge,
	panelBridge,
	resetEditRealm,
	setContextMenuRenderer,
} from "@forgeax/editor/bridge";
import { DEFAULT_EDITOR_DOCK_LAYOUT } from "@forgeax/editor/default-dock-layout";
import {
	buildKeyboardRouterDeps,
	createEditorKeyboardExtension,
} from "@forgeax/editor/keyboard-router-deps";
import { createEditorMenuExtension } from "@forgeax/editor/menu-contributions";
import {
	createEditorPanelsExtension,
	renderEditorPanel,
} from "@forgeax/editor/panels";
import { registerEditorPreviewViewports } from "@forgeax/editor/previews";
import { EditorOverlayProvider } from "@forgeax/editor/ui/overlays";
import { ViewportComponent } from "@forgeax/editor/viewport";
import type {
	MessagePortTransportClient,
	ViewportRuntimeIdentity,
} from "@forgeax/editor/viewport-runtime";
import {
	createBroadcastViewportRuntimeClient,
	subscribeBroadcastViewportRuntimeReady,
} from "@forgeax/editor/viewport-runtime";
import {
	createExtensionPort,
	createWindowTransport,
} from "@forgeax/extension-platform/transport";
import {
	initAgentPrefs,
	SettingsPanel,
	type SettingsRuntime,
	SettingsRuntimeProvider,
	SettingsSectionsRegister,
} from "@forgeax/settings";
import {
	createModelRouteService,
	currentCatalogProvider,
	deriveActiveSource,
} from "../integration/model-route";
import {
	subscribeNarrativeCopilot,
	subscribePerceptionStream,
} from "../integration/product-session-streams";
import { buildIdeShortcutDescriptions } from "../integration/product-shortcuts";
import { createUseBusSnapshot } from "../integration/react-bus-snapshot";
import { fetchCliProviders } from "../integration/rest-cli-provider-client";
import { restExtensionCatalogClient } from "../integration/rest-extension-catalog-client";
import { createRestFilesClient } from "../integration/rest-files-client";
import {
	listModels,
	setAgentModels,
} from "../integration/rest-model-config-client";
import { createRetainedDeepLinkBridge } from "../integration/retained-deep-link-bridge";
import { toSettingsShortcutDescriptions } from "../integration/settings-shortcut-descriptions";
import { refreshAllModelCatalogs } from "../integration/use-model-catalog";
import { configureIdeChatRuntime } from "./chat-runtime-adapter";
import { createIdePageServices } from "./page-services";
import { configureSessionClient } from "./product-clients";
import { useTranslation } from "./product-locale";
import { useShellStore } from "./shell-state-runtime";

const { clearDeepLink, emitDeepLink } = createRetainedDeepLinkBridge({
	publish,
	clearRetained,
});
const useBusSnapshot = createUseBusSnapshot({ peek, subscribe });
const { applyModelRoute, resetOpenSessionsModelToProviderDefault } =
	createModelRouteService({
		getLastModel,
		getState: () => {
			const { tabs, setProviderOverride } = useShellStore.getState();
			return { tabs, setProviderOverride };
		},
		listModels,
		setAgentModels,
	});

function IdeCatalogExtensionHostPanel({
	extensionId,
	pane,
	manifest,
}: Omit<IdeExtensionHostPanelProps, "LegacyPanel">) {
	return (
		<IdeExtensionHostPanel
			extensionId={extensionId}
			pane={pane}
			manifest={manifest}
			LegacyPanel={ApplicationExtensionHostPanel}
		/>
	);
}

export const IDE_SHELL_VIEWS: IdeApplicationShellViews = {
	ActivityRail: IdeActivityRail,
	CommandPalette: IdeCommandPalette,
	ConnectModelPrompt: IdeConnectModelPrompt,
	ContextMenu: ApplicationContextMenu,
	DialogHost: IdeDialogHost,
	DockRegion: ApplicationDockRegion,
	Onboarding: ApplicationOnboarding,
	DrawerHostView: IdeDrawerHost,
	GameDirectoryModalHost: IdeProjectDirectoryModalHost,
	GameModalHost: IdeGameModalHost,
	PageTabStrip: IdePageTabStrip,
	PassiveFeedbackHost: ApplicationPassiveFeedbackHost,
	SurfaceKeepAliveLayer: ApplicationSurfaceKeepAliveLayer,
	TopBar: ApplicationTopBar,
};

const builtinMenusExtension = createIdeBuiltinMenusExtension(
	ideRecentProjectsRuntime.read,
);
const builtinCommandsExtension = createIdeBuiltinCommandsExtension({
	executeFocusedTextEditAction,
	resetChatWidth: () =>
		applicationChatWidthStore.setSize(APPLICATION_CHAT_DEFAULT_WIDTH),
	openFeedback: () => applicationFeedbackStore.getState().openPanel("write"),
	openOnboarding: openApplicationOnboarding,
});
const panelsViewportExtension = createIdeViewportExtension(
	ApplicationViewportPanel,
);
const chromeStatusBarExtension = createIdeStatusBarExtension([
	ideBuildVersionStatusItem,
	ideDiagnosticsStatusItem,
	applicationSurfaceOverlayStatusItem,
	...idePulseStatusItems,
]);

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

type ViewportProps = NonNullable<ComponentProps<typeof ViewportComponent>>;
type RuntimeBinding = NonNullable<ViewportProps["runtimeBinding"]>;

function hasCatalogRoots(binding: RuntimeBinding | undefined): boolean {
	if (binding === undefined) return false;
	const roots = (binding as { catalogRoots?: unknown }).catalogRoots;
	return Array.isArray(roots) && roots.length > 0;
}

import { EditorServerTransport } from "../integration/editor-server-transport";
import {
	type CommittedViewportSelection,
	resolveCommittedViewportSelection,
} from "./studio-viewport-selection";

function SettingsInjection(): ReactNode {
	const host = useHost();
	const { t, i18n } = useTranslation();
	const open = useShellStore((state) => state.activeOverlay === "settings");
	const activeId = useShellStore((state) => state.overlayParam);
	const providerOverride = useShellStore((state) => state.providerOverride);
	const closeOverlay = useShellStore((state) => state.closeOverlay);
	const setOverlayParam = useShellStore((state) => state.setOverlayParam);
	const runtime = useMemo<SettingsRuntime>(
		() => ({
			t,
			locale: i18n.language,
			changeLanguage: i18n.changeLanguage,
			providerOverride,
			buildShortcuts: () =>
				toSettingsShortcutDescriptions(buildIdeShortcutDescriptions(host)),
			fetchCliProviders,
			listSharedCapabilities: restExtensionCatalogClient.listSharedCapabilities,
			refreshAllModelCatalogs,
			deriveActiveSource,
			currentCatalogProvider,
			resetOpenSessionsModelToProviderDefault,
			applyModelRoute,
		}),
		[host, i18n.changeLanguage, i18n.language, providerOverride, t],
	);

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
	const open = useShellStore((state) => state.activeOverlay === "dashboard");
	const activeSessionId = useShellStore((state) => state.activeSid);
	const closeOverlay = useShellStore((state) => state.closeOverlay);
	const openOverlay = useShellStore((state) => state.openOverlay);
	const switchToSession = useShellStore((state) => state.switchToSession);
	const runtime = useMemo<DashboardRuntime>(
		() => ({
			open,
			activeSessionId,
			translate: t,
			close: closeOverlay,
			openSession: (sid) => {
				void switchToSession(sid);
				closeOverlay();
			},
			openBus: (options) => {
				if (options?.kind) emitDeepLink("bus:filter-kind", options.kind);
				else clearDeepLink("bus:filter-kind");
				if (options?.extensionId)
					emitDeepLink("bus:expand-plugin", options.extensionId);
				else clearDeepLink("bus:expand-plugin");
				openOverlay("settings", "plugins");
			},
			confirm: ({ body, danger }) => confirmDialog({ body, danger }),
			alert: ({ body }) => alertDialog({ body }),
		}),
		[activeSessionId, closeOverlay, open, openOverlay, switchToSession, t],
	);

	return <Dashboard runtime={runtime} />;
}

function StudioSceneEditor(): ReactNode {
	const activeGameSlug = useShellStore((state) => state.activeGameSlug);
	const activeGameRuntime = useShellStore((state) => state.activeGameRuntime);
	const activeGameResolved = useShellStore((state) => state.activeGameResolved);
	const [viewportEpoch, setViewportEpoch] = useState(0);
	const assetRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const nextSelection = useMemo(
		() =>
			activeGameResolved
				? resolveCommittedViewportSelection(activeGameSlug, activeGameRuntime)
				: undefined,
		[activeGameResolved, activeGameSlug, activeGameRuntime],
	);
	const committedRef = useRef<CommittedViewportSelection | undefined>(
		nextSelection,
	);
	const [committed, setCommitted] = useState<
		CommittedViewportSelection | undefined
	>(nextSelection);

	useEffect(() => {
		if (!activeGameResolved) return;
		if (activeGameSlug === null) {
			if (committedRef.current === undefined) return;
			resetEditRealm();
			committedRef.current = undefined;
			setCommitted(undefined);
			setViewportEpoch((epoch) => epoch + 1);
			return;
		}
		if (nextSelection === undefined) return;
		if (committedRef.current?.key === nextSelection.key) {
			if (committedRef.current.binding !== nextSelection.binding) {
				committedRef.current = nextSelection;
				setCommitted(nextSelection);
			}
			return;
		}
		if (committedRef.current !== undefined) {
			resetEditRealm({
				nextRuntimeGeneration: nextSelection.binding.generation,
			});
			setViewportEpoch((epoch) => epoch + 1);
		}
		committedRef.current = nextSelection;
		setCommitted(nextSelection);
	}, [activeGameResolved, activeGameSlug, nextSelection]);

	const committedSlug = committed?.slug;

	// Disk-watch asset refresh → reset realm + remount viewport (parity with the
	// standalone shell's StandaloneEditRealm). An external edit that rewrites the
	// scene pack on disk (CLI / agent) surfaces as assetsChanged with source
	// 'disk-watch'; remount the viewport so the scene document reloads from disk
	// instead of staying stale until a manual editor refresh. Skip the reset when
	// not playing AND there are unsaved edits (protect user work).
	useEffect(() => {
		if (committedSlug === undefined) return;
		const off = panelBridge.on("assetsChanged", ({ hint, source }) => {
			if (source !== "disk-watch") return;
			if (hint === "directory-only") return;
			if (assetRefreshTimer.current !== null)
				clearTimeout(assetRefreshTimer.current);
			assetRefreshTimer.current = setTimeout(() => {
				assetRefreshTimer.current = null;
				const isPlaying =
					gateway.mode === "play" || gateway.playPhase === "starting";
				if (!isPlaying && hasPendingDiskSave()) return;
				resetEditRealm({ flushPendingSave: false });
				setViewportEpoch((epoch) => epoch + 1);
			}, 120);
		});
		return () => {
			off();
			if (assetRefreshTimer.current !== null) {
				clearTimeout(assetRefreshTimer.current);
				assetRefreshTimer.current = null;
			}
		};
	}, [committedSlug]);

	if (!activeGameResolved || committed === undefined) {
		return (
			<div
				style={{
					display: "grid",
					placeItems: "center",
					height: "100%",
					color: "#8f94a3",
					background: "#16161a",
				}}
			>
				Preparing editor viewport…
			</div>
		);
	}

	if (!hasCatalogRoots(committed.binding)) {
		return (
			<div
				style={{
					display: "grid",
					placeItems: "center",
					height: "100%",
					color: "#8f94a3",
					background: "#16161a",
					textAlign: "center",
					padding: 24,
				}}
			>
				<div>
					<div style={{ color: "#f4f4f5", fontWeight: 700, marginBottom: 8 }}>
						No scene assets are available for this game.
					</div>
					<div>
						Switch to a game with an authored scene, or create/import scene
						assets for {committed.slug}.
					</div>
				</div>
			</div>
		);
	}

	return (
		<>
			<EditorServerTransport gameSlug={committed.slug} />
			<ViewportComponent
				key={`${committed.key}:${viewportEpoch}`}
				gameSlug={committed.slug}
				gameRoot={`.forgeax/games/${committed.slug}`}
				runtimeBinding={committed.binding}
			/>
		</>
	);
}

function ViewportRuntimeWindowBridge(): null {
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		if (params.has("runtimeId") && params.has("runtimeGeneration"))
			return undefined;

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
			if (
				runtime.carrierKind !== "browser-page" &&
				runtime.carrierKind !== "tauri-webview"
			)
				return;
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
	id: "forgeax-ide.product-panels",
	version: "1.0.0",
	contributes: {
		panels: {
			panels: {
				chat: {
					title: "ForgeaX CLI",
					order: 10,
					header: { visible: true },
					content: { padding: "none", scroll: "none", tone: "default" },
					dockChrome: { singleTab: "hideTitle" },
					render: () => <ChatPanel />,
				},
				agents: {
					title: "Agents",
					order: 20,
					header: { visible: true },
					content: { padding: "none", scroll: "none", tone: "default" },
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
	id: "forgeax-ide.editor-integration",
	version: "1.0.0",
	requires: ["panels"],
	setup(ctx) {
		const overlayEl = document.createElement("div");
		overlayEl.id = "editor-overlay-root";
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

export interface IdeApplicationOverrides {
	readonly createPageServices?: typeof createIdePageServices;
	readonly extensions?: readonly AppExtension[];
}

interface IdeBusEventMap extends AppBusEventMap {
	"chat:pill": { pill: PillPayload };
}

// Product selection and host/loader/catalog lifetime belong to IDE. The concrete
// panel views remain shared compatibility inputs.
export async function bootstrapIdeApplication(
	overrides: IdeApplicationOverrides = {},
) {
	const { host, control } = createApplicationHost<
		PanelRenderers,
		ReturnType<typeof createIdePageServices>,
		IdeBusEventMap,
		PanelActionContribution
	>({
		log: ideHostLogger,
		defaultPanels: DEFAULT_PANEL_RENDERERS,
		createPageServices: overrides.createPageServices ?? createIdePageServices,
	});

	const loader = createApplicationExtensionLoader<
		AppExtensionContext,
		AppExtensionContributes
	>({
		menus: host.menus,
		contextFactory: (manifest) => ({
			host,
			bus: host.bus,
			storage: host.storage,
			log: ideHostLogger,
			registerCommand: (command) => host.commands.register(command),
			contributePanels: (patch) => control.contributePanels(manifest.id, patch),
			contributePanelActions: (actions) =>
				control.contributePanelActions(manifest.id, actions),
			contributePanelControls: (controls) =>
				control.contributePanelControls(manifest.id, controls),
			contributePagePlatform: (contribution) =>
				control.contributePagePlatform(manifest.id, contribution),
		}),
		control,
		log: ideHostLogger,
	});

	const overrideIds = new Set(
		(overrides.extensions ?? []).map((extension) => extension.id),
	);
	const manifests = [
		foundationCommandsExtension,
		foundationBusExtension,
		foundationStorageExtension,
		builtinCommandsExtension,
		hostCommandsExtension,
		builtinMenusExtension,
		panelsViewportExtension,
		panelsChatExtension,
		chromeStatusBarExtension,
		chromeDrawerExtension,
		sessionClientExtension,
		studioDomainClientsExtension,
		observabilityExtension,
		trajectoryExtension,
		...(overrides.extensions ?? []),
	];

	// Preserve first-declaration precedence and make duplicate selection visible.
	{
		const seen = new Set<string>();
		for (const m of manifests) {
			if (seen.has(m.id)) {
				ideHostLogger.warn(
					`[appHostBootstrap] duplicate extension id "${m.id}" — later declaration is silently SKIPPED by the loader; rename one side`,
				);
			}
			seen.add(m.id);
		}
	}

	await loader.load(manifests);
	await loader.flush();
	const catalogRuntime = createCatalogPageExtensionRuntime({
		control,
		overriddenIds: overrideIds,
		views: {
			ExtensionHostPanel: IdeCatalogExtensionHostPanel,
		},
	});
	await catalogRuntime.start();

	const dispose = async (): Promise<void> => {
		await catalogRuntime.dispose();
		await loader.unload();
		await control.dispose();
	};

	return { host, control, dispose };
}

export const IDE_PRODUCT_OVERRIDES: IdeApplicationOverrides = {
	createPageServices: createIdePageServices,
	extensions: [
		createEditorKeyboardExtension(buildKeyboardRouterDeps()),
		createEditorMenuExtension(),
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
	initAgentPrefs({ publish, peek, subscribe });
	configureFilesRuntime(filesRuntime);
	initFiles();
	subscribeDaemonTick();
	subscribeSessionStream();
	subscribeNarrativeCopilot();
	subscribePermissionStream();
	subscribePerceptionStream();
	bootApplicationUiActionBridge();
	await useShellStore
		.getState()
		.initActiveGame()
		.catch(() => undefined);
	void useShellStore.getState().initSessions();
}
