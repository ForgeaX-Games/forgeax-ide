import { Window } from "happy-dom";
import { expect, test } from "vitest";

test("IDE drawer renders an App Shell panel and closes it", async () => {
	const browser = new Window({ url: "http://localhost:18920" });
	const globals = {
		window: browser,
		document: browser.document,
		localStorage: browser.localStorage,
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
		const { DEFAULT_PANEL_RENDERERS, PanelRenderersProvider } = await import(
			"@forgeax/app-shell/application"
		);
		const { IdeDrawerHost } = await import("../src/product/drawer-host");
		const { useIdeDrawerStore } = await import("../src/product/drawer-store");
		const mount = browser.document.createElement("div");
		browser.document.body.append(mount);
		root = createRoot(mount as unknown as Parameters<typeof createRoot>[0]);
		await act(async () => {
			useIdeDrawerStore.getState().open("test.panel");
			root?.render(
				createElement(PanelRenderersProvider, {
					value: {
						...DEFAULT_PANEL_RENDERERS,
						drawerPanels: {
							"test.panel": {
								id: "test.panel",
								title: "Test drawer",
								render: () => createElement("p", null, "Panel body"),
							},
						},
					},
					children: createElement(IdeDrawerHost),
				}),
			);
		});
		expect(mount.querySelector(".fx-drawer-title")?.textContent).toBe(
			"Test drawer",
		);
		expect(mount.textContent).toContain("Panel body");
		const close = mount.querySelector(".fx-drawer-collapse");
		await act(async () =>
			close?.dispatchEvent(new browser.MouseEvent("click", { bubbles: true })),
		);
		expect(useIdeDrawerStore.getState().activeId).toBeNull();
		expect(mount.querySelector(".fx-drawer-panel.is-closing")).not.toBeNull();
		await act(async () =>
			mount
				.querySelector(".fx-drawer-panel")
				?.dispatchEvent(new browser.Event("animationend", { bubbles: true })),
		);
		expect(mount.querySelector(".fx-drawer-panel")).toBeNull();
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
