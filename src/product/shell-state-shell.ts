import type { SurfaceDescriptor } from "@forgeax/app-shell/window";
import type { IdeShellStoreContext } from "./shell-state-context";
import type { AppState } from "./shell-state-contract";
import {
	loadSettingsSection,
	saveSettingsSection,
} from "./shell-state-persistence";

type SetAppState = (
	partial: Partial<AppState> | ((state: AppState) => Partial<AppState>),
) => void;
type GetAppState = () => AppState;

export function createShellState(
	set: SetAppState,
	get: GetAppState,
	getSurfaceWindowingController: IdeShellStoreContext["getSurfaceWindowingController"],
): Pick<
	AppState,
	| "detachSurface"
	| "redockSurface"
	| "activeSession"
	| "setActiveSession"
	| "activeOverlay"
	| "overlayParam"
	| "openOverlay"
	| "setOverlayParam"
	| "closeOverlay"
	| "gameDirectoryModalOpen"
	| "openGameDirectoryModal"
	| "closeGameDirectoryModal"
	| "gameSwitcherOpen"
	| "setGameSwitcherOpen"
	| "gameModalOpen"
	| "openGameModal"
	| "closeGameModal"
	| "fullscreen"
	| "setFullscreen"
	| "toggleFullscreen"
	| "sidebarCollapsed"
	| "chatpanelCollapsed"
	| "toggleSidebar"
	| "toggleChatpanel"
> {
	return {
		detachSurface: (d: SurfaceDescriptor, opts) =>
			getSurfaceWindowingController().detachSurface(d, opts),
		redockSurface: (d: SurfaceDescriptor) =>
			getSurfaceWindowingController().redockSurface(d),

		activeSession: "main-design",
		setActiveSession: (s) => set({ activeSession: s }),

		activeOverlay: null,
		overlayParam: loadSettingsSection(),
		openOverlay: (id, param) => {
			const p = param ?? get().overlayParam ?? null;
			saveSettingsSection(p);
			set({ activeOverlay: id, overlayParam: p });
		},
		setOverlayParam: (param) => {
			saveSettingsSection(param);
			set({ overlayParam: param });
		},
		closeOverlay: () => set({ activeOverlay: null }),

		gameDirectoryModalOpen: false,
		openGameDirectoryModal: () => set({ gameDirectoryModalOpen: true }),
		closeGameDirectoryModal: () => set({ gameDirectoryModalOpen: false }),

		gameSwitcherOpen: false,
		setGameSwitcherOpen: (v) => set({ gameSwitcherOpen: v }),
		gameModalOpen: false,
		openGameModal: () => set({ gameModalOpen: true }),
		closeGameModal: () => set({ gameModalOpen: false }),

		fullscreen: false,
		setFullscreen: (v) => set({ fullscreen: v }),
		toggleFullscreen: () => set((s) => ({ fullscreen: !s.fullscreen })),

		sidebarCollapsed: false,
		chatpanelCollapsed: false,
		toggleSidebar: () =>
			set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
		toggleChatpanel: () =>
			set((s) => ({ chatpanelCollapsed: !s.chatpanelCollapsed })),
	};
}
