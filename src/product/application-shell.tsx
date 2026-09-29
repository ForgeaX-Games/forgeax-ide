import {
	DEFAULT_PANEL_RENDERERS,
	PanelRenderersProvider,
} from "@forgeax/app-shell/application";
import { isSlotDebugEnabled, SlotDebugOverlay } from "@forgeax/app-shell/react";
import {
	type ComponentType,
	type ReactNode,
	useMemo,
	useSyncExternalStore,
} from "react";
import type { IdeApplicationRuntime } from "./application-startup";
import { useShellStore } from "./shell-state-runtime";
import { IdeStatusBar } from "./status-bar";
import type { bootstrapIdeApplication } from "./studio-composition";
import "./application-shell.css";

type Runtime = IdeApplicationRuntime<
	Awaited<ReturnType<typeof bootstrapIdeApplication>>
>;
export interface IdeApplicationShellViews {
	readonly ActivityRail: ComponentType;
	readonly CommandPalette: ComponentType;
	readonly ConnectModelPrompt: ComponentType;
	readonly ContextMenu: ComponentType;
	readonly DialogHost: ComponentType;
	readonly DockRegion: ComponentType<{
		region: "DockShell" | "AuxBar" | "ChatDock";
	}>;
	readonly DrawerHostView: ComponentType;
	readonly GameModalHost: ComponentType;
	readonly Onboarding: ComponentType<{
		children: ReactNode;
		tourEnabled?: boolean;
	}>;
	readonly PageTabStrip: ComponentType;
	readonly PassiveFeedbackHost: ComponentType;
	readonly GameDirectoryModalHost: ComponentType;
	readonly SurfaceKeepAliveLayer: ComponentType;
	readonly TopBar: ComponentType;
}
export interface IdeApplicationShellProps {
	readonly runtime: Runtime;
	readonly views: IdeApplicationShellViews;
	readonly KeyboardRouter: ComponentType<{ runtime: Runtime }>;
	readonly NativeMenuBridge: ComponentType<{ runtime: Runtime }>;
}

/** IDE owns its layout and selects shared setup views without the compatibility shell. */
export function IdeApplicationShell({
	runtime,
	views,
	KeyboardRouter,
	NativeMenuBridge,
}: IdeApplicationShellProps) {
	const {
		ActivityRail,
		CommandPalette,
		ConnectModelPrompt,
		ContextMenu,
		DialogHost,
		DockRegion,
		DrawerHostView,
		GameModalHost,
		Onboarding,
		PageTabStrip,
		PassiveFeedbackHost,
		GameDirectoryModalHost,
		SurfaceKeepAliveLayer,
		TopBar,
	} = views;
	const fullscreen = useShellStore((state) => state.fullscreen);
	const sidebarCollapsed = useShellStore((state) => state.sidebarCollapsed);
	const chatpanelCollapsed = useShellStore((state) => state.chatpanelCollapsed);
	const subscribePanels = useMemo(
		() => (callback: () => void) => runtime.control.onPanelsChange(callback),
		[runtime],
	);
	const renderers = useSyncExternalStore(
		subscribePanels,
		() => runtime.host.panels,
		() => DEFAULT_PANEL_RENDERERS,
	);
	const Dashboard = renderers.overlays?.Dashboard;
	const Settings = renderers.overlays?.Settings;
	const StatusBar = renderers.slots?.StatusBar ?? IdeStatusBar;
	return (
		<>
			<KeyboardRouter runtime={runtime} />
			<NativeMenuBridge runtime={runtime} />
			<PanelRenderersProvider value={renderers}>
				<Onboarding tourEnabled={false}>
					<div
						className="studio-shell studio-shell--preview-skin"
						data-fullscreen={fullscreen ? "1" : undefined}
						data-sidebar-collapsed={sidebarCollapsed ? "1" : undefined}
						data-chatpanel-collapsed={chatpanelCollapsed ? "1" : undefined}
					>
						<ConnectModelPrompt />
						<TopBar />
						<PassiveFeedbackHost />
						<div className="studio-body">
							<div className="studio-main-col">
								<PageTabStrip />
								<div className="studio-main-dock">
									<DockRegion region="DockShell" />
									<DockRegion region="AuxBar" />
								</div>
							</div>
							<SurfaceKeepAliveLayer />
							<ActivityRail />
							<DockRegion region="ChatDock" />
						</div>
						<DrawerHostView />
						<StatusBar />
						{Dashboard && (
							<div data-fx-slot="Dashboard" style={{ display: "contents" }}>
								<Dashboard />
							</div>
						)}
						{Settings && (
							<div data-fx-slot="Settings" style={{ display: "contents" }}>
								<Settings />
							</div>
						)}
						<ContextMenu />
						<CommandPalette />
						<GameDirectoryModalHost />
						<GameModalHost />
						<DialogHost />
						{isSlotDebugEnabled() && <SlotDebugOverlay />}
					</div>
				</Onboarding>
			</PanelRenderersProvider>
		</>
	);
}
