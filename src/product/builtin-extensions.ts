import {
	type AppExtension,
	publishTopic as publish,
} from "@forgeax/app-shell/application";
import { buildAssetPill, type PillPayload } from "@forgeax/chat/runtime";
import { requestComposerInsert } from "../integration/composer-reference-queue";
import {
	sessionClientRuntime,
	studioDomainClientRuntime,
} from "./product-clients";
import type {
	AppState,
	ConsoleEntry,
	NetworkEntry,
	TelemetryRecord,
} from "./shell-state-contract";
import { useShellStore } from "./shell-state-runtime";

// Product-selected manifests use the shared host's existing capabilities.
// The foundation markers preserve extension identity and activation ordering.

export const foundationCommandsExtension: AppExtension = {
	id: "foundation.commands",
	version: "1.0.0",
	provides: [], // commands is a BASE capability; we do not re-provide.
	setup() {
		/* no-op */
	},
};

export const foundationBusExtension: AppExtension = {
	id: "foundation.bus",
	version: "1.0.0",
	provides: [],
	setup() {},
};

export const foundationStorageExtension: AppExtension = {
	id: "foundation.storage",
	version: "1.0.0",
	provides: [],
	setup() {},
};

export interface FilesRevealArgs {
	path: string;
}

export interface BuildCreateArgs {
	version: string;
}

export interface BuildPlayArgs {
	version: string;
}

export interface HostCommandArgsById {
	"app.files.reveal": FilesRevealArgs;
	"app.build.create": BuildCreateArgs;
	"app.build.play": BuildPlayArgs;
}

export type HostCommandId = keyof HostCommandArgsById;
export type HostCommandArgs<I extends HostCommandId = HostCommandId> =
	HostCommandArgsById[I];

function requiredString(
	commandId: string,
	args: unknown,
	key: "path" | "version",
): string {
	const value = (args as Record<string, unknown> | undefined)?.[key];
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${commandId}: missing { ${key} }`);
	}
	return value.trim();
}

export const hostCommandsExtension: AppExtension = {
	id: "host-commands",
	version: "1.0.0",
	requires: ["commands"],
	setup(ctx) {
		const cleanups: Array<() => void> = [];

		cleanups.push(
			ctx.registerCommand({
				id: "app.files.reveal",
				title: "Reveal a file in the resource editor",
				execute: (args) => {
					const path = requiredString("app.files.reveal", args, "path");
					publish("resource-editor:open-file", { path });
					ctx.bus.emit("files:reveal", { path });
					return { status: "completed" as const, path };
				},
			}),
		);

		cleanups.push(
			ctx.registerCommand({
				id: "app.build.create",
				title: "Create a game build",
				execute: (args) => {
					const version = requiredString("app.build.create", args, "version");
					ctx.bus.emit("build:create", { version });
					return { status: "completed" as const, version };
				},
			}),
		);

		cleanups.push(
			ctx.registerCommand({
				id: "app.build.play",
				title: "Play a game build",
				execute: (args) => {
					const version = requiredString("app.build.play", args, "version");
					ctx.bus.emit("build:play", { version });
					return { status: "completed" as const, version };
				},
			}),
		);

		return () => {
			for (const cleanup of cleanups.slice().reverse()) cleanup();
		};
	},
};

export const EDGE_DRAWER_EVENT = "forgeax:edge-drawer";

type EdgeDrawerAction = "open" | "toggle" | "close";

function dispatchEdgeDrawer(action: EdgeDrawerAction, id?: string): void {
	window.dispatchEvent(
		new CustomEvent(EDGE_DRAWER_EVENT, { detail: { action, id } }),
	);
}

export const chromeDrawerExtension: AppExtension = {
	id: "chrome.drawer",
	version: "2.0.0",
	requires: ["commands"],
	setup(ctx) {
		const cleanups: Array<() => void> = [];
		const idOf = (args: unknown): string | undefined =>
			(args as { id?: string })?.id;

		cleanups.push(
			ctx.registerCommand({
				id: "app.drawer.toggle",
				title: "Toggle a footer bottom-edge panel by id",
				execute: (args) => {
					const id = idOf(args);
					if (!id) throw new Error("app.drawer.toggle: missing { id }");
					dispatchEdgeDrawer("toggle", id);
					return { status: "completed" as const };
				},
			}),
		);

		cleanups.push(
			ctx.registerCommand({
				id: "app.drawer.open",
				title: "Open (expand) a footer bottom-edge panel by id",
				execute: (args) => {
					const id = idOf(args);
					if (!id) throw new Error("app.drawer.open: missing { id }");
					dispatchEdgeDrawer("open", id);
					return { status: "completed" as const };
				},
			}),
		);

		cleanups.push(
			ctx.registerCommand({
				id: "app.drawer.close",
				title: "Collapse the footer bottom-edge drawer",
				execute: () => {
					dispatchEdgeDrawer("close");
					return { status: "completed" as const };
				},
			}),
		);

		return () => {
			for (const c of cleanups.reverse()) c();
		};
	},
};

export const panelsChatExtension: AppExtension = {
	id: "panels.chat",
	version: "1.0.0",
	requires: ["commands"],
	setup(ctx) {
		const cleanups: Array<() => void> = [];
		cleanups.push(
			ctx.registerCommand({
				id: "app.chat.insertPill",
				title: "Insert reference pill into chat composer",
				execute: (args) => {
					const p = args as { pill?: PillPayload } | undefined;
					if (!p?.pill)
						throw new Error("app.chat.insertPill: missing { pill }");
					requestComposerInsert(p.pill);
					return { status: "completed" as const };
				},
			}),
		);
		// Public callers use commands; Chat builds the reference payload and the
		// product queue owns delivery to the composer.
		cleanups.push(
			ctx.registerCommand({
				id: "app.chat.referenceAsset",
				title: "Reference an asset in the chat composer",
				execute: (args) => {
					const a = args as
						| {
								guid?: string;
								name?: string;
								assetKind?: string;
								packPath?: string;
						  }
						| undefined;
					if (!a?.guid)
						throw new Error("app.chat.referenceAsset: missing { guid }");
					requestComposerInsert(
						buildAssetPill({
							guid: a.guid,
							...(a.name ? { name: a.name } : {}),
							...(a.assetKind ? { assetKind: a.assetKind } : {}),
							...(a.packPath ? { packPath: a.packPath } : {}),
						}),
					);
					return { status: "completed" as const };
				},
			}),
		);
		return () => {
			for (const c of cleanups) c();
		};
	},
};

export interface ObservabilityApi {
	readonly consoleLog: readonly ConsoleEntry[];
	pushConsole(entry: ConsoleEntry): void;
	clearConsole(): void;
	readonly networkLog: readonly NetworkEntry[];
	pushNetwork(entry: NetworkEntry): void;
	clearNetwork(): void;
	readonly telemetry: readonly TelemetryRecord[];
	pushTelemetry(records: TelemetryRecord[]): void;
	clearTelemetry(): void;
}

export const observabilityExtension: AppExtension = {
	id: "observability",
	version: "1.0.0",
	provides: ["observability"],
	setup(ctx) {
		const cap: ObservabilityApi = {
			get consoleLog() {
				return useShellStore.getState().consoleLog;
			},
			pushConsole: (e) => useShellStore.getState().pushConsole(e),
			clearConsole: () => useShellStore.getState().clearConsole(),
			get networkLog() {
				return useShellStore.getState().networkLog;
			},
			pushNetwork: (e) => useShellStore.getState().pushNetwork(e),
			clearNetwork: () => useShellStore.getState().clearNetwork(),
			get telemetry() {
				return useShellStore.getState().telemetry;
			},
			pushTelemetry: (rs) => useShellStore.getState().pushTelemetry(rs),
			clearTelemetry: () => useShellStore.getState().clearTelemetry(),
		};
		ctx.host.extend("observability", cap);
	},
};

export const sessionClientExtension: AppExtension = {
	id: "session-client",
	version: "1.0.0",
	provides: ["session"],
	setup(ctx) {
		const client = sessionClientRuntime.read();
		if (!client) {
			ctx.log.info(
				"[session-client] no client configured — host.session skipped (studio-only capability)",
			);
			return;
		}
		ctx.host.extend("session", {
			// The client is a setup snapshot; session state follows the live store.
			client,
			get tabs() {
				return useShellStore.getState().tabs;
			},
			get activeSid() {
				return useShellStore.getState().activeSid;
			},
			get activeGameSlug() {
				return useShellStore.getState().activeGameSlug;
			},
			switchToSession: (sid: string) =>
				useShellStore.getState().switchToSession(sid),
			createSession: (opts?: Parameters<AppState["createNewSession"]>[0]) =>
				useShellStore.getState().createNewSession(opts),
			closeSession: (sid: string) => useShellStore.getState().closeSession(sid),
			renameTab: (sid: string, name: string) =>
				useShellStore.getState().renameTab(sid, name),
			refreshSessions: () => useShellStore.getState().refreshSessions(),
			setActiveGame: async (slug: string) => {
				await useShellStore.getState().setActiveGame(slug);
			},
		});
	},
};

export const studioDomainClientsExtension: AppExtension = {
	id: "studio-domain-clients",
	version: "1.0.0",
	provides: ["agentCatalog", "projects", "builds"],
	setup(ctx) {
		const clients = studioDomainClientRuntime.read();
		if (!clients) {
			ctx.log.info(
				"[studio-domain-clients] no clients configured; standalone hosts keep domain capabilities absent",
			);
			return;
		}
		ctx.host.extend("agentCatalog", { client: clients.agents });
		ctx.host.extend("projects", { client: clients.projects });
		ctx.host.extend("builds", { client: clients.builds });
	},
};
