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
beforeAll(async () => {
	code = JSON.parse(
		await runIsolatedViteProbe(
			[
				process.execPath,
				"--experimental-strip-types",
				resolve(import.meta.dirname, "fixtures/product-keyboard-build.ts"),
			],
			45_000,
		),
	);
}, 50_000);

function fixture() {
	const window = new Window({ url: "http://localhost:18920" });
	cleanup.push(() => window.happyDOM.close());
	const runtime = runInNewContext(`${code}\nProductKeyboard`, {
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
		console,
		process: { env: { NODE_ENV: "production" } },
	});
	const { host, control } = runtime.createAppHost();
	cleanup.push(() => control.dispose());
	return { window, runtime, host };
}

// The real product hook and compatibility registration are bundled through the
// same aliases as Vite; no mock registry, keyboard observer or React hook.
test("product mount shares transient ownership with compatibility and disposes the capture listener", () => {
	const { window, runtime, host } = fixture();
	expect(runtime.productRegister).toBe(runtime.compatibilityRegister);
	const listeners = new Set<unknown>();
	const add = window.addEventListener.bind(window);
	const remove = window.removeEventListener.bind(window);
	window.addEventListener = ((type: string, listener: any, options: any) => {
		if (type === "keydown" && options === true) listeners.add(listener);
		return add(type, listener, options);
	}) as typeof window.addEventListener;
	window.removeEventListener = ((type: string, listener: any, options: any) => {
		if (type === "keydown" && options === true) listeners.delete(listener);
		return remove(type, listener);
	}) as typeof window.removeEventListener;
	const trace: string[] = [];
	const stopTransient = runtime.compatibilityRegister(() => {
		trace.push("drag");
		return true;
	});
	cleanup.push(stopTransient);
	const unmount = runtime.mount({
		host,
		shellShortcuts: [
			{
				combo: "Escape",
				label: "Fallback",
				group: "layout",
				match: () => true,
				run: () => trace.push("shortcut"),
			},
		],
	});
	expect(listeners.size).toBe(1);
	window.dispatchEvent(
		new window.KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
	);
	expect(trace.splice(0)).toEqual(["drag"]);
	stopTransient();
	window.dispatchEvent(
		new window.KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
	);
	expect(trace.splice(0)).toEqual(["shortcut"]);
	unmount();
	expect(listeners.size).toBe(0);
	window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
	expect(trace).toEqual([]);
});

test("product input, preview and overlay gates follow the live DOM and product store", () => {
	const { window, runtime } = fixture();
	const anchor = window.document.createElement("div");
	anchor.dataset.surfaceAnchor = "edit";
	anchor.getClientRects = () => [{ width: 10 }] as any;
	window.document.body.append(anchor);
	const input = window.document.createElement("input");
	window.document.body.append(input);
	const preview = window.document.createElement("div");
	preview.dataset.fxKeyboardSurface = "preview";
	window.document.body.append(preview);
	const event = (target: unknown) => ({ target });
	const edit = { group: "edit" };
	expect(runtime.isIdeTypingTarget(event(input))).toBe(true);
	expect(runtime.isIdeTypingTarget(event(window))).toBe(false);
	expect(runtime.shouldSkipIdeShortcut(event(anchor), edit)).toBe(false);
	expect(runtime.shouldSkipIdeShortcut(event(preview), edit)).toBe(true);
	runtime.store.setState({ activeOverlay: "settings" });
	expect(runtime.shouldSkipIdeShortcut(event(anchor), edit)).toBe(true);
	expect(
		runtime.shouldSkipIdeShortcut(event(anchor), { group: "layout" }),
	).toBe(false);
	runtime.store.setState({ activeOverlay: null });
	anchor.remove();
	expect(runtime.shouldSkipIdeShortcut(event(input), edit)).toBe(true);
});
