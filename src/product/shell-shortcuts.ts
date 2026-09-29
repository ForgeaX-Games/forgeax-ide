import type {
	ApplicationShortcut,
	ApplicationShortcutRegistry,
} from "@forgeax/app-shell/application";

/** Product decisions, separate from the shared router and contribution registry. */
export interface ProductShortcutState {
	activeOverlay: string | null;
	fullscreen: boolean;
	chatpanelCollapsed: boolean;
	toggleFullscreen(): void;
	toggleSidebar(): void;
	toggleChatpanel(): void;
	closeOverlay(): void;
	openOverlay(id: string, param?: string): void;
	setFullscreen(value: boolean): void;
}

const mod = (event: KeyboardEvent) => event.ctrlKey || event.metaKey;
const safeKeyLower = (event: KeyboardEvent) =>
	typeof event.key === "string" ? event.key.toLowerCase() : "";

export function createProductShellShortcuts({
	getState: store,
	t,
	toggleCommandPalette,
}: {
	getState: () => ProductShortcutState;
	t: (key: string) => string;
	toggleCommandPalette: () => void;
}): readonly ApplicationShortcut[] {
	const shortcuts: ApplicationShortcut[] = [
		// ── Layout (collapse / fullscreen) ──
		{
			combo: "Ctrl+Shift+F",
			group: "layout",
			get label() {
				return t("shortcuts.gameFullscreen");
			},
			match: (e) => mod(e) && e.shiftKey && e.code === "KeyF",
			run: () => {
				store().toggleFullscreen();
				return true;
			},
		},
		{
			combo: "Ctrl+Shift+Enter",
			group: "layout",
			get label() {
				return t("shortcuts.browserFullscreen");
			},
			match: (e) =>
				mod(e) && e.shiftKey && (e.code === "Enter" || e.key === "Enter"),
			run: () => {
				// Browser-native fullscreen toggle. Independent of store.fullscreen
				// — user can have either, both, or neither. Esc exits the native FS
				// automatically; fullscreenchange listener below keeps state in sync
				// if needed (we don't currently mirror native FS into the store,
				// because the two modes are intentionally orthogonal).
				try {
					if (!document.fullscreenElement) {
						void document.documentElement.requestFullscreen?.().catch(() => {
							/* blocked */
						});
					} else {
						void document.exitFullscreen?.().catch(() => {
							/* */
						});
					}
				} catch {
					/* old browsers without FS API */
				}
				return true;
			},
		},
		{
			combo: "Ctrl+Shift+B",
			group: "layout",
			get label() {
				return t("shortcuts.toggleSidebar");
			},
			match: (e) => mod(e) && e.shiftKey && e.code === "KeyB",
			run: () => {
				store().toggleSidebar();
				return true;
			},
		},
		{
			combo: "Ctrl+Shift+C",
			group: "layout",
			get label() {
				return t("shortcuts.toggleChatPanel");
			},
			match: (e) => mod(e) && e.shiftKey && e.code === "KeyC",
			run: () => {
				store().toggleChatpanel();
				return true;
			},
		},
		{
			// 3-state chat toggle: closed → open at default (ChatDock); open but dragged
			// into the centre grid → move it home; open at default → close. ChatDock owns
			// the actual work (it holds chat's dockview api + panelLocations) — we just
			// fire the intent so a single handler converges every route. preventDefault
			// always so F1 never opens the browser help page.
			combo: "F1",
			group: "layout",
			get label() {
				return t("shortcuts.revealChat");
			},
			match: (e) =>
				!mod(e) &&
				!e.shiftKey &&
				!e.altKey &&
				(e.key === "F1" || e.code === "F1"),
			run: () => {
				window.dispatchEvent(new CustomEvent("forgeax:chat-toggle"));
				return true;
			},
		},

		// ── Overlay (Dashboard / Settings) ──
		{
			combo: "Ctrl+Shift+D",
			group: "overlay",
			get label() {
				return t("shortcuts.toggleDashboard");
			},
			match: (e) => mod(e) && e.shiftKey && e.code === "KeyD",
			run: () => {
				const s = store();
				s.activeOverlay === "dashboard"
					? s.closeOverlay()
					: s.openOverlay("dashboard");
				return true;
			},
		},
		{
			combo: "Ctrl+,",
			group: "overlay",
			get label() {
				return t("shortcuts.toggleSettings");
			},
			match: (e) =>
				mod(e) && !e.shiftKey && (e.key === "," || e.code === "Comma"),
			run: () => {
				const s = store();
				s.activeOverlay === "settings"
					? s.closeOverlay()
					: s.openOverlay("settings");
				return true;
			},
		},
		{
			combo: "Ctrl+Shift+H",
			group: "overlay",
			get label() {
				return t("shortcuts.openChangelog");
			},
			match: (e) => mod(e) && e.shiftKey && e.code === "KeyH",
			run: () => {
				store().openOverlay("settings", "changelog");
				return true;
			},
		},
		{
			combo: "Esc",
			group: "overlay",
			get label() {
				return t("shortcuts.closeOverlay");
			},
			allowInInput: true,
			match: (e) => e.key === "Escape" && !mod(e) && !e.shiftKey && !e.altKey,
			run: () => {
				const s = store();
				// Browser fullscreen exits automatically on Esc — but be defensive
				// in case some browser swallows the event before reaching the native
				// handler; explicit exit is a no-op when no element is fullscreen.
				if (document.fullscreenElement) {
					void document.exitFullscreen?.().catch(() => {
						/* */
					});
					return true;
				}
				if (s.fullscreen) {
					s.setFullscreen(false);
					return true;
				}
				if (s.activeOverlay) {
					s.closeOverlay();
					return true;
				}
				return false;
			},
		},

		{
			combo: "Ctrl+Shift+0",
			group: "overlay",
			get label() {
				return t("shortcuts.openExtensions");
			},
			match: (e) =>
				mod(e) &&
				e.shiftKey &&
				(e.code === "Digit0" || e.key === "0" || e.key === ")"),
			run: () => {
				store().openOverlay("settings", "plugins");
				return true;
			},
		},

		// ── Focus ──
		{
			combo: "Ctrl+/",
			group: "focus",
			get label() {
				return t("shortcuts.focusComposer");
			},
			allowInInput: true,
			match: (e) =>
				mod(e) && !e.shiftKey && (e.key === "/" || e.code === "Slash"),
			run: () => {
				// Auto-uncollapse first if hidden.
				const s = store();
				if (s.chatpanelCollapsed) s.toggleChatpanel();
				// Focus the composer's editable element. Selector covers RichInput
				// (preferred new path) and the legacy textarea fallback.
				const el =
					document.querySelector<HTMLElement>(
						'.kc-composer-rich [contenteditable="true"]',
					) ||
					document.querySelector<HTMLElement>(".kc-composer textarea") ||
					document.querySelector<HTMLElement>("[data-kc-composer]");
				if (el) {
					el.focus();
					// Move caret to end if it's a contenteditable
					if (el.isContentEditable) {
						const sel = window.getSelection();
						const range = document.createRange();
						range.selectNodeContents(el);
						range.collapse(false);
						sel?.removeAllRanges();
						sel?.addRange(range);
					}
				}
				return true;
			},
		},
	];
	shortcuts.push({
		priority: -20,
		combo: "Ctrl+K",
		group: "general",
		get label() {
			return t("shortcuts.toggleCommandPalette");
		},
		match: (e) =>
			mod(e) &&
			!e.altKey &&
			!e.shiftKey &&
			(e.code === "KeyK" || safeKeyLower(e) === "k"),
		run: () => {
			toggleCommandPalette();
			return true;
		},
	});

	return Object.freeze(
		shortcuts.map((shortcut) =>
			Object.freeze({
				priority: 10,
				...shortcut,
				get label() {
					return shortcut.label;
				},
			}),
		),
	);
}

/** Presentation order is deliberately independent of routing priority. */
export function describeProductShortcuts(
	shell: readonly ApplicationShortcut[],
	contributions: ApplicationShortcutRegistry,
): readonly ApplicationShortcut[] {
	const rowKey = ({ combo, group, label }: ApplicationShortcut) =>
		JSON.stringify([combo, group, label]);
	const seen = new Set(shell.map(rowKey));
	const rows = contributions.snapshot().filter((shortcut) => {
		const key = rowKey(shortcut);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return [...shell.slice(0, -1), ...rows, ...shell.slice(-1)];
}
