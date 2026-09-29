import { ExtensionCleanupDeferredError } from "@forgeax/extension-platform/extensions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() =>
	vi.stubGlobal("window", { location: { href: "http://studio.test/" } }),
);
afterEach(() => vi.unstubAllGlobals());

import type { ExtensionCatalogInfo as ExtensionInfo } from "../src/integration/rest-extension-catalog-client";
import {
	catalogExtensionItems,
	createCatalogPageExtensionRuntime as createRuntime,
	extensionPane,
	isIdeExtensionHostExtension,
	catalogPanelTypeRegistrations as registerPanels,
} from "../src/product/catalog-page-extensions";

const views = {
	ExtensionHostPanel: () => null,
};
const createCatalogPageExtensionRuntime = (
	options: Omit<Parameters<typeof createRuntime>[0], "views">,
) => createRuntime({ ...options, views });
const catalogPanelTypeRegistrations = (item: ExtensionInfo) =>
	registerPanels(item, views);

describe("catalogExtensionItems", () => {
	it("fails closed when a runtime response omits items", () => {
		expect(catalogExtensionItems({})).toEqual([]);
		expect(catalogExtensionItems(undefined)).toEqual([]);
	});

	it("preserves a validated extension list", () => {
		const items = [{ id: "example", version: "1", displayName: "Example" }];
		expect(catalogExtensionItems({ items })).toBe(items);
	});
});

describe("extensionPane", () => {
	it("only accepts runtime pane values carried by a Page placement", () => {
		expect(extensionPane({ pane: "left" })).toBe("left");
		expect(extensionPane({ pane: "center" })).toBe("center");
		expect(extensionPane({ pane: "right" })).toBeUndefined();
		expect(extensionPane()).toBeUndefined();
	});
});

describe("catalog registry lifecycle", () => {
	const item = (frontendUrl?: string): ExtensionInfo => ({
		id: "@forgeax-extension/counter",
		version: "1.0.0",
		kind: "extension",
		displayName: "Counter",
		...(frontendUrl
			? { frontendUrl, runtimeMode: "dev" as const }
			: { runtimeMode: "embedded" as const }),
		contributes: {
			panelTypes: [
				{
					id: "counter.content",
					runtime: "iframe",
					entry: "./dist/index.html",
				},
			],
			pages: [
				{
					id: "counter",
					title: "Counter",
					cardinality: "singleton",
					restorePolicy: "project",
					layout: {
						version: 2,
						root: { kind: "tabs", placements: ["content"], active: "content" },
					},
					layoutVersion: 2,
					panels: [
						{
							id: "content",
							panelType: { extension: "self", id: "counter.content" },
						},
					],
				},
			],
			activities: [
				{
					id: "counter.launcher",
					title: "Counter",
					pageType: { extension: "self", id: "counter" },
				},
			],
		},
	});

	it("registers and disposes Page, Panel, and Activity contributions as generation changes", async () => {
		const responses = [
			{
				kind: null,
				count: 1,
				generation: 1,
				items: [item("http://127.0.0.1:5173/")],
			},
			{ kind: null, count: 0, generation: 2, items: [] },
		];
		const events: string[] = [];
		const runtime = createCatalogPageExtensionRuntime({
			control: {
				contributePagePlatform(owner, contribution) {
					events.push(
						`add:${owner}:${contribution.pageTypes?.length}:${contribution.panelTypes?.length}:${contribution.activities?.length}`,
					);
					return () => {
						events.push(`remove:${owner}`);
					};
				},
			},
			overriddenIds: new Set(),
			load: async () => responses.shift()!,
		});
		await runtime.refresh();
		await runtime.refresh();
		await runtime.dispose();
		expect(events).toEqual([
			"add:@forgeax-extension/counter:1:1:1",
			"remove:@forgeax-extension/counter",
		]);
	});

	it("retains events at a cleanup barrier and never repeats retired cleanup", async () => {
		const previous = globalThis.WebSocket;
		let closed = 0;
		globalThis.WebSocket = class {
			addEventListener() {}
			close() {
				closed++;
			}
		} as unknown as typeof WebSocket;
		const calls: string[] = [];
		let blocked = true;
		const first = item();
		const last = { ...item(), id: "@forgeax-extension/last" };
		const runtime = createCatalogPageExtensionRuntime({
			control: {
				contributePagePlatform: (owner) => () => {
					calls.push(owner);
					if (owner === first.id && blocked)
						throw new ExtensionCleanupDeferredError();
				},
			},
			overriddenIds: new Set(),
			onError: () => {},
			load: async () => ({
				kind: null,
				count: 2,
				generation: 1,
				items: [first, last],
			}),
		});
		try {
			await runtime.start();
			await expect(runtime.dispose()).rejects.toBeInstanceOf(
				ExtensionCleanupDeferredError,
			);
			expect(closed).toBe(0);
			expect(calls).toEqual([last.id, first.id]);
			blocked = false;
			await Promise.all([runtime.dispose(), runtime.dispose()]);
			expect(calls).toEqual([last.id, first.id, first.id]);
			expect(closed).toBe(1);
		} finally {
			blocked = false;
			await runtime.dispose();
			globalThis.WebSocket = previous;
		}
	});

	it("retries explicit reconciliation deferral at the same generation without duplicate registration", async () => {
		let generation = 1;
		let blocked = true;
		let adds = 0;
		let removes = 0;
		const runtime = createCatalogPageExtensionRuntime({
			control: {
				contributePagePlatform: () => {
					adds++;
					return () => {
						if (blocked) throw new ExtensionCleanupDeferredError();
						removes++;
					};
				},
			},
			overriddenIds: new Set(),
			onError: () => {},
			load: async () => ({
				kind: null,
				count: generation === 1 ? 1 : 0,
				generation,
				items: generation === 1 ? [item()] : [],
			}),
		});
		await runtime.refresh();
		generation = 2;
		await runtime.refresh();
		expect(adds).toBe(1);
		expect(removes).toBe(0);
		blocked = false;
		await runtime.refresh();
		expect(removes).toBe(1);
		await runtime.dispose();
		expect(removes).toBe(1);
	});

	it("isolates ordinary cleanup and error-sink failures without retrying partial teardown", async () => {
		let calls = 0;
		const runtime = createCatalogPageExtensionRuntime({
			control: {
				contributePagePlatform: () => () => {
					calls++;
					throw new Error("partial cleanup");
				},
			},
			overriddenIds: new Set(),
			onError: () => {
				throw new Error("sink");
			},
			load: async () => ({
				kind: null,
				count: 1,
				generation: 1,
				items: [item()],
			}),
		});
		await runtime.refresh();
		await runtime.dispose();
		await runtime.dispose();
		expect(calls).toBe(1);
	});

	it("keeps unchanged contributions mounted when only registry generation changes", async () => {
		const first = { ...item(), registryGeneration: 6 };
		const second = { ...item(), registryGeneration: 7 };
		const responses = [
			{ kind: null, count: 1, generation: 6, items: [first] },
			{ kind: null, count: 1, generation: 7, items: [second] },
		];
		const events: string[] = [];
		const runtime = createCatalogPageExtensionRuntime({
			control: {
				contributePagePlatform(owner) {
					events.push(`add:${owner}`);
					return () => {
						events.push(`remove:${owner}`);
					};
				},
			},
			overriddenIds: new Set(),
			load: async () => responses.shift()!,
		});
		await runtime.refresh();
		await runtime.refresh();
		expect(events).toEqual(["add:@forgeax-extension/counter"]);
		await runtime.dispose();
		expect(events).toEqual([
			"add:@forgeax-extension/counter",
			"remove:@forgeax-extension/counter",
		]);
	});

	it("replaces a dev shadow with the restored installed package at the next generation", async () => {
		const responses = [
			{
				kind: null,
				count: 1,
				generation: 4,
				items: [item("http://127.0.0.1:5173/")],
			},
			{ kind: null, count: 1, generation: 5, items: [item()] },
		];
		const events: string[] = [];
		const runtime = createCatalogPageExtensionRuntime({
			control: {
				contributePagePlatform(owner) {
					events.push(`add:${owner}`);
					return () => {
						events.push(`remove:${owner}`);
					};
				},
			},
			overriddenIds: new Set(),
			load: async () => responses.shift()!,
		});
		await runtime.refresh();
		await runtime.refresh();
		await runtime.dispose();
		expect(events).toEqual([
			"add:@forgeax-extension/counter",
			"remove:@forgeax-extension/counter",
			"add:@forgeax-extension/counter",
			"remove:@forgeax-extension/counter",
		]);
	});

	it("isolates an invalid extension so later catalog contributions still register", async () => {
		const broken = { ...item(), id: "@forgeax-extension/broken" };
		const events: string[] = [];
		const runtime = createCatalogPageExtensionRuntime({
			control: {
				contributePagePlatform(owner) {
					if (owner === broken.id) throw new Error("invalid page contribution");
					events.push(`add:${owner}`);
					return () => {
						events.push(`remove:${owner}`);
					};
				},
			},
			overriddenIds: new Set(),
			load: async () => ({
				kind: null,
				count: 2,
				generation: 1,
				items: [broken, item()],
			}),
			onError: (error, extensionId, phase) => {
				events.push(
					`error:${phase}:${extensionId}:${(error as Error).message}`,
				);
			},
		});

		await runtime.refresh();
		await runtime.dispose();

		expect(events).toEqual([
			"error:register:@forgeax-extension/broken:invalid page contribution",
			"add:@forgeax-extension/counter",
			"remove:@forgeax-extension/counter",
		]);
	});
});

describe("catalogPanelTypeRegistrations", () => {
	const base: ExtensionInfo = {
		id: "@demo/tool",
		version: "1.0.0",
		kind: "extension",
		displayName: "Demo Tool",
		contributes: {
			panelTypes: [{ id: "main", runtime: "inline", entry: "./index.js" }],
		},
	};

	it("maps standalone extensions to a complete plugin window target", () => {
		const [panel] = catalogPanelTypeRegistrations({
			...base,
			entry: { standalone: {} },
		});
		const createTarget = panel!.windowing!.createTarget;
		const target = createTarget({
			pageKey: {
				cardinality: "singleton",
				typeId: "@demo/tool#page/main",
			},
			placementId: "content",
			pageContext: {},
			initialProps: { pane: "left" },
		} as Parameters<typeof createTarget>[0]);

		expect(target).toEqual({
			surface: {
				kind: "plugin",
				id: "@demo/tool",
				pane: "left",
				instance: "page:v1:s:%40demo%2Ftool%23page%2Fmain::content",
			},
			title: "Demo Tool",
			width: 960,
			height: 720,
			dockBehavior: "keep-anchor",
		});
	});

	it("synthesizes panel types referenced by pages when panelTypes is omitted", () => {
		const panels = catalogPanelTypeRegistrations({
			id: "@forgeax-extension/video-game",
			version: "0.20.3",
			kind: "extension",
			displayName: "Video Game",
			runtimeMode: "embedded",
			contributes: {
				pages: [
					{
						id: "video-game",
						title: "Video Game",
						cardinality: "singleton",
						restorePolicy: "project",
						layoutVersion: 1,
						layout: {
							version: 1,
							root: {
								kind: "tabs",
								placements: ["content"],
								active: "content",
							},
						},
						panels: [
							{
								id: "content",
								panelType: { extension: "self", id: "video-game.content" },
							},
						],
					},
				],
			},
		});
		expect(panels).toHaveLength(1);
		expect(panels[0]?.id).toBe(
			"@forgeax-extension/video-game#panel/video-game.content",
		);
	});

	it("does not declare windowing for embedded-only extensions", () => {
		const [panel] = catalogPanelTypeRegistrations(base);
		expect(panel?.windowing).toBeUndefined();
	});

	it("keeps Extension Host pages dock-only without a detached renderer", () => {
		for (const id of [
			"@forgeax-extension/video-game",
			"@forgeax-extension/game-video",
		]) {
			const [panel] = catalogPanelTypeRegistrations({
				...base,
				id,
				entry: { standalone: {} },
			});
			expect(isIdeExtensionHostExtension(id)).toBe(true);
			expect(panel?.windowing).toBeUndefined();
		}
		expect(isIdeExtensionHostExtension("@demo/tool")).toBe(false);
	});
});

describe("catalog refresh ordering", () => {
	it("serializes pending reads and disposal, then ignores later refreshes", async () => {
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const order: string[] = [];
		let count = 0;
		const runtime = createCatalogPageExtensionRuntime({
			control: { contributePagePlatform: () => () => {} },
			overriddenIds: new Set(),
			load: async () => {
				const id = ++count;
				order.push(`read:${id}`);
				if (id === 1) await pending;
				order.push(`done:${id}`);
				return { kind: null, count: 0, generation: id, items: [] };
			},
		});
		const first = runtime.refresh();
		const second = runtime.refresh();
		const dispose = runtime.dispose();
		const after = runtime.refresh();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(order).toEqual(["read:1"]);
		release();
		await Promise.all([first, second, dispose, after]);
		expect(order).toEqual(["read:1", "done:1", "read:2", "done:2"]);
	});

	it("subscribes after initial read failure and retries through its uncached REST client", async () => {
		const previousFetch = globalThis.fetch;
		const previousEvents = globalThis.WebSocket;
		let listener!: () => void;
		let count = 0;
		let closed = 0;
		const urls: string[] = [];
		globalThis.fetch = (async (url: string) => {
			urls.push(url);
			if (++count === 1) throw new Error("offline");
			return Response.json({
				kind: null,
				count: 0,
				generation: count,
				items: [],
			});
		}) as typeof fetch;
		globalThis.WebSocket = class {
			constructor(url: URL) {
				urls.push(url.pathname + url.search);
			}
			set onmessage(next: (event: { data: string }) => void) {
				listener = () => next({ data: "{}" });
			}
			close() {
				closed++;
			}
		} as unknown as typeof WebSocket;
		const runtime = createCatalogPageExtensionRuntime({
			control: { contributePagePlatform: () => () => {} },
			overriddenIds: new Set(),
		});
		try {
			await runtime.start();
			listener();
			await runtime.refresh();
			expect(count).toBe(3);
			expect(urls).toEqual([
				"/api/extensions/list",
				"/ws/ui-events?topic=plugin.reloaded",
				"/api/extensions/list",
				"/api/extensions/list",
			]);
			await runtime.dispose();
			expect(closed).toBe(1);
		} finally {
			await runtime.dispose();
			globalThis.fetch = previousFetch;
			globalThis.WebSocket = previousEvents;
		}
	});
});
