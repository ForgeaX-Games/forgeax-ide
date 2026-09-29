// IDE bottom drawer layout state (open/closed, active panel,
// height). This is distinct from the STRUCTURAL plane (which drawer panels
// exist — host.panels.drawerPanels) and the BUSINESS plane (a panel's own data
// store). Persisted across reloads; height clamps to a UX-safe range.
//
// singleActive: at most one drawer panel is expanded at a time (activeId). A
// null activeId means the drawer is collapsed (only the launcher row shows).
import { create } from "zustand";

const HEIGHT_KEY = "forgeax:drawer-height";
const ACTIVE_KEY = "forgeax:drawer-active";
export const DRAWER_MIN_HEIGHT = 120;
export const DRAWER_MAX_HEIGHT = 720;
export const DRAWER_DEFAULT_HEIGHT = 260;

function clampHeight(n: number): number {
	if (!Number.isFinite(n)) return DRAWER_DEFAULT_HEIGHT;
	if (n < DRAWER_MIN_HEIGHT) return DRAWER_MIN_HEIGHT;
	if (n > DRAWER_MAX_HEIGHT) return DRAWER_MAX_HEIGHT;
	return Math.round(n);
}

function loadHeight(): number {
	try {
		if (typeof localStorage === "undefined") return DRAWER_DEFAULT_HEIGHT;
		const raw = localStorage.getItem(HEIGHT_KEY);
		return raw ? clampHeight(Number.parseInt(raw, 10)) : DRAWER_DEFAULT_HEIGHT;
	} catch {
		return DRAWER_DEFAULT_HEIGHT;
	}
}
function loadActive(): string | null {
	try {
		if (typeof localStorage === "undefined") return null;
		return localStorage.getItem(ACTIVE_KEY) || null;
	} catch {
		return null;
	}
}
function persist(key: string, value: string): void {
	try {
		if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
	} catch {
		/* private mode / storage disabled */
	}
}
function clearPersist(key: string): void {
	try {
		if (typeof localStorage !== "undefined") localStorage.removeItem(key);
	} catch {
		/* noop */
	}
}

interface DrawerStore {
	/** Currently expanded drawer panel id; null = collapsed. */
	activeId: string | null;
	height: number;
	open: (id: string) => void;
	close: () => void;
	/** Open `id`; if it is already the active panel, collapse instead. */
	toggle: (id: string) => void;
	setHeight: (px: number) => void;
}

export const useIdeDrawerStore = create<DrawerStore>((set, get) => ({
	activeId: loadActive(),
	height: loadHeight(),
	open: (id) => {
		persist(ACTIVE_KEY, id);
		set({ activeId: id });
	},
	close: () => {
		clearPersist(ACTIVE_KEY);
		set({ activeId: null });
	},
	toggle: (id) => {
		if (get().activeId === id) {
			clearPersist(ACTIVE_KEY);
			set({ activeId: null });
		} else {
			persist(ACTIVE_KEY, id);
			set({ activeId: id });
		}
	},
	setHeight: (px) => {
		const h = clampHeight(px);
		persist(HEIGHT_KEY, String(h));
		set({ height: h });
	},
}));
