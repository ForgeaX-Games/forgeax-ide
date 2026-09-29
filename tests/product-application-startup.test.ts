import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { Window } from "happy-dom";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { runIsolatedViteProbe } from "./helpers/isolated-vite-probe";

let code: string;
const windows: Window[] = [];
// This builds the real application graph before the behavioral assertions.
// A successful cold CI run already needs ~42s; it is not a 45s performance gate.
const startupBuildTimeoutMs = 120_000;
beforeAll(async () => {
	const output = await runIsolatedViteProbe(
		[
			"node",
			"--experimental-strip-types",
			resolve(import.meta.dirname, "fixtures/product-startup-build.ts"),
		],
		startupBuildTimeoutMs,
	);
	// Checker diagnostics share stdout with the fixture process.
	const bundles = output
		.split("\n")
		.filter((line) => line.startsWith("PRODUCT_STARTUP_BUNDLE:"));
	expect(bundles).toHaveLength(1);
	code = JSON.parse(bundles[0].slice("PRODUCT_STARTUP_BUNDLE:".length));
}, startupBuildTimeoutMs + 5_000);
afterEach(async () => {
	await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()));
});

function fixture(
	items: unknown[] = [],
	request?: (input: unknown, init?: RequestInit) => Promise<Response>,
) {
	const window = new Window({ url: "http://localhost:18920" });
	// Most shell assertions exercise a returning user. First-run cases clear this state.
	window.localStorage.setItem(
		"forgeax.onboarding.v2",
		JSON.stringify({
			v: 2,
			phase: "done",
			done: { tour: true, firstChat: true },
		}),
	);
	windows.push(window);
	const frames: Array<() => void> = [];
	window.requestAnimationFrame = (callback) => {
		frames.push(() => callback(0));
		return setImmediate(() => {});
	};
	let closed = 0;
	const lifecycle: string[] = [];
	const warnings: string[] = [];
	const errors: unknown[][] = [];
	const runtime = runInNewContext(`${code}\nProductStartup`, {
		window,
		self: window,
		document: window.document,
		navigator: window.navigator,
		location: window.location,
		localStorage: window.localStorage,
		sessionStorage: window.sessionStorage,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		HTMLInputElement: window.HTMLInputElement,
		HTMLFormElement: window.HTMLFormElement,
		HTMLSelectElement: window.HTMLSelectElement,
		DocumentFragment: window.DocumentFragment,
		getComputedStyle: window.getComputedStyle.bind(window),
		HTMLTextAreaElement: window.HTMLTextAreaElement,
		Node: window.Node,
		Range: window.Range,
		customElements: window.customElements,
		Document: window.Document,
		ShadowRoot: window.ShadowRoot,
		CSSStyleSheet: window.CSSStyleSheet,
		HTMLCanvasElement: window.HTMLCanvasElement,
		HTMLImageElement: window.HTMLImageElement,
		Image: window.Image,
		ResizeObserver: window.ResizeObserver,
		MutationObserver: window.MutationObserver,
		SVGElement: window.SVGElement,
		Event: window.Event,
		EventTarget: window.EventTarget,
		CustomEvent: window.CustomEvent,
		Blob: window.Blob,
		File: window.File,
		performance: window.performance,
		crypto,
		URL,
		URLSearchParams,
		Response,
		Headers,
		Request,
		AbortController,
		TextEncoder,
		TextDecoder,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		queueMicrotask,
		fetch:
			request ??
			(async () =>
				Response.json({ items, count: items.length, generation: 1 })),
		WebSocket: class {
			close() {
				closed++;
				lifecycle.push("catalog");
			}
		},
		console: {
			...console,
			debug() {},
			info() {},
			warn(message: string) {
				warnings.push(message);
			},
			error(...args: unknown[]) {
				errors.push(args);
			},
		},
		process: { env: { NODE_ENV: "production" } },
	});
	return {
		window,
		runtime,
		frames,
		closed: () => closed,
		lifecycle,
		warnings,
		errors,
	};
}

function pageExtension(runtime: any, owner: string, controller?: unknown) {
	const page = runtime.qualifyContributionId(owner, "page", "main");
	const panel = runtime.qualifyContributionId(owner, "panel", "main");
	return {
		page,
		extension: {
			id: owner,
			version: "1",
			contributes: {
				panelTypes: [
					{ id: panel, runtime: { kind: "inline", render: () => null } },
				],
				pages: [
					{
						id: page,
						title: "Selected",
						cardinality: "singleton",
						layout: {
							version: 1,
							root: { kind: "tabs", placements: ["main"] },
						},
						panels: [{ id: "main", panelTypeId: panel }],
						createController: () => controller,
					},
				],
			},
		},
	};
}

test("real Vite consumers share renderer context identity, updates and root boundaries", () => {
	const { runtime, window } = fixture();
	expect(Object.values(runtime.rendererContextIdentity)).toEqual([
		true,
		true,
		true,
		true,
	]);
	const outer = { editorPanelIds: ["outer"] };
	const inner = { editorPanelIds: ["inner"] };
	let seen: unknown;
	let separate: unknown;
	const first = window.document.createElement("div");
	const second = window.document.createElement("div");
	window.document.body.append(first, second);
	const probe = runtime.createRendererProbe(first, (value: unknown) => {
		seen = value;
	});
	const independent = runtime.createRendererProbe(second, (value: unknown) => {
		separate = value;
	});
	try {
		probe.render(outer);
		expect(seen).toBe(outer);
		probe.render(inner);
		expect(seen).toBe(inner);
		probe.render(outer, true, false);
		expect(seen).toBe(outer);
		independent.render(undefined, false, false);
		expect(separate).toBe(runtime.sharedRendererDefaults);
		probe.render(outer, false, true, inner);
		expect(seen).toBe(inner);
		probe.render(outer);
		expect(seen).toBe(outer);
		probe.render(undefined);
		expect(seen).toBe(runtime.sharedRendererDefaults);
	} finally {
		probe.unmount();
		independent.unmount();
	}
});

test("builtin commands preserve text editing, dock reset, feedback and live clients", async () => {
	const { runtime, window } = fixture();
	const app = await runtime.startIdeApplication();
	const events: unknown[] = [];
	runtime.compatibilityChatWidth.setSize(500);
	const offReset = app.host.bus.on("dock:reset", () =>
		events.push(runtime.compatibilityChatWidth.getSnapshot()),
	);
	try {
		const input = window.document.createElement("input");
		input.value = "selected text";
		window.document.body.append(input);
		input.focus();
		input.setSelectionRange(2, 2);
		expect(await app.host.commands.execute("text.selectAll")).toEqual({
			status: "completed",
		});
		expect([input.selectionStart, input.selectionEnd]).toEqual([
			0,
			input.value.length,
		]);
		let copied = "";
		runtime.configureTextClipboard({
			readText: async () => "replacement",
			writeText: async (text: string) => {
				copied = text;
			},
		});
		expect(await app.host.commands.execute("text.copy")).toEqual({
			status: "completed",
		});
		expect(copied).toBe("selected text");
		expect(await app.host.commands.execute("text.paste")).toEqual({
			status: "completed",
		});
		expect(input.value).toBe("replacement");
		input.blur();
		expect(await app.host.commands.execute("text.selectAll")).toEqual({
			status: "rejected",
		});
		expect(await app.host.commands.execute("app.dock.reset")).toEqual({
			status: "completed",
		});
		expect(events).toEqual([500]);
		expect(runtime.compatibilityChatWidth.getSnapshot()).toBe(360);
		await app.host.commands.execute("feedback.open");
		expect(runtime.compatibilityFeedback.getState().open).toBe(true);
		await expect(
			app.host.commands.execute("session.reconnect"),
		).rejects.toThrow("no active session client");
		const calls: unknown[] = [];
		const client = {
			disconnectForgeaXWs() {
				calls.push(["disconnect", this === client]);
			},
			connectForgeaXWs(sid: string) {
				calls.push(["connect", sid, this === client]);
			},
		};
		runtime.configureProductSession(client);
		runtime.getIdeShellStore().setState({ activeSid: "current" });
		expect(await app.host.commands.execute("session.reconnect")).toEqual({
			status: "completed",
		});
		expect(calls).toEqual([
			["disconnect", true],
			["connect", "current", true],
		]);
		await expect(app.host.commands.execute("overlay.open", {})).rejects.toThrow(
			"missing { id }",
		);
		await app.host.commands.execute("overlay.open", {
			id: "settings",
			param: "models",
		});
		expect(runtime.getIdeShellStore().getState()).toMatchObject({
			activeOverlay: "settings",
			overlayParam: "models",
		});
		await app.host.commands.execute("overlay.close");
		expect(runtime.getIdeShellStore().getState().activeOverlay).toBeNull();
		expect(await app.host.commands.execute("game.pick", { slug: "" })).toEqual({
			status: "rejected",
		});
	} finally {
		offReset();
		await app.dispose();
	}
	for (const id of [
		"text.copy",
		"app.dock.reset",
		"feedback.open",
		"session.reconnect",
		"overlay.open",
	])
		expect(app.host.commands.get(id)).toBeUndefined();
});

test("builtin external URL command preserves validation, desktop opener and browser fallback", async () => {
	const { runtime, window } = fixture();
	const app = await runtime.startIdeApplication();
	const browser: unknown[] = [];
	const native: unknown[] = [];
	window.open = ((...args: unknown[]) => {
		browser.push(args);
		return null;
	}) as typeof window.open;
	try {
		await expect(app.host.commands.execute("app.open_url", {})).rejects.toThrow(
			"missing { url }",
		);
		await expect(
			app.host.commands.execute("app.open_url", { url: "file:///local" }),
		).rejects.toThrow("only http(s)");
		await app.host.commands.execute("app.open_url", {
			url: "  https://example.com/web  ",
		});
		expect(browser).toEqual([
			["https://example.com/web", "_blank", "noopener"],
		]);
		(window as any).__TAURI_INTERNALS__ = {
			invoke: async (...args: unknown[]) => {
				native.push(args);
			},
		};
		await app.host.commands.execute("app.open_url", {
			url: "https://example.com/native",
		});
		expect((native[0] as unknown[])[0]).toBe("plugin:shell|open");
		expect((native[0] as unknown[])[1]).toMatchObject({
			path: "https://example.com/native",
		});
		expect(browser).toHaveLength(1);
		(window as any).__TAURI_INTERNALS__.invoke = async () => {
			throw new Error("not permitted");
		};
		await app.host.commands.execute("app.open_url", {
			url: "https://example.com/fallback",
		});
		expect(browser[1]).toEqual([
			"https://example.com/fallback",
			"_blank",
			"noopener",
		]);
	} finally {
		delete (window as any).__TAURI_INTERNALS__;
		await app.dispose();
	}
});

test("the product owns its status bar renderer and footer policy", async () => {
	const { runtime, window } = fixture();
	const app = await runtime.startIdeApplication();
	const element = window.document.createElement("div");
	window.document.body.append(element);
	const probe = runtime.createStatusBarProbe(element, app.host);
	const calls: unknown[] = [];
	const unregister = app.host.commands.register({
		id: "footer.probe",
		execute: (args: unknown) => calls.push(args),
	});
	try {
		expect(app.host.panels.slots.StatusBar).toBe(runtime.IdeStatusBar);
		const items: Record<string, any> = {};
		for (const [slot, count] of [
			["left", 6],
			["center", 3],
			["right", 7],
		] as const) {
			for (let index = 0; index < count; index++) {
				const id = `${slot}-${index}`;
				items[id] = {
					id,
					location: `statusbar.${slot}`,
					priority: count - index,
					item: { type: "text", text: id },
				};
			}
		}
		items["left-0"].item = {
			type: "button",
			label: "Run footer command",
			icon: "Activity",
			command: "footer.probe",
			args: { revision: 1 },
		};
		items.hidden = {
			id: "hidden",
			location: "statusbar.left",
			when: () => false,
			item: { type: "text", text: "hidden" },
		};
		probe.render({ ...app.host.panels, stripItems: items });
		const footer = element.querySelector(
			'.ide-status-bar[aria-label="forgeax status bar"]',
		);
		expect(footer).not.toBeNull();
		expect(footer!.getAttribute("data-tour-id")).toBe("footer");
		expect(footer!.getAttribute("data-fx-slot")).toBe("StatusBar");
		expect(footer!.querySelector("[data-fx-dock-bottom-host]")).not.toBeNull();
		for (const [slot, count, order] of [
			["left", 4, 4],
			["center", 2, 2],
			["right", 6, 3],
		] as const) {
			const group = footer!.querySelector(`.sb-slot-${slot}`)!;
			expect(group.querySelectorAll("[data-item-id]").length).toBe(count);
			expect(group.getAttribute("data-slot-order")).toBe(String(order));
		}
		expect(footer!.querySelector('[data-item-id="hidden"]')).toBeNull();
		expect(
			footer!.querySelector('[aria-label="2 hidden status items, rotating"]'),
		).not.toBeNull();
		const button = footer!.querySelector("button")!;
		expect(
			button.querySelector("svg.sb-chip-icon")?.getAttribute("width"),
		).toBe("12");
		button.click();
		expect(calls).toEqual([{ revision: 1 }]);
		probe.render({
			...app.host.panels,
			stripItems: {
				...items,
				"left-0": {
					...items["left-0"],
					item: { ...items["left-0"].item, args: { revision: 2 } },
				},
			},
		});
		expect(footer!.querySelector("button")).toBe(button);
		button.click();
		expect(calls).toEqual([{ revision: 1 }, { revision: 2 }]);
	} finally {
		probe.unmount();
		unregister();
		await app.dispose();
		expect(element.childElementCount).toBe(0);
		element.remove();
	}
});

test("pulse chips share one request and retain Settings deep-link behavior", async () => {
	let capture = false;
	const pending: Array<{
		signal: AbortSignal;
		resolve: (response: Response) => void;
	}> = [];
	const { runtime, window } = fixture([], async (_input, init) => {
		if (!capture || String(_input) !== "/api/extensions/list")
			return Response.json({ items: [], count: 0, generation: 1 });
		return new Promise<Response>((resolve) => {
			pending.push({ signal: init!.signal as AbortSignal, resolve });
		});
	});
	const app = await runtime.startIdeApplication();
	const element = window.document.createElement("div");
	window.document.body.append(element);
	let probe = runtime.createStatusBarProbe(element, app.host);
	const stripItems = Object.fromEntries(
		Object.entries(app.host.panels.stripItems).filter(([id]) =>
			id.startsWith("bus."),
		),
	);
	try {
		for (const item of runtime.idePulseStatusItems) {
			expect((stripItems[item.id] as any).item.render).toBe(item.item.render);
		}
		capture = true;
		probe.render({ ...app.host.panels, stripItems });
		expect(pending).toHaveLength(1);
		expect(
			[...element.querySelectorAll(".sb-chip-value")].map(
				(node) => node.textContent,
			),
		).toEqual(["—", "—", "—", "—"]);
		pending[0].resolve(
			Response.json({
				items: [
					{ id: "model.one", kind: "model-binding" },
					{ id: "skill.one", kind: "skill" },
					{ id: "skill.two", kind: "skill" },
					{ id: "tool.one", kind: "tool" },
					{ id: "other", kind: "other" },
				],
			}),
		);
		for (
			let i = 0;
			i < 50 && element.querySelector(".sb-chip-value")?.textContent !== "1";
			i++
		)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(
			[...element.querySelectorAll(".sb-chip-value")].map(
				(node) => node.textContent,
			),
		).toEqual(["1", "2", "1", "0"]);
		const skill = element
			.querySelector('[data-item-id="bus.skill"]')!
			.querySelector("button")!;
		expect(skill.title).toContain("skill.one");
		expect(skill.title).toContain("skill.two");
		for (const [id, kind] of [
			["mb", "model-binding"],
			["skill", "skill"],
			["tool", "tool"],
			["agent", "agent"],
		]) {
			element
				.querySelector(`[data-item-id="bus.${id}"]`)!
				.querySelector("button")!
				.click();
			expect(runtime.getIdeShellStore().getState().activeOverlay).toBe(
				"settings",
			);
			expect(runtime.peekTopic("bus:filter-kind")).toBe(kind);
		}
		const englishTitle = skill.title;
		runtime.changeProductLanguage("zh");
		for (let i = 0; i < 50 && skill.title === englishTitle; i++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(skill.title).not.toBe(englishTitle);
		expect(skill.title).toContain("skill.one");
		probe.unmount();
		probe = runtime.createStatusBarProbe(element, app.host);
		probe.render({ ...app.host.panels, stripItems });
		expect(pending).toHaveLength(2);
		pending[1].resolve(new Response(null, { status: 503 }));
		for (
			let i = 0;
			i < 50 && element.querySelector(".sb-chip-value")?.textContent !== "!";
			i++
		)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(
			[...element.querySelectorAll(".sb-chip-value")].map(
				(node) => node.textContent,
			),
		).toEqual(["!", "!", "!", "!"]);
	} finally {
		probe.unmount();
		expect(element.childElementCount).toBe(0);
		await app.dispose();
		element.remove();
	}
});

test("pulse requests stop with the last subscriber and fence disposed responses", async () => {
	let capture = false;
	const pending: Array<{
		signal: AbortSignal;
		resolve: (response: Response) => void;
	}> = [];
	const { runtime, window } = fixture([], async (_input, init) => {
		if (!capture || String(_input) !== "/api/extensions/list")
			return Response.json({ items: [], count: 0, generation: 1 });
		return new Promise<Response>((resolve) =>
			pending.push({ signal: init!.signal as AbortSignal, resolve }),
		);
	});
	const app = await runtime.startIdeApplication();
	const first = window.document.createElement("div");
	const second = window.document.createElement("div");
	window.document.body.append(first, second);
	const panels = {
		...app.host.panels,
		stripItems: Object.fromEntries(
			Object.entries(app.host.panels.stripItems).filter(([id]) =>
				id.startsWith("bus."),
			),
		),
	};
	const a = runtime.createStatusBarProbe(first, app.host);
	const b = runtime.createStatusBarProbe(second, app.host);
	let stopA = a.unmount;
	let stopB = b.unmount;
	let stopC = () => {};
	try {
		capture = true;
		a.render(panels);
		b.render(panels);
		expect(pending).toHaveLength(1);
		stopA();
		stopA = () => {};
		expect(pending[0].signal.aborted).toBe(false);
		stopB();
		stopB = () => {};
		expect(pending[0].signal.aborted).toBe(true);
		const c = runtime.createStatusBarProbe(first, app.host);
		stopC = c.unmount;
		c.render(panels);
		expect(pending).toHaveLength(2);
		pending[1].resolve(
			Response.json({ items: [{ id: "current", kind: "agent" }] }),
		);
		const value = () =>
			first.querySelector('[data-item-id="bus.agent"] .sb-chip-value')
				?.textContent;
		for (let i = 0; i < 50 && value() !== "1"; i++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(value()).toBe("1");
		pending[0].resolve(Response.json({ items: [] }));
		await new Promise((resolve) => setTimeout(resolve, 20));
		c.render(panels);
		expect(value()).toBe("1");
	} finally {
		stopA();
		stopB();
		stopC();
		await app.dispose();
		first.remove();
		second.remove();
	}
});

test("connect model prompt preserves the chat event, dismissals, locale and provider links", async () => {
	const { runtime, window } = fixture();
	const app = await runtime.startIdeApplication();
	const element = window.document.createElement("div");
	window.document.body.append(element);
	const eventType = runtime.chatEvents.openConnectPrompt;
	const add = window.addEventListener.bind(window);
	const remove = window.removeEventListener.bind(window);
	let subscriptions = 0;
	window.addEventListener = ((type: string, listener: any, options: any) => {
		if (type === eventType) subscriptions++;
		return add(type, listener, options);
	}) as typeof window.addEventListener;
	window.removeEventListener = ((type: string, listener: any) => {
		if (type === eventType) subscriptions--;
		return remove(type, listener);
	}) as typeof window.removeEventListener;
	let unmount = runtime.mountProductConnectPrompt(element);
	const show = () =>
		runtime.flushProductUpdates(() => {
			window.dispatchEvent(new window.CustomEvent(eventType));
		});
	const dialog = () => element.querySelector('[role="dialog"]');
	try {
		expect(subscriptions).toBe(1);
		expect(dialog()).toBeNull();
		show();
		expect(dialog()?.getAttribute("aria-modal")).toBe("true");
		expect(element.querySelector("h2")?.textContent).toBe(
			"Connect a model to send",
		);
		runtime.flushProductUpdates(() =>
			element
				.querySelector(".fx-ob-modal")!
				.dispatchEvent(new window.MouseEvent("click", { bubbles: true })),
		);
		expect(dialog()).not.toBeNull();
		runtime.flushProductUpdates(() =>
			dialog()!.dispatchEvent(
				new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			),
		);
		expect(dialog()).toBeNull();
		show();
		runtime.flushProductUpdates(() =>
			dialog()!.dispatchEvent(
				new window.MouseEvent("click", { bubbles: true }),
			),
		);
		expect(dialog()).toBeNull();
		show();
		runtime.flushProductUpdates(() =>
			element.querySelectorAll("button")[2].click(),
		);
		expect(dialog()).toBeNull();
		for (const index of [0, 1]) {
			runtime.getIdeShellStore().getState().closeOverlay();
			show();
			runtime.flushProductUpdates(() =>
				element.querySelectorAll("button")[index].click(),
			);
			expect(dialog()).toBeNull();
			expect(runtime.getIdeShellStore().getState().activeOverlay).toBe(
				"settings",
			);
			expect(runtime.getIdeShellStore().getState().overlayParam).toBe(
				"providers",
			);
		}
		show();
		const english = element.querySelector("h2")!.textContent;
		runtime.flushProductUpdates(() => runtime.changeProductLanguage("zh"));
		expect(element.querySelector("h2")!.textContent).not.toBe(english);
		unmount();
		expect(subscriptions).toBe(0);
		show();
		expect(dialog()).toBeNull();
		unmount = runtime.mountProductConnectPrompt(element);
		expect(subscriptions).toBe(1);
		expect(dialog()).toBeNull();
		show();
		expect(dialog()).not.toBeNull();
	} finally {
		unmount();
		expect(subscriptions).toBe(0);
		await app.dispose();
		element.remove();
	}
});

function onboardingButton(window: Window, label: RegExp) {
	const button = [
		...window.document.querySelectorAll(".fx-ob-overlay button"),
	].find((item) => label.test(item.textContent.trim()));
	if (!(button instanceof window.HTMLButtonElement))
		throw new Error(`Missing onboarding button: ${label}`);
	return button;
}

test.each([
	{ kind: "empty", storageAvailable: true },
	{ kind: "template", storageAvailable: true },
	{ kind: "empty", storageAvailable: false },
])(
	"first-run setup creates $kind games with storage=$storageAvailable before entering the IDE",
	async ({ kind, storageAvailable }) => {
		const { runtime, window, errors } = fixture([], async (input) => {
			if (String(input).includes("/api/projects/templates"))
				return Response.json({
					templates: [{ slug: "arcade", name: "Arcade demo" }],
				});
			if (String(input).includes("/api/cli/health"))
				return Response.json({ providers: [] });
			return Response.json({ items: [], count: 0, generation: 1 });
		});
		window.localStorage.clear();
		if (!storageAvailable) {
			const setItem = window.localStorage.setItem.bind(window.localStorage);
			Object.defineProperty(window.localStorage, "setItem", {
				value: (key: string, value: string) => {
					if (key.startsWith("forgeax.onboarding"))
						throw new Error("storage unavailable");
					setItem(key, value);
				},
			});
		}
		const created: unknown[] = [];
		runtime.configureProductDomains({
			projects: {
				listProjects: async () => ({ games: [] }),
				createProject: async (input: unknown) => {
					created.push(input);
					return { ok: true, slug: "untitled-1" };
				},
			},
		});
		const app = await runtime.startIdeApplication({}, { locale: "en" });
		const store = runtime.getIdeShellStore();
		const selected: string[] = [];
		let finishSelection = () => {};
		const selection = new Promise<void>((resolve) => {
			finishSelection = resolve;
		});
		store.setState({
			setActiveGame: async (slug: string) => {
				selected.push(slug);
				await selection;
				store.setState({ activeGameSlug: slug });
				return {};
			},
		});
		const element = window.document.createElement("div");
		window.document.body.append(element);
		let unmount = () => {};
		try {
			unmount = runtime.mountProductShell(element, app);
			expect(errors).toEqual([]);
			expect(element.querySelector(".studio-shell")).toBeNull();
			expect(element.textContent).toContain("Connect a model");
			expect(
				element.querySelector('input[placeholder="API Key"]'),
			).not.toBeNull();
			runtime.flushProductUpdates(() =>
				onboardingButton(window, /^Next$/).click(),
			);
			expect(element.textContent).toContain(
				"Please choose a connection method",
			);
			runtime.flushProductUpdates(() =>
				onboardingButton(window, /^Skip setup$/).click(),
			);
			expect(element.textContent).toContain("Choose your game");
			expect(element.querySelector(".studio-shell")).toBeNull();
			if (kind === "template") {
				runtime.flushProductUpdates(() =>
					onboardingButton(window, /^Choose template$/).click(),
				);
				await vi.waitFor(() =>
					expect(element.textContent).toContain("Arcade demo"),
				);
				runtime.flushProductUpdates(() =>
					onboardingButton(window, /Arcade demo/).click(),
				);
				runtime.flushProductUpdates(() =>
					onboardingButton(window, /^Confirm$/).click(),
				);
			} else {
				runtime.flushProductUpdates(() =>
					onboardingButton(window, /^Create$/).click(),
				);
			}
			await vi.waitFor(() => expect(selected).toEqual(["untitled-1"]));
			expect(created).toEqual([
				{
					slug: "untitled-1",
					name: "untitled-1",
					brief: "",
					...(kind === "template" ? { template: "arcade" } : {}),
				},
			]);
			// A materialized game is not enough: setup must wait for the active-game write.
			expect(element.querySelector(".studio-shell")).toBeNull();
			finishSelection();
			await vi.waitFor(() =>
				expect(element.querySelector(".studio-shell")).not.toBeNull(),
			);
			expect(element.querySelector(".fx-ob-overlay")).toBeNull();
			expect(element.querySelector(".tour-root")).toBeNull();
			expect(store.getState().activeGameSlug).toBe("untitled-1");
			if (storageAvailable)
				expect(
					JSON.parse(window.localStorage.getItem("forgeax.onboarding.v2")!),
				).toMatchObject({
					phase: "done",
					done: { tour: true, firstChat: false },
				});
		} finally {
			finishSelection();
			unmount();
			await app.dispose();
			element.remove();
		}
	},
);

test("Help reopens setup for returning users and preserves the mounted editor", async () => {
	const { runtime, window } = fixture();
	runtime.configureProductDomains({
		projects: {
			listProjects: async () => ({
				games: [{ slug: "existing", name: "My existing game" }],
			}),
		},
	});
	const app = await runtime.startIdeApplication({}, { locale: "en" });
	const store = runtime.getIdeShellStore();
	const selected: string[] = [];
	store.setState({
		activeGameSlug: "existing",
		setActiveGame: async (slug: string) => {
			selected.push(slug);
			return {};
		},
	});
	const element = window.document.createElement("div");
	window.document.body.append(element);
	let unmount = () => {};
	try {
		unmount = runtime.mountProductShell(element, app);
		const shell = element.querySelector(".studio-shell");
		expect(shell).not.toBeNull();
		expect(element.querySelector(".fx-ob-overlay")).toBeNull();
		const menu = app.host.menus
			.snapshot("help")
			.find((item: { id: string }) => item.id === "help.onboarding");
		expect(menu).toMatchObject({
			label: "Getting Started…",
			commandId: "onboarding.open",
		});
		await app.host.commands.execute(menu.commandId);
		await vi.waitFor(() =>
			expect(element.textContent).toContain("Connect a model"),
		);
		expect(shell?.parentElement?.hasAttribute("hidden")).toBe(true);
		expect(element.querySelector(".studio-shell")).toBe(shell);
		expect(store.getState().activeGameSlug).toBe("existing");
		expect(selected).toEqual([]);
		runtime.flushProductUpdates(() =>
			onboardingButton(window, /^Skip setup$/).click(),
		);
		await vi.waitFor(() =>
			expect(element.textContent).toContain("My existing game"),
		);
		runtime.flushProductUpdates(() =>
			onboardingButton(window, /My existing game/).click(),
		);
		await vi.waitFor(() =>
			expect(element.querySelector(".fx-ob-overlay")).toBeNull(),
		);
		expect(selected).toEqual(["existing"]);
		expect(element.querySelector(".studio-shell")).toBe(shell);
		expect(shell?.parentElement?.hasAttribute("hidden")).toBe(false);
		expect(
			JSON.parse(window.localStorage.getItem("forgeax.onboarding.v2")!),
		).toEqual({
			v: 2,
			phase: "done",
			done: { tour: true, firstChat: true },
		});
		runtime.flushProductUpdates(() => runtime.changeProductLanguage("zh"));
		expect(
			app.host.menus
				.snapshot("help")
				.find((item: { id: string }) => item.id === "help.onboarding").label,
		).toBe("新手指引…");
	} finally {
		unmount();
		await app.dispose();
		element.remove();
	}
});

test("product shell observes layout and owns renderer fallback and cleanup", async () => {
	const { runtime, window } = fixture();
	const app = await runtime.startIdeApplication();
	const element = window.document.createElement("div");
	window.document.body.append(element);
	const subscribe = app.control.onPanelsChange.bind(app.control);
	let subscriptions = 0;
	app.control.onPanelsChange = (listener: () => void) => {
		subscriptions++;
		const stop = subscribe(listener);
		return () => {
			subscriptions--;
			stop();
		};
	};
	let unmount = () => {};
	const revocations: Array<() => void> = [];
	try {
		unmount = runtime.mountProductShell(element, app);
		expect(subscriptions).toBe(1);
		const shell = element.querySelector(".studio-shell")!;
		runtime.flushProductUpdates(() => {
			const state = runtime.getIdeShellStore().getState();
			state.setFullscreen(true);
			state.toggleSidebar();
			state.toggleChatpanel();
		});
		expect(shell.getAttribute("data-fullscreen")).toBe("1");
		expect(shell.getAttribute("data-sidebar-collapsed")).toBe("1");
		expect(shell.getAttribute("data-chatpanel-collapsed")).toBe("1");
		const Footer = () =>
			runtime.createElement(
				"div",
				{ "data-shell-footer-probe": "" },
				"custom footer",
			);
		let revokeFooter = () => {};
		runtime.flushProductUpdates(() => {
			revokeFooter = app.control.contributePanels("shell-test", {
				slots: { StatusBar: Footer },
			});
			revocations.push(revokeFooter);
		});
		const footer = element.querySelector("[data-shell-footer-probe]");
		expect(footer).not.toBeNull();
		runtime.flushProductUpdates(() => {
			revocations.push(
				app.control.contributePanels("shell-unrelated", {
					editorPanelIds: ["other"],
				}),
			);
		});
		expect(element.querySelector("[data-shell-footer-probe]")).toBe(footer);
		runtime.flushProductUpdates(() => {
			revokeFooter();
			revocations.push(
				app.control.contributePanels("shell-empty-footer", {
					slots: { StatusBar: undefined },
				}),
			);
		});
		expect(app.host.panels.slots.StatusBar).toBeUndefined();
		expect(
			element.querySelector('.ide-status-bar[data-fx-slot="StatusBar"]'),
		).not.toBeNull();
	} finally {
		unmount();
		expect(subscriptions).toBe(0);
		for (const revoke of revocations.reverse()) revoke();
		await app.dispose();
		element.remove();
	}
});

test("the product shell renders the registered IDE footer", async () => {
	const { runtime, window } = fixture();
	const app = await runtime.startIdeApplication();
	const element = window.document.createElement("div");
	window.document.body.append(element);
	let unmount = () => {};
	try {
		unmount = runtime.mountProductShell(element, app);
		expect(element.querySelectorAll('[data-fx-slot="StatusBar"]')).toHaveLength(
			1,
		);
		expect(
			element
				.querySelector('[data-fx-slot="StatusBar"]')
				?.classList.contains("ide-status-bar"),
		).toBe(true);
	} finally {
		unmount();
		await app.dispose();
		element.remove();
	}
});

test("viewport and footer contributions preserve metadata and the shared keep-alive anchor", async () => {
	const { runtime, window } = fixture();
	const app = await runtime.startIdeApplication();
	const element = window.document.createElement("div");
	window.document.body.append(element);
	let unmount = () => {};
	try {
		const viewport = app.host.panels.panels.viewport;
		expect(viewport).toMatchObject({
			title: "Viewport",
			order: 0,
			header: { visible: true, showTitle: false },
			content: { padding: "none", scroll: "none", tone: "tool" },
			dockChrome: { singleTab: "hideTitle" },
		});
		const items = Object.values(app.host.panels.stripItems) as any[];
		expect(
			items.find((item) => item.id === "forgeax-build-version"),
		).toMatchObject({ location: "statusbar.right", priority: 1000 });
		expect(
			items
				.filter((item) => item.location === "statusbar.left")
				.map((item) => item.id),
		).not.toContain("project-version");
		unmount = runtime.mountViewport(app.host, element);
		for (let i = 0; i < 50 && !runtime.viewportAnchor("edit"); i++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(runtime.viewportAnchor("edit")).toBe(
			element.querySelector('[data-surface-anchor="edit"]'),
		);
		expect(runtime.viewportAnchor("edit")).not.toBeNull();
		unmount();
		unmount = () => {};
		expect(runtime.viewportAnchor("edit")).toBeNull();
	} finally {
		unmount();
		await app.dispose();
		element.remove();
	}
});

for (const retainEntry of [false, true]) {
	test(`trajectory adopts the complete pre-start sequence with retained entry=${retainEntry}`, async () => {
		const { runtime } = fixture();
		runtime.compatibilityRecord({ id: "qa.before", source: "human" });
		const sequence = runtime.compatibilityTrajectory().entries[0].seq;
		runtime.compatibilityClear();
		if (retainEntry)
			runtime.compatibilityRecord({ id: "qa.retained", source: "ai" });
		const before = runtime.compatibilityTrajectory().entries;
		const app = await runtime.startIdeApplication();
		try {
			const product = runtime.getIdeTrajectoryRuntime();
			expect(product.read().entries).toEqual(before);
			if (retainEntry) expect(product.read().entries[0]).toBe(before[0]);
			runtime.compatibilityRecord({ id: "qa.after", source: "human" });
			expect(product.read().entries.at(-1).seq).toBe(
				sequence + (retainEntry ? 2 : 1),
			);
			expect(runtime.compatibilityTrajectory()).toEqual(product.read());
			expect((await runtime.captureFeedbackContext()).trajectory).toEqual(
				product.read().entries,
			);
		} finally {
			await app.dispose();
		}
	});
}

test("trajectory actions, snapshots and feedback share one history across disposal and restart", async () => {
	const { runtime, window } = fixture();
	const app = await runtime.startIdeApplication();
	const remove = runtime.registerAction({
		id: "qa.track",
		title: "Tracked action",
		capability: "write",
		run: () => ({ status: "completed" }),
	});
	try {
		for (let i = 0; i < 60; i++) {
			await runtime.dispatchAction(
				"qa.track",
				{ index: i },
				{ source: i % 2 ? "ai" : "human" },
			);
		}
		const history = runtime.compatibilityTrajectory();
		expect(history.total).toBe(60);
		expect(history.entries).toHaveLength(50);
		expect(history.entries[0].args).toEqual({ index: 10 });
		expect(history.entries[49]).toMatchObject({
			id: "qa.track",
			title: "Tracked action",
			capability: "write",
			source: "ai",
		});
		expect((await runtime.captureFeedbackContext()).trajectory).toEqual(
			history.entries,
		);
		expect(runtime.snapshotState()["ui.trajectory"]).toEqual(
			history.entries.slice(-20),
		);
		expect(
			(
				await runtime.dispatchAction(
					"trajectory.read",
					{ source: "human", limit: 3 },
					{ source: "ai" },
				)
			).stateDigest,
		).toEqual(runtime.compatibilityTrajectory({ source: "human", limit: 3 }));
		expect(runtime.compatibilityTrajectory().total).toBe(60);
		const previousSeq = history.entries[49].seq;
		expect(
			(await runtime.dispatchAction("trajectory.clear")).stateDigest,
		).toEqual({ cleared: 60 });
		await runtime.dispatchAction("qa.track");
		expect(runtime.compatibilityTrajectory().entries[0].seq).toBe(
			previousSeq + 1,
		);
		await app.dispose();
		expect(runtime.getAction("trajectory.read")).toBeUndefined();
		expect(runtime.getAction("trajectory.clear")).toBeUndefined();
		expect(runtime.snapshotState()["ui.trajectory"]).toBeUndefined();
		window.dispatchEvent(
			new window.CustomEvent(runtime.UI_ACTION_DISPATCH_EVENT, {
				detail: { id: "qa.track", source: "ai" },
			}),
		);
		expect(runtime.compatibilityTrajectory().total).toBe(1);
		const restarted = await runtime.startIdeApplication();
		try {
			await runtime.dispatchAction("qa.track");
			expect(runtime.compatibilityTrajectory().total).toBe(2);
			expect((await runtime.captureFeedbackContext()).trajectory).toEqual(
				runtime.compatibilityTrajectory().entries,
			);
		} finally {
			await restarted.dispose();
		}
	} finally {
		remove();
		await app.dispose();
	}
});

test("trajectory recording preserves its bounded, redacted and idempotent event contract", async () => {
	const { runtime, window } = fixture();
	const app = await runtime.startIdeApplication();
	const remove = runtime.registerAction({
		id: "qa.secret",
		title: "Secret action",
		capability: "credential",
		run: () => ({ status: "completed" }),
	});
	try {
		const stop = runtime.compatibilityStartRecording();
		expect(runtime.compatibilityStartRecording()).toBe(stop);
		await runtime.dispatchAction("qa.secret", { token: "credential-value" });
		expect(runtime.compatibilityTrajectory().entries[0].args).toEqual({
			redacted: true,
		});
		window.dispatchEvent(
			new window.CustomEvent(runtime.UI_ACTION_DISPATCH_EVENT, {
				detail: {
					id: "qa.large",
					source: "ai",
					args: { long: "x".repeat(121), nested: {}, array: [1, 2], scalar: 3 },
				},
			}),
		);
		expect(runtime.compatibilityTrajectory().entries[1].args).toEqual({
			long: "x".repeat(120) + "…",
			nested: "[object]",
			array: "[array:2]",
			scalar: 3,
		});
		for (let i = 0; i < 210; i++)
			runtime.compatibilityRecord({
				id: "qa.count",
				source: i % 2 ? "ai" : "human",
				args: { index: i },
			});
		const history = runtime.compatibilityTrajectory({ limit: 500 });
		expect(history.total).toBe(200);
		expect(history.entries).toHaveLength(200);
		expect(history.entries[0].args).toEqual({ index: 10 });
		expect(
			runtime
				.compatibilityTrajectory({ source: "ai", limit: 3 })
				.entries.map((entry: any) => entry.args.index),
		).toEqual([205, 207, 209]);
	} finally {
		remove();
		await app.dispose();
	}
});

test("builtin menus preserve live labels, recent projects, payloads and disposal", async () => {
	const { runtime } = fixture();
	let projects = [
		{ slug: "old", name: "Older", mtime: 1 },
		{ slug: "new", name: "Newer", mtime: 10 },
	];
	let unavailable = false;
	runtime.configureCompatibilityDomains({
		agents: {},
		builds: {},
		projects: {
			listProjects: async () => {
				if (unavailable) throw new Error("offline");
				return { games: projects };
			},
		},
	});
	const app = await runtime.startIdeApplication({}, { locale: "en" });
	try {
		const menus = app.host.menus;
		const recent = menus
			.snapshot("file")
			.find((item: any) => item.id === "file.openRecent");
		expect(recent.dynamicChildren()).toEqual([]);
		await runtime.warmApplicationMenus();
		expect(
			recent
				.dynamicChildren()
				.map((item: any) => [item.id, item.label, item.commandId, item.args]),
		).toEqual([
			["file.openRecent.new", "Newer", "game.pick", { slug: "new" }],
			["file.openRecent.old", "Older", "game.pick", { slug: "old" }],
		]);
		const originalLabel = recent.label;
		runtime.changeProductLanguage("zh");
		expect(recent.label).not.toBe(originalLabel);
		expect(recent.dynamicChildren()[0].label).toBe("Newer");
		unavailable = true;
		await runtime.warmApplicationMenus();
		expect(recent.dynamicChildren()).toHaveLength(2);
		unavailable = false;
		projects = [{ slug: "only", name: "", mtime: 20 }];
		await runtime.warmApplicationMenus();
		expect(recent.dynamicChildren()[0].label).toBe("only");
		const chat = menus
			.snapshot("window")
			.find((item: any) => item.id === "window.chat");
		runtime.getIdeShellStore().setState({ chatpanelCollapsed: true });
		expect(chat.checked()).toBe(false);
		runtime.getIdeShellStore().setState({ chatpanelCollapsed: false });
		expect(chat.checked()).toBe(true);
		expect(
			menus.snapshot("file").find((item: any) => item.id === "file.closeGame")
				.commandId,
		).toBeUndefined();
		expect(
			menus.snapshot("edit").find((item: any) => item.id === "edit.copy")
				.keybinding,
		).toBe("Ctrl+C");
		expect(
			menus
				.snapshot("window")
				.find((item: any) => item.id === "window.viewport").args,
		).toEqual({ id: "viewport" });
	} finally {
		await app.dispose();
	}
	expect(app.host.menus.snapshot()).toEqual([]);
});

test("client capabilities keep setup snapshots while existing store readers follow reconfiguration", async () => {
	const { runtime } = fixture();
	const first = {
		fetchSessionList: async () => [],
		disconnectForgeaXWs() {
			throw new Error("unexpected disconnect");
		},
	};
	const second = { fetchSessionList: async () => [{ sid: "second" }] };
	const domains = { agents: {}, projects: {}, builds: {} };
	const replacement = { agents: {}, projects: {}, builds: {} };
	const absent = await runtime.productBootstrap();
	expect(absent.host.session).toBeUndefined();
	expect(absent.host.projects).toBeUndefined();
	await absent.dispose();
	runtime.configureCompatibilitySession(first);
	runtime.configureCompatibilityDomains(domains);
	const app = await runtime.productBootstrap();
	try {
		expect(app.host.session.client).toBe(first);
		expect(app.host.agentCatalog.client).toBe(domains.agents);
		expect(app.host.projects.client).toBe(domains.projects);
		expect(app.host.builds.client).toBe(domains.builds);
		runtime.configureCompatibilitySession(second);
		runtime.configureCompatibilityDomains(replacement);
		expect(runtime.capturedStoreContext.getSessionClient()).toBe(second);
		expect(runtime.capturedStoreContext.getStudioProjectClient()).toBe(
			replacement.projects,
		);
		expect(
			await runtime.capturedStoreContext.getSessionClient().fetchSessionList(),
		).toEqual([{ sid: "second" }]);
		expect(app.host.session.client).toBe(first);
		expect(app.host.projects.client).toBe(domains.projects);
		const restarted = await runtime.productBootstrap();
		try {
			expect(restarted.host.session.client).toBe(second);
			expect(restarted.host.projects.client).toBe(replacement.projects);
		} finally {
			await restarted.dispose();
		}
	} finally {
		await app.dispose();
	}
	expect(runtime.compatibilitySession()).toBe(second);
	expect(runtime.compatibilityProjects()).toBe(replacement.projects);
});

test("product client binding adopts existing compatibility objects and delegates writes both ways", async () => {
	const { runtime } = fixture();
	const session = { fetchSessionList: async () => [] };
	const domains = { agents: {}, projects: {}, builds: {} };
	runtime.configureCompatibilitySession(session);
	runtime.configureCompatibilityDomains(domains);
	expect(runtime.productSession()).toBeNull();
	expect(runtime.productDomains()).toBeNull();
	runtime.bindProductClients();
	expect(runtime.productSession()).toBe(session);
	expect(runtime.productDomains()).toBe(domains);
	expect(runtime.capturedStoreContext.getSessionClient()).toBe(session);
	expect(runtime.capturedStoreContext.getStudioProjectClient()).toBe(
		domains.projects,
	);
	const next = { fetchSessionList: async () => [{ sid: "next" }] };
	const nextDomains = { agents: {}, projects: {}, builds: {} };
	runtime.configureProductSession(next);
	runtime.configureProductDomains(nextDomains);
	runtime.bindProductClients();
	expect(runtime.compatibilitySession()).toBe(next);
	expect(runtime.compatibilityAgents()).toBe(nextDomains.agents);
	expect(runtime.compatibilityProjects()).toBe(nextDomains.projects);
	expect(runtime.compatibilityBuilds()).toBe(nextDomains.builds);
	expect(runtime.capturedStoreContext.getSessionClient()).toBe(next);
	expect(runtime.capturedStoreContext.getStudioProjectClient()).toBe(
		nextDomains.projects,
	);
	runtime.configureCompatibilitySession(session);
	runtime.configureCompatibilityDomains(domains);
	expect(runtime.productSession()).toBe(session);
	expect(runtime.productDomains()).toBe(domains);
});

test("standalone client configuration remains independent without product binding", async () => {
	const { runtime } = fixture();
	const session = {};
	const domains = { agents: {}, projects: {}, builds: {} };
	runtime.configureCompatibilitySession(session);
	runtime.configureCompatibilityDomains(domains);
	const app = await runtime.standalone();
	try {
		expect(app.host.session.client).toBe(session);
		expect(app.host.projects.client).toBe(domains.projects);
		expect(runtime.productSession()).toBeNull();
		expect(runtime.productDomains()).toBeNull();
	} finally {
		await app.dispose();
	}
	expect(runtime.compatibilitySession()).toBe(session);
	expect(runtime.compatibilityProjects()).toBe(domains.projects);
});

test("failed client adoption preserves the old configuration for a later successful bind", () => {
	const { runtime } = fixture();
	const session = {};
	const domains = { agents: {}, projects: {}, builds: {} };
	runtime.configureCompatibilitySession(session);
	runtime.configureCompatibilityDomains(domains);
	const failure = new Error("adoption failed");
	const brokenRuntime = {
		read: () => null,
		write: () => {
			throw failure;
		},
	};
	expect(() => runtime.bindSessionRuntime(brokenRuntime)).toThrow(failure);
	expect(() => runtime.bindDomainRuntime(brokenRuntime)).toThrow(failure);
	expect(runtime.compatibilitySession()).toBe(session);
	expect(runtime.compatibilityProjects()).toBe(domains.projects);
	runtime.bindProductClients();
	expect(runtime.productSession()).toBe(session);
	expect(runtime.productDomains()).toBe(domains);
});

test("product session capabilities preserve live state and method delegation through disposal", async () => {
	const { runtime } = fixture();
	runtime.bindProductClients();
	const client = {
		disconnectForgeaXWs() {
			throw new Error("unexpected disconnect");
		},
	};
	runtime.configureProductSession(client);
	const store = runtime.getIdeShellStore();
	const calls: unknown[] = [];
	const created = { sid: "created" };
	const closed = { status: "closed" };
	const refreshed = { status: "ready" };
	store.setState({
		switchToSession: async (sid: string) => {
			calls.push(["switch", sid]);
		},
		createNewSession: async (opts: unknown) => {
			calls.push(["create", opts]);
			return created;
		},
		closeSession: async (sid: string) => {
			calls.push(["close", sid]);
			return closed;
		},
		renameTab: (sid: string, name: string) => {
			calls.push(["rename", sid, name]);
		},
		refreshSessions: async () => {
			calls.push(["refresh"]);
			return refreshed;
		},
		setActiveGame: async (slug: string) => {
			calls.push(["game", slug]);
			return { changed: true };
		},
	});
	const app = await runtime.productBootstrap();
	try {
		const cap = app.host.session;
		const tabs = [{ sid: "active" }];
		store.setState({ tabs, activeSid: "active", activeGameSlug: "game" });
		expect(cap.tabs).toBe(tabs);
		expect(cap.activeSid).toBe("active");
		expect(cap.activeGameSlug).toBe("game");
		await cap.switchToSession("active");
		expect(await cap.createSession({ displayName: "name" })).toBe(created);
		expect(await cap.closeSession("active")).toBe(closed);
		cap.renameTab("active", "renamed");
		expect(await cap.refreshSessions()).toBe(refreshed);
		expect(await cap.setActiveGame("next")).toBeUndefined();
		expect(calls).toEqual([
			["switch", "active"],
			["create", { displayName: "name" }],
			["close", "active"],
			["rename", "active", "renamed"],
			["refresh"],
			["game", "next"],
		]);
	} finally {
		await app.dispose();
	}
	expect(runtime.productSession()).toBe(client);
	expect(runtime.compatibilitySession()).toBe(client);
});

test("product bootstrap filters overridden catalog pages and disposes its catalog", async () => {
	const id = "@forgeax-extension/product-selected";
	const { runtime, closed } = fixture([
		{
			id,
			version: "1",
			displayName: "Catalog",
			contributes: {
				pages: [
					{
						id: "main",
						title: "Catalog title",
						cardinality: "singleton",
						panels: [],
						layout: { version: 1, root: { kind: "tabs", placements: [] } },
					},
				],
			},
		},
	]);
	const selected = pageExtension(runtime, id);
	const app = await runtime.startIdeApplication({
		extensions: [selected.extension],
	});
	try {
		expect(app.host.pageRegistry.get(selected.page).definition.title).toBe(
			"Selected",
		);
		expect(app.host.capabilities.has("commands")).toBe(true);
		expect(app.host.capabilities.has("pages")).toBe(true);
	} finally {
		await app.dispose();
	}
	expect(closed()).toBe(1);
});

test("startup preserves the two-frame boot handshake and the product shortcut catalog", async () => {
	const { runtime, window, frames } = fixture();
	const progress: number[] = [];
	let done = 0;
	(window as any).__forgeaxBoot = {
		progress({ pct }: any) {
			progress.push(pct);
		},
		done() {
			done++;
		},
	};
	const app = await runtime.startIdeApplication();
	try {
		expect(progress).toEqual([92]);
		expect(done).toBe(0);
		frames.shift()!();
		expect(done).toBe(0);
		frames.shift()!();
		expect(progress).toEqual([92, 100]);
		expect(done).toBe(1);
		expect(runtime.buildIdeShortcutDescriptions(app.host)[0]).toBe(
			app.shellShortcuts[0],
		);
	} finally {
		await app.dispose();
	}
});

test.each(["boot", "shortcuts"])(
	"a %s failure retains dirty cleanup until explicit retry",
	async (phase) => {
		const { runtime, window, closed } = fixture();
		const failure = new Error(`${phase} failed`);
		let blocked = true;
		let retired = 0;
		const item = pageExtension(runtime, "@forgeax-plugin/retained-startup", {
			prepareClose: () =>
				blocked ? { status: "vetoed" } : { status: "ready" },
			dispose() {
				retired++;
			},
		});
		(item.extension as any).setup = async (context: any) => {
			await context.host.pages.open({ typeId: item.page });
		};
		if (phase === "boot")
			(window as any).__forgeaxBoot = {
				progress() {
					throw failure;
				},
			};
		const owner = runtime.createIdeApplicationOwner();
		const lease = owner.acquire(() =>
			runtime.startIdeApplication(
				{ extensions: [item.extension] },
				phase === "shortcuts"
					? {
							createShellShortcuts() {
								throw failure;
							},
						}
					: {},
			),
		);
		try {
			await expect(lease.ready).rejects.toBe(failure);
			expect(owner.getSnapshot()).toMatchObject({
				status: "blocked",
				retryable: true,
			});
			expect(retired).toBe(0);
			blocked = false;
			await owner.retryShutdown();
			expect(retired).toBe(1);
			expect(closed()).toBe(1);
			expect(owner.getSnapshot()).toEqual({ status: "ready" });
		} finally {
			blocked = false;
			lease.release();
			await owner.retryShutdown();
		}
	},
);

test("standalone keeps its original default startup", async () => {
	const { runtime } = fixture();
	const app = await runtime.standalone();
	try {
		expect(app.host.capabilities.has("commands")).toBe(true);
	} finally {
		await app.dispose();
	}
});

test("startup binds locale and composer compatibility callers to the product authorities", async () => {
	const { runtime } = fixture();
	const app = await runtime.startIdeApplication({}, { locale: "zh" });
	try {
		expect(runtime.productLocale()).toBe("zh");
		expect(runtime.compatibilityLocale()).toBe("zh");
		const reference = {
			kind: "file",
			display: "main.ts",
			detail: "main.ts",
			tooltip: { title: "main.ts", lines: [] },
		};
		runtime.compatibilityInsert(reference);
		expect(runtime.createIdeComposerInsertRuntime([]).getPending()).toBe(
			reference,
		);
	} finally {
		await app.dispose();
	}
});

test("product bootstrap preserves builtin precedence and reports duplicate selection", async () => {
	const { runtime, warnings } = fixture();
	let replaced = false;
	const app = await runtime.productBootstrap({
		extensions: [
			{
				id: "foundation.commands",
				version: "1",
				setup() {
					replaced = true;
				},
			},
		],
	});
	try {
		expect(replaced).toBe(false);
		expect(
			warnings.filter((message) =>
				message.includes('duplicate extension id "foundation.commands"'),
			),
		).toHaveLength(1);
		expect(app.host.commands.get("text.copy")).toBeDefined();
	} finally {
		await app.dispose();
	}
});

test("product bootstrap uses selected page services and disposes catalog before extensions and host", async () => {
	const { runtime, lifecycle } = fixture();
	let selectedCommands: unknown;
	const app = await runtime.productBootstrap({
		createPageServices(commands: unknown) {
			selectedCommands = commands;
			const services = runtime.createIdePageServices(commands);
			return {
				...services,
				async dispose() {
					lifecycle.push("host");
					await services.dispose();
				},
			};
		},
		extensions: [
			{
				id: "product-lifetime",
				version: "1",
				setup() {
					return () => {
						lifecycle.push("extension");
					};
				},
			},
		],
	});
	expect(selectedCommands).toBe(app.host.commands);
	await app.dispose();
	expect(lifecycle).toEqual(["catalog", "extension", "host"]);
});

test("product task commands preserve validated payloads, both file channels and cleanup", async () => {
	const { runtime } = fixture();
	const app = await runtime.startIdeApplication();
	const events: unknown[] = [];
	const offTopic = runtime.subscribeTopic(
		"resource-editor:open-file",
		(value: unknown) => events.push(["topic", value]),
	);
	const offFile = app.host.bus.on("files:reveal", (value: unknown) =>
		events.push(["file", value]),
	);
	const offBuild = app.host.bus.on("build:create", (value: unknown) =>
		events.push(["build", value]),
	);
	const offPlay = app.host.bus.on("build:play", (value: unknown) =>
		events.push(["play", value]),
	);
	try {
		await expect(
			app.host.commands.execute("app.files.reveal", {
				path: "  src/game.ts  ",
			}),
		).resolves.toEqual({ status: "completed", path: "src/game.ts" });
		await app.host.commands.execute("app.build.create", {
			version: "  release-1  ",
		});
		await app.host.commands.execute("app.build.play", { version: "release-1" });
		expect(events).toEqual([
			["topic", { path: "src/game.ts" }],
			["file", { path: "src/game.ts" }],
			["build", { version: "release-1" }],
			["play", { version: "release-1" }],
		]);
		await expect(
			app.host.commands.execute("app.files.reveal", { path: " " }),
		).rejects.toThrow("missing { path }");
		await expect(
			app.host.commands.execute("app.build.play", {}),
		).rejects.toThrow("missing { version }");
		expect(events).toHaveLength(4);
	} finally {
		offTopic();
		offFile();
		offBuild();
		offPlay();
		await app.dispose();
	}
	expect(app.host.commands.get("app.files.reveal")).toBeUndefined();
	expect(app.host.commands.get("app.build.create")).toBeUndefined();
});

test("product drawer commands preserve the renderer event contract and unregister on shutdown", async () => {
	const { runtime, window } = fixture();
	const actions: unknown[] = [];
	window.addEventListener("forgeax:edge-drawer", (event: any) =>
		actions.push(event.detail),
	);
	const app = await runtime.startIdeApplication();
	try {
		await app.host.commands.execute("app.drawer.toggle", { id: "info" });
		await app.host.commands.execute("app.drawer.open", { id: "events" });
		await app.host.commands.execute("app.drawer.close");
		expect(actions).toEqual([
			{ action: "toggle", id: "info" },
			{ action: "open", id: "events" },
			{ action: "close", id: undefined },
		]);
		await expect(
			app.host.commands.execute("app.drawer.open", {}),
		).rejects.toThrow("missing { id }");
		expect(actions).toHaveLength(3);
	} finally {
		await app.dispose();
	}
	expect(app.host.commands.get("app.drawer.toggle")).toBeUndefined();
});

test.each(["zh", "en"])(
	"product Chat commands use the same queue and preserve %s asset payloads",
	async (locale) => {
		const { runtime } = fixture();
		runtime.configureIdeChatRuntime();
		const app = await runtime.startIdeApplication({}, { locale });
		const queue = runtime.createIdeComposerInsertRuntime([]);
		const pill = {
			kind: "file",
			display: "game.ts",
			detail: "src/game.ts",
			tooltip: { title: "game.ts", lines: [] },
		};
		const asset = {
			guid: "asset-123",
			name: "Hero",
			assetKind: "texture",
			packPath: "art/hero",
		};
		try {
			await app.host.commands.execute("app.chat.insertPill", { pill });
			await app.host.commands.execute("app.chat.referenceAsset", asset);
			expect(queue.getQueue()[0]).toBe(pill);
			expect(queue.getQueue()[1]).toEqual(
				runtime.compatibilityAssetPill(asset),
			);
			await expect(
				app.host.commands.execute("app.chat.referenceAsset", {}),
			).rejects.toThrow("missing { guid }");
			expect(queue.getQueue()).toHaveLength(2);
		} finally {
			await app.dispose();
		}
		expect(app.host.commands.get("app.chat.insertPill")).toBeUndefined();
		expect(queue.getQueue()).toHaveLength(2);
	},
);

test("product observability capability reads and mutates the existing IDE store", async () => {
	const { runtime } = fixture();
	const app = await runtime.startIdeApplication();
	const store = runtime.getIdeShellStore();
	const cap = app.host.observability;
	try {
		expect(cap.consoleLog).toBe(store.getState().consoleLog);
		cap.pushConsole({ level: "info", text: "product event", ts: 1 });
		expect(cap.consoleLog).toBe(store.getState().consoleLog);
		expect(cap.consoleLog.at(-1).text).toBe("product event");
		store.getState().pushNetwork({
			kind: "fetch",
			method: "GET",
			url: "/test",
			status: 200,
			ms: 1,
			ok: true,
			ts: 1,
		});
		expect(cap.networkLog).toBe(store.getState().networkLog);
		cap.pushTelemetry([{ kind: "log", level: "info", ts: 1, msg: "observed" }]);
		expect(cap.telemetry).toBe(store.getState().telemetry);
		cap.clearConsole();
		cap.clearNetwork();
		cap.clearTelemetry();
		expect(store.getState().consoleLog).toEqual([]);
		expect(store.getState().networkLog).toEqual([]);
		expect(store.getState().telemetry).toEqual([]);
	} finally {
		await app.dispose();
	}
});

test("catalog registration passes the manifest to the selected host panel", () => {
	const { runtime } = fixture();
	expect(runtime.catalogPanelIdentity).toBe(true);
	const base = {
		id: "@demo/tool",
		version: "1",
		displayName: "Tool",
		entry: { standalone: {} },
		contributes: { panelTypes: [{ id: "main", runtime: "inline" }] },
	};
	const [panel] = runtime.productCatalogPanels(base);
	const element = panel.runtime.render({ initialProps: { pane: "center" } });
	expect(element.type).toBe(runtime.sharedExtensionHostPanel);
	expect(element.props).toEqual({
		extensionId: base.id,
		pane: "center",
		manifest: base,
	});
	expect(panel.windowing).toBeDefined();
	for (const id of [
		"@forgeax-extension/video-game",
		"@forgeax-extension/game-video",
	]) {
		expect(
			runtime.productCatalogPanels({ ...base, id })[0].windowing,
		).toBeUndefined();
	}
});

test("recent-project notifications and compatibility readers share product state across host recovery", async () => {
	const { runtime } = fixture();
	runtime.configureProductDomains({
		projects: {
			listProjects: async () => ({ games: [{ slug: "shared", mtime: 7 }] }),
		},
	});
	const app = await runtime.startIdeApplication();
	let notifications = 0;
	const off = runtime.subscribeRecentGames(() => {
		notifications++;
	});
	try {
		await runtime.ideRecentProjectsRuntime.warm();
		expect(runtime.getRecentGames()).toEqual(
			runtime.ideRecentProjectsRuntime.read(),
		);
		expect(runtime.getRecentGames()[0]).toBe(
			runtime.ideRecentProjectsRuntime.read()[0],
		);
		expect(runtime.getRecentGamesRevision()).toBe(
			runtime.ideRecentProjectsRuntime.getRevision(),
		);
		expect(notifications).toBe(1);
		await app.dispose();
		const recovered = await runtime.startIdeApplication();
		try {
			expect(runtime.getRecentGames()[0].slug).toBe("shared");
			await runtime.warmApplicationMenus();
			expect(notifications).toBe(2);
			off();
			await runtime.ideRecentProjectsRuntime.warm();
			expect(notifications).toBe(2);
			expect(runtime.getRecentGamesRevision()).toBe(3);
		} finally {
			await recovered.dispose();
		}
	} finally {
		off();
		await app.dispose();
	}
});
