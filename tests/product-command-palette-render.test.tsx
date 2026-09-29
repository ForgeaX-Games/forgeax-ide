import { Window } from "happy-dom";
import { expect, test } from "vitest";

test("IDE shortcut opens its command palette and dispatches through App Shell", async () => {
	const browser = new Window({ url: "http://localhost:18920" });
	const globals = {
		window: browser,
		document: browser.document,
		navigator: browser.navigator,
		HTMLElement: browser.HTMLElement,
		Element: browser.Element,
		Node: browser.Node,
		Document: browser.Document,
		MutationObserver: browser.MutationObserver,
		ResizeObserver: browser.ResizeObserver,
		requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
		cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
		CustomEvent: browser.CustomEvent,
		getComputedStyle: browser.getComputedStyle.bind(browser),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const previous = Object.fromEntries(
		Object.keys(globals).map((name) => [
			name,
			Object.getOwnPropertyDescriptor(globalThis, name),
		]),
	);
	for (const [name, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, name, {
			configurable: true,
			writable: true,
			value,
		});
	}

	let root: import("react-dom/client").Root | undefined;
	let unregister: (() => void) | undefined;
	try {
		const { act, createElement } = await import("react");
		const { createRoot } = await import("react-dom/client");
		const { registerAction } = await import("@forgeax/app-shell/application");
		const { IdeCommandPalette } = await import(
			"../src/product/command-palette"
		);
		const { setIdeCommandPaletteOpen, toggleIdeCommandPalette } = await import(
			"../src/product/command-palette-store"
		);
		let runs = 0;
		unregister = registerAction({
			id: "test.ide-palette",
			title: "IDE palette action",
			capability: "read",
			surface: "ui",
			run: () => {
				runs++;
				return { status: "completed", stateDigest: { runs } };
			},
		});
		const container = browser.document.createElement("div");
		browser.document.body.append(container);
		root = createRoot(container as unknown as Parameters<typeof createRoot>[0]);
		await act(async () => root?.render(createElement(IdeCommandPalette)));
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		await act(async () => toggleIdeCommandPalette());
		expect(container.querySelector('[role="dialog"]')).not.toBeNull();
		const action = Array.from(container.querySelectorAll("[cmdk-item]")).find(
			(item) => item.textContent?.includes("IDE palette action"),
		);
		expect(action).toBeDefined();
		await act(async () => {
			action?.dispatchEvent(new browser.MouseEvent("click", { bubbles: true }));
			await Promise.resolve();
		});
		expect(runs).toBe(1);
		await act(async () => setIdeCommandPaletteOpen(false));
	} finally {
		unregister?.();
		if (root) {
			const { act } = await import("react");
			await act(async () => root?.unmount());
		}
		await browser.happyDOM.close();
		for (const [name, descriptor] of Object.entries(previous)) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
	}
});
