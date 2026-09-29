import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { Window } from "happy-dom";
import { afterEach, beforeAll, expect, test } from "vitest";
import { runIsolatedViteProbe } from "./helpers/isolated-vite-probe";

let code: string;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
const settle = async () => {
	for (let i = 0; i < 30; i++) await Promise.resolve();
};

beforeAll(async () => {
	code = JSON.parse(
		await runIsolatedViteProbe(
			[
				process.execPath,
				"--experimental-strip-types",
				resolve(import.meta.dirname, "fixtures/product-native-menu-build.ts"),
			],
			45_000,
		),
	);
}, 50_000);

function fixture(desktop: boolean) {
	const window = new Window({ url: "http://localhost:18920" });
	cleanup.push(() => window.happyDOM.close());
	if (desktop) Object.assign(window, { __TAURI_INTERNALS__: {} });
	let listener: ((event: { payload: { id: string } }) => void) | undefined;
	const native = {
		listens: 0,
		calls: [] as unknown[][],
		cleanups: 0,
		reads: 0,
		projects: async () => {
			native.reads++;
			return {
				games: [{ slug: "recent-game", name: "Recent Game", mtime: 3 }],
			};
		},
		publish: async (...args: unknown[]) => {
			native.calls.push(args);
		},
		listen: async (event: string, next: typeof listener) => {
			expect(event).toBe("menu:invoke");
			native.listens++;
			listener = next;
			return () => {
				native.cleanups++;
			};
		},
		click: (id: string) => listener?.({ payload: { id } }),
	};
	const runtime = runInNewContext(`${code}\nProductNativeMenu`, {
		window,
		document: window.document,
		navigator: window.navigator,
		localStorage: window.localStorage,
		sessionStorage: window.sessionStorage,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		CustomEvent: window.CustomEvent,
		crypto,
		URL,
		URLSearchParams,
		Response,
		Headers,
		Request,
		AbortController,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		queueMicrotask,
		fetch: async () => Response.json({ items: [], generation: 1 }),
		native,
		console,
		process: { env: { NODE_ENV: "production" } },
	});
	const { host, control } = runtime.createAppHost();
	cleanup.push(() => control.dispose());
	return { window, native, runtime, host };
}

test("web product creates no native subscriptions, menu writes or project warming", async () => {
	const { native, runtime, host } = fixture(false);
	cleanup.push(runtime.mount({ host }));
	await settle();
	expect(native.listens).toBe(0);
	expect(native.reads).toBe(0);
	expect(native.calls).toEqual([]);
});

test("desktop product shares the recent-project cache, publishes live locale and releases retained clicks", async () => {
	const { native, runtime, host } = fixture(true);
	const commands: unknown[] = [];
	host.commands.register({
		id: "open",
		title: "Open",
		execute: (args: unknown) => {
			commands.push(args);
		},
	});
	host.menus.register({
		id: "recent",
		menu: "file",
		group: "file",
		groupOrder: 10,
		order: 1,
		label: "Recent",
		dynamicChildren: () =>
			runtime.getRecentGames().map((game: { slug: string; name: string }) => ({
				id: game.slug,
				menu: "file",
				group: "file",
				groupOrder: 10,
				order: 1,
				label: game.name,
				commandId: "open",
				args: game.slug,
			})),
	});
	expect(runtime.sameWarmer).toBe(true);
	expect(runtime.getRecentGames()).toEqual(
		runtime.ideRecentProjectsRuntime.read(),
	);
	const unmount = runtime.mount({ host });
	cleanup.push(unmount);
	await settle();
	expect(native.listens).toBe(1);
	expect(runtime.ideRecentProjectsRuntime.getRevision()).toBe(1);
	const [command, args] = native.calls.at(-1)! as [
		string,
		{ payload: Array<{ menu: string; title: string; items: any[] }> },
	];
	expect(command).toBe("set_app_menu");
	expect(args.payload.map((menu) => menu.menu)).toEqual([
		"brand",
		"file",
		"edit",
		"window",
		"build",
		"select",
		"help",
		"publish",
	]);
	expect(
		args.payload.find((menu) => menu.menu === "file")!.items[0].children[0].id,
	).toBe("recent-game");
	native.click("recent-game");
	await settle();
	expect(commands).toEqual(["recent-game"]);
	runtime.changeLanguage("zh");
	await settle();
	const latest = native.calls.at(-1)![1] as typeof args;
	expect(latest.payload.find((menu) => menu.menu === "file")!.title).toBe(
		"文件",
	);
	unmount();
	expect(native.cleanups).toBe(1);
	const pushes = native.calls.length;
	native.click("recent-game");
	runtime.changeLanguage("en");
	await settle();
	expect(commands).toEqual(["recent-game"]);
	expect(native.calls.length).toBe(pushes);
});

test("desktop unmount fences a late listener and prevents warming or publishing", async () => {
	const { native, runtime, host } = fixture(true);
	let finish!: (cleanup: () => void) => void;
	native.listen = () =>
		new Promise((resolve) => {
			finish = resolve;
		});
	const unmount = runtime.mount({ host });
	await settle();
	unmount();
	finish(() => {
		native.cleanups++;
	});
	await settle();
	expect(native.cleanups).toBe(1);
	expect(native.reads).toBe(0);
	expect(native.calls).toEqual([]);
});
