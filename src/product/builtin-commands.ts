import type { AppExtension } from "@forgeax/app-shell/application";
import { isDockPanelVisible } from "@forgeax/app-shell/dock";
import { sessionClientRuntime } from "./product-clients";
import { getIdeShellStore } from "./shell-state-runtime";

type TextEditAction = "cut" | "copy" | "paste" | "selectAll";
interface CommandServices {
	executeFocusedTextEditAction(action: TextEditAction): Promise<boolean>;
	resetChatWidth(): void;
	openFeedback(): void;
	openOnboarding(): void;
}

const getState = () => getIdeShellStore().getState();
const isTauri = () =>
	typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function createIdeBuiltinCommandsExtension({
	executeFocusedTextEditAction,
	resetChatWidth,
	openFeedback,
	openOnboarding,
}: CommandServices): AppExtension {
	return {
		id: "builtin-commands",
		version: "1.0.0",
		requires: ["commands"],
		setup(ctx) {
			const { registerCommand } = ctx;
			const cleanups: Array<() => void> = [];

			const registerTextEditCommand = (
				id: string,
				title: string,
				action: TextEditAction,
			): void => {
				cleanups.push(
					registerCommand({
						id,
						title,
						execute: async () => ({
							status: (await executeFocusedTextEditAction(action))
								? ("completed" as const)
								: ("rejected" as const),
						}),
					}),
				);
			};

			registerTextEditCommand("text.cut", "剪切输入框选区", "cut");
			registerTextEditCommand("text.copy", "复制输入框选区", "copy");
			registerTextEditCommand("text.paste", "粘贴到输入框", "paste");
			registerTextEditCommand(
				"text.selectAll",
				"Select all focused text",
				"selectAll",
			);

			cleanups.push(
				registerCommand({
					id: "app.panel.open",
					title: "Open (or focus) a dock panel by id",
					execute: (args) => {
						const id = (args as { id?: string })?.id;
						if (!id) throw new Error("app.panel.open: missing { id }");
						ctx.bus.emit("panel:open", { id });
						return { status: "completed" as const };
					},
				}),
			);

			cleanups.push(
				registerCommand({
					id: "app.panel.reveal",
					title:
						"Reveal a dock panel wherever it lives (grid, closed, or edge drawer)",
					execute: (args) => {
						const id = (args as { id?: string })?.id;
						if (!id) throw new Error("app.panel.reveal: missing { id }");
						ctx.bus.emit("panel:reveal", { id });
						return { status: "completed" as const };
					},
				}),
			);

			cleanups.push(
				registerCommand({
					id: "app.panel.focus",
					title: "Focus an existing dock panel by id (no reopen)",
					execute: (args) => {
						const id = (args as { id?: string })?.id;
						if (!id) throw new Error("app.panel.focus: missing { id }");
						ctx.bus.emit("panel:focus", { id });
						return { status: "completed" as const };
					},
				}),
			);

			cleanups.push(
				registerCommand({
					id: "app.panel.close",
					title: "Close a dock panel by id (no-op if not open)",
					execute: (args) => {
						const id = (args as { id?: string })?.id;
						if (!id) throw new Error("app.panel.close: missing { id }");
						ctx.bus.emit("panel:close", { id });
						return { status: "completed" as const };
					},
				}),
			);

			cleanups.push(
				registerCommand({
					id: "app.panel.toggle",
					title: "Toggle a dock panel by id (open if hidden, close if visible)",
					execute: (args) => {
						const id = (args as { id?: string })?.id;
						if (!id) throw new Error("app.panel.toggle: missing { id }");
						if (isDockPanelVisible(id)) ctx.bus.emit("panel:close", { id });
						else ctx.bus.emit("panel:open", { id });
						return { status: "completed" as const };
					},
				}),
			);

			cleanups.push(
				registerCommand({
					id: "app.open_url",
					title: "Open an external http(s) URL in the OS default browser",
					execute: async (args) => {
						const url = (args as { url?: string })?.url;
						if (typeof url !== "string" || !url)
							throw new Error("app.open_url: missing { url }");
						const trimmed = url.trim();
						if (!/^https?:\/\//i.test(trimmed)) {
							throw new Error(
								`app.open_url: only http(s) URLs are allowed, got: ${trimmed}`,
							);
						}
						if (isTauri()) {
							try {
								const shell = await import("@tauri-apps/plugin-shell");
								await shell.open(trimmed);
								return { status: "completed" as const };
							} catch {}
						}
						try {
							window.open(trimmed, "_blank", "noopener");
						} catch {}
						return { status: "completed" as const };
					},
				}),
			);

			cleanups.push(
				registerCommand({
					id: "app.dock.reset",
					title: "Reset dock layout",
					execute: () => {
						ctx.bus.emit("dock:reset", {});
						try {
							resetChatWidth();
						} catch {}
						return { status: "completed" as const };
					},
				}),
			);

			cleanups.push(
				registerCommand({
					id: "app.dock.layoutToggle",
					title: "Open the dock layout menu",
					execute: (args) => {
						ctx.bus.emit(
							"dock:layout-toggle",
							(args as {
								pageId?: string;
								rect?: {
									top: number;
									bottom: number;
									left: number;
									right: number;
								};
							}) ?? {},
						);
						return { status: "completed" as const };
					},
				}),
			);

			cleanups.push(
				registerCommand({
					id: "panel.toggle_sidebar",
					title: "折叠/展开侧栏",
					execute: () => {
						getState().toggleSidebar();
						return { status: "completed" as const };
					},
				}),
			);

			cleanups.push(
				registerCommand({
					id: "panel.toggle_chatpanel",
					title: "折叠/展开聊天面板",
					execute: () => {
						getState().toggleChatpanel();
						return { status: "completed" as const };
					},
				}),
			);

			cleanups.push(
				registerCommand({
					id: "app.set_fullscreen",
					title: "沉浸模式",
					execute: (args) => {
						const value = (args as { value?: boolean })?.value ?? false;
						getState().setFullscreen(value);
						return { status: "completed" as const, value };
					},
				}),
			);

			cleanups.push(
				registerCommand({
					id: "overlay.open",
					title: "打开浮层",
					execute: (args) => {
						const p = args as { id?: string; param?: string } | undefined;
						if (!p?.id) throw new Error("overlay.open: missing { id }");
						getState().openOverlay(p.id, p.param);
						return { status: "completed" as const };
					},
				}),
			);

			cleanups.push(
				registerCommand({
					id: "overlay.close",
					title: "关闭浮层",
					execute: () => {
						getState().closeOverlay();
						return { status: "completed" as const };
					},
				}),
			);

			cleanups.push(
				registerCommand({
					id: "feedback.open",
					title: "打开反馈面板",
					execute: () => {
						openFeedback();
						return { status: "completed" as const };
					},
				}),
			);

			cleanups.push(
				registerCommand({
					id: "onboarding.open",
					title: "新手指引",
					execute: () => {
						openOnboarding();
						return { status: "completed" as const };
					},
				}),
			);

			cleanups.push(
				registerCommand({
					id: "session.reconnect",
					title: "重连当前会话",
					execute: () => {
						const sid = getState().activeSid;
						const client = sessionClientRuntime.read();
						if (!sid || !client)
							throw new Error("session.reconnect: no active session client");
						client.disconnectForgeaXWs();
						client.connectForgeaXWs(sid);
						return { status: "completed" as const };
					},
				}),
			);

			cleanups.push(
				registerCommand({
					id: "game.open-directory",
					title: "打开游戏目录",
					execute: () => {
						getState().openGameDirectoryModal();
						return { status: "completed" as const };
					},
				}),
			);

			cleanups.push(
				registerCommand({
					id: "game.new",
					title: "新建游戏",
					execute: () => {
						getState().openGameModal();
						return { status: "completed" as const };
					},
				}),
			);

			cleanups.push(
				registerCommand({
					id: "game.open",
					title: "打开游戏（游戏列表）",
					execute: () => {
						getState().setGameSwitcherOpen(true);
						return { status: "completed" as const };
					},
				}),
			);

			cleanups.push(
				registerCommand({
					id: "game.pick",
					title: "切换到游戏",
					execute: (args) => {
						const slug = (args as { slug?: unknown } | undefined)?.slug;
						if (typeof slug !== "string" || !slug)
							return { status: "rejected" as const };
						void getState().setActiveGame(slug);
						return { status: "completed" as const };
					},
				}),
			);

			return () => {
				for (const c of cleanups.slice().reverse()) c();
			};
		},
	};
}
