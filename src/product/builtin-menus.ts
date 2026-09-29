import type {
	AppExtension,
	ApplicationMenuItem,
} from "@forgeax/app-shell/application";
import { isDockPanelVisible } from "@forgeax/app-shell/dock";
import { t } from "./product-locale";
import type { ProjectRow } from "./shell-state-domain-contract";
import { getIdeShellStore } from "./shell-state-runtime";

type MenuItemDef = Omit<
	ApplicationMenuItem,
	"label" | "groupOrder" | "children" | "dynamicChildren"
> & {
	readonly labelKey: string;
	readonly children?: readonly MenuItemDef[];
	readonly dynamicChildren?: () => readonly MenuItemDef[];
};

const isVisible = (id: string) => () => isDockPanelVisible(id);
const isChatpanelOpen = () => !getIdeShellStore().getState().chatpanelCollapsed;

const SECTION_ORDER: Record<string, Record<string, number>> = {
	brand: { app: 10, about: 20 },
	file: { game: 10, file: 20, io: 30, recent: 10 },
	edit: { history: 10, clipboard: 20, find: 30, version: 40 },
	window: { panels: 10, layout: 20 },
	build: { run: 10, export: 20 },
	select: { basic: 10, byCond: 20, view: 30 },
	help: { docs: 10, resources: 20, app: 30, about: 40 },
};

function localizeMenu(def: MenuItemDef): ApplicationMenuItem {
	const { labelKey, children, dynamicChildren, ...metadata } = def;
	const groupOrder = SECTION_ORDER[def.menu]?.[def.group];
	if (groupOrder === undefined)
		throw new Error(`Missing menu section order: ${def.menu}/${def.group}`);
	return {
		...metadata,
		groupOrder,
		get label() {
			return t(labelKey);
		},
		...(children ? { children: children.map(localizeMenu) } : {}),
		...(dynamicChildren
			? { dynamicChildren: () => dynamicChildren().map(localizeMenu) }
			: {}),
	};
}

export function createIdeBuiltinMenusExtension(
	getRecentGames: () => readonly ProjectRow[],
): AppExtension {
	return {
		id: "builtin-menus",
		version: "1.0.0",
		setup({ host }) {
			const cleanups: Array<() => void> = [];

			const items: MenuItemDef[] = [
				{
					id: "brand.settings",
					menu: "brand",
					group: "app",
					order: 10,
					labelKey: "menu.brand.settings",
					icon: "settings",
					commandId: "overlay.open",
					args: { id: "settings" },
				},
				{
					id: "brand.about",
					menu: "brand",
					group: "about",
					order: 10,
					labelKey: "menu.brand.about",
					icon: "info",
					commandId: "overlay.open",
					args: { id: "settings", param: "about" },
				},
				{
					id: "brand.checkUpdate",
					menu: "brand",
					group: "about",
					order: 20,
					labelKey: "menu.brand.checkUpdate",
					icon: "refresh-cw",
				},

				{
					id: "file.newGame",
					menu: "file",
					group: "game",
					order: 10,
					labelKey: "menu.file.newGame",
					commandId: "game.new",
					icon: "file-plus",
				},
				{
					id: "file.openGameDirectory",
					menu: "file",
					group: "game",
					order: 20,
					labelKey: "menu.file.openGameDirectory",
					commandId: "game.open-directory",
					icon: "folder-open",
				},
				{
					id: "file.openRecent",
					menu: "file",
					group: "game",
					order: 30,
					labelKey: "menu.file.openRecent",
					icon: "clock",
					dynamicChildCommandId: "game.pick",
					dynamicChildIdFromArg: "slug",
					dynamicChildren: () =>
						getRecentGames().map(
							(g): MenuItemDef => ({
								id: `file.openRecent.${g.slug}`,
								menu: "file",
								group: "recent",
								order: 0,
								labelKey:
									typeof g.name === "string" && g.name ? g.name : g.slug,
								commandId: "game.pick",
								args: { slug: g.slug },
							}),
						),
				},
				{
					id: "file.closeGame",
					menu: "file",
					group: "game",
					order: 40,
					labelKey: "menu.file.closeGame",
					icon: "x",
				},

				{
					id: "file.saveAll",
					menu: "file",
					group: "file",
					order: 20,
					labelKey: "menu.file.saveAll",
					icon: "save-all",
					keybinding: "Ctrl+Shift+S",
				},
				{
					id: "file.reveal",
					menu: "file",
					group: "file",
					order: 30,
					labelKey: "menu.file.reveal",
					icon: "folder-search",
				},

				{
					id: "file.import",
					menu: "file",
					group: "io",
					order: 10,
					labelKey: "menu.file.import",
					icon: "upload",
				},
				{
					id: "file.export",
					menu: "file",
					group: "io",
					order: 20,
					labelKey: "menu.file.export",
					icon: "package",
				},
				{
					id: "file.package",
					menu: "file",
					group: "io",
					order: 30,
					labelKey: "menu.file.package",
					icon: "globe",
				},

				{
					id: "edit.cut",
					menu: "edit",
					group: "clipboard",
					order: 10,
					labelKey: "menu.edit.cut",
					icon: "scissors",
					commandId: "text.cut",
					keybinding: "Ctrl+X",
				},
				{
					id: "edit.copy",
					menu: "edit",
					group: "clipboard",
					order: 20,
					labelKey: "menu.edit.copy",
					icon: "copy",
					commandId: "text.copy",
					keybinding: "Ctrl+C",
				},
				{
					id: "edit.paste",
					menu: "edit",
					group: "clipboard",
					order: 30,
					labelKey: "menu.edit.paste",
					icon: "clipboard",
					commandId: "text.paste",
					keybinding: "Ctrl+V",
				},
				{
					id: "edit.copyPath",
					menu: "edit",
					group: "clipboard",
					order: 50,
					labelKey: "menu.edit.copyPath",
					icon: "copy",
				},
				{
					id: "edit.copyGuid",
					menu: "edit",
					group: "clipboard",
					order: 60,
					labelKey: "menu.edit.copyGuid",
					icon: "hash",
				},

				{
					id: "edit.find",
					menu: "edit",
					group: "find",
					order: 10,
					labelKey: "menu.edit.find",
					icon: "search",
					keybinding: "Ctrl+F",
				},

				{
					id: "edit.rollback",
					menu: "edit",
					group: "version",
					order: 10,
					labelKey: "menu.edit.rollback",
					icon: "rotate-ccw",
				},

				{
					id: "window.timeline",
					menu: "window",
					group: "panels",
					order: 40,
					labelKey: "menu.window.timeline",
				},
				{
					id: "window.runtime",
					menu: "window",
					group: "panels",
					order: 50,
					labelKey: "menu.window.runtime",
				},
				{
					id: "window.viewport",
					menu: "window",
					group: "panels",
					order: 60,
					labelKey: "menu.window.viewport",
					commandId: "app.panel.toggle",
					args: { id: "viewport" },
					checked: isVisible("viewport"),
				},
				{
					id: "window.chat",
					menu: "window",
					group: "panels",
					order: 70,
					labelKey: "menu.window.chat",
					commandId: "panel.toggle_chatpanel",
					checked: isChatpanelOpen,
				},

				{
					id: "window.resetLayout",
					menu: "window",
					group: "layout",
					order: 10,
					labelKey: "menu.window.resetLayout",
					icon: "layout-grid",
					commandId: "app.dock.reset",
				},
				{
					id: "window.fullscreen",
					menu: "window",
					group: "layout",
					order: 20,
					labelKey: "menu.window.fullscreen",
					icon: "maximize",
					commandId: "app.set_fullscreen",
					args: { value: true },
				},

				{
					id: "build.export",
					menu: "build",
					group: "export",
					order: 10,
					labelKey: "menu.build.export",
					icon: "package",
				},
				{
					id: "build.settings",
					menu: "build",
					group: "export",
					order: 20,
					labelKey: "menu.build.settings",
					icon: "settings",
				},

				{
					id: "help.onboarding",
					menu: "help",
					group: "docs",
					order: 0,
					labelKey: "menu.help.onboarding",
					icon: "sparkles",
					commandId: "onboarding.open",
				},
				{
					id: "help.docs",
					menu: "help",
					group: "docs",
					order: 10,
					labelKey: "menu.help.docs",
					icon: "book-open",
					commandId: "app.open_url",
					args: { url: "https://forgeax.github.io/docs" },
				},
				{
					id: "help.tutorials",
					menu: "help",
					group: "docs",
					order: 20,
					labelKey: "menu.help.tutorials",
					icon: "graduation-cap",
					commandId: "app.open_url",
					args: { url: "https://forgeax.github.io/tutorials" },
				},
				{
					id: "help.examples",
					menu: "help",
					group: "docs",
					order: 30,
					labelKey: "menu.help.examples",
					icon: "code",
					commandId: "app.open_url",
					args: { url: "https://forgeax.github.io/examples" },
				},
				{
					id: "help.blog",
					menu: "help",
					group: "docs",
					order: 40,
					labelKey: "menu.help.blog",
					icon: "newspaper",
					commandId: "app.open_url",
					args: { url: "https://forgeax.github.io/blog" },
				},

				{
					id: "help.games",
					menu: "help",
					group: "resources",
					order: 10,
					labelKey: "menu.help.games",
					icon: "gamepad-2",
					commandId: "app.open_url",
					args: { url: "https://forgeax.github.io/games" },
				},
				{
					id: "help.marketplace",
					menu: "help",
					group: "resources",
					order: 20,
					labelKey: "menu.help.marketplace",
					icon: "store",
					commandId: "app.open_url",
					args: { url: "https://forgeax.github.io/marketplace" },
				},
				{
					id: "help.changelog",
					menu: "help",
					group: "resources",
					order: 30,
					labelKey: "menu.help.changelog",
					icon: "scroll-text",
					commandId: "app.open_url",
					args: { url: "https://forgeax.github.io/changelog" },
				},

				{
					id: "help.shortcuts",
					menu: "help",
					group: "app",
					order: 10,
					labelKey: "menu.help.shortcuts",
					icon: "keyboard",
					commandId: "overlay.open",
					args: { id: "settings", param: "shortcuts" },
				},
				{
					id: "help.askAi",
					menu: "help",
					group: "app",
					order: 20,
					labelKey: "menu.help.askAi",
					icon: "sparkles",
					commandId: "app.open_url",
					args: { url: "https://forgeax.github.io/" },
				},

				{
					id: "help.github",
					menu: "help",
					group: "about",
					order: 10,
					labelKey: "menu.help.github",
					icon: "github",
					commandId: "app.open_url",
					args: { url: "https://github.com/ForgeaX-Games" },
				},
				{
					id: "help.report",
					menu: "help",
					group: "about",
					order: 20,
					labelKey: "menu.help.report",
					icon: "message-circle",
					commandId: "feedback.open",
				},
				{
					id: "help.about",
					menu: "help",
					group: "about",
					order: 30,
					labelKey: "menu.help.about",
					icon: "info",
					commandId: "overlay.open",
					args: { id: "settings", param: "about" },
				},
				{
					id: "help.license",
					menu: "help",
					group: "about",
					order: 40,
					labelKey: "menu.help.license",
					icon: "scale",
					commandId: "app.open_url",
					args: { url: "https://www.apache.org/licenses/LICENSE-2.0" },
				},
			];

			for (const def of items)
				cleanups.push(host.menus.register(localizeMenu(def)));

			return () => {
				for (const c of cleanups.slice().reverse()) c();
			};
		},
	};
}
