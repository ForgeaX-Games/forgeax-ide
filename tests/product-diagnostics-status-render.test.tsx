import { Window } from "happy-dom";
import { expect, test } from "vitest";

test("IDE diagnostics chip shows fetched runtime health", async () => {
	const browser = new Window({ url: "http://localhost:18920" });
	const fetch = async () => {
		return {
			ok: true,
			json: async () => ({
				uptime: 125,
				wsClients: 3,
				mem: { rss: 12 * 1048576 },
			}),
		} as Response;
	};
	const globals = {
		window: browser,
		document: browser.document,
		navigator: browser.navigator,
		fetch,
		HTMLElement: browser.HTMLElement,
		Element: browser.Element,
		Node: browser.Node,
		Document: browser.Document,
		MutationObserver: browser.MutationObserver,
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
	try {
		const { act, createElement } = await import("react");
		const { createRoot } = await import("react-dom/client");
		const { DiagnosticsChip, ideDiagnosticsStatusItem } = await import(
			"../src/product/diagnostics-status"
		);
		expect(ideDiagnosticsStatusItem.id).toBe("diagnostics");
		const mount = browser.document.createElement("div");
		browser.document.body.append(mount);
		root = createRoot(mount as unknown as Parameters<typeof createRoot>[0]);
		await act(async () => root?.render(createElement(DiagnosticsChip)));
		expect(mount.querySelector(".sb-chip-label")?.textContent).toBe(
			"Diagnostics",
		);
		await act(async () =>
			mount
				.querySelector("button")
				?.dispatchEvent(new browser.MouseEvent("click", { bubbles: true })),
		);
		expect(browser.document.body.textContent).toContain("12 MB");
		expect(browser.document.body.textContent).toContain("2m");
	} finally {
		const { act } = await import("react");
		await act(async () => root?.unmount());
		await browser.happyDOM.close();
		for (const [name, descriptor] of Object.entries(previous)) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
	}
});
