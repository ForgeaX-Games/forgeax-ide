import { Window } from "happy-dom";
import { expect, test } from "vitest";

test("IDE activity rail launches a builtin activity from the shared App Shell registry", async () => {
	const browser = new Window({ url: "http://localhost:18920" });
	const globals = {
		window: browser,
		document: browser.document,
		navigator: browser.navigator,
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
	let dispose: (() => Promise<void>) | undefined;
	try {
		const { act, createElement } = await import("react");
		const { createRoot } = await import("react-dom/client");
		const { createApplicationHost, DEFAULT_PANEL_RENDERERS, HostProvider } =
			await import("@forgeax/app-shell/application");
		const { qualifyContributionId } = await import("@forgeax/types");
		const { IdeActivityRail } = await import("../src/product/activity-rail");
		const { createIdePageServices } = await import(
			"../src/product/page-services"
		);
		const log = { debug() {}, info() {}, warn() {}, error() {} };
		const { host, control } = createApplicationHost({
			log,
			defaultPanels: DEFAULT_PANEL_RENDERERS,
			createPageServices: createIdePageServices,
		});
		dispose = () => control.dispose();
		const owner = "@forgeax/core";
		const commandId = "test.open-editor";
		let launches = 0;
		host.commands.register({ id: commandId, execute: () => launches++ });
		control.contributePagePlatform(owner, {
			activities: [
				{
					id: qualifyContributionId(owner, "activity", "editor"),
					title: "Editor",
					commandId,
					sourceLayer: "builtin",
				},
			],
		});
		const pluginOwner = "@example/custom-tool";
		const pluginId = qualifyContributionId(pluginOwner, "activity", "launcher");
		const pluginCommandId = "test.open-custom";
		host.commands.register({ id: pluginCommandId, execute: () => undefined });
		control.contributePagePlatform(pluginOwner, {
			activities: [
				{
					id: pluginId,
					title: "Custom Tool",
					commandId: pluginCommandId,
					sourceLayer: "installed",
					category: "2D",
				},
			],
		});
		const mount = browser.document.createElement("div");
		browser.document.body.append(mount);
		root = createRoot(mount as unknown as Parameters<typeof createRoot>[0]);
		await act(async () =>
			root?.render(
				createElement(HostProvider, {
					value: host,
					children: createElement(IdeActivityRail),
				}),
			),
		);
		const button = browser.document.querySelector(
			'.activity-rail-item[aria-label="Editor"]',
		);
		expect(button).not.toBeNull();
		await act(async () =>
			button?.dispatchEvent(new browser.MouseEvent("click", { bubbles: true })),
		);
		expect(launches).toBe(1);
		const more = browser.document.querySelector(
			'[data-rail-action="more-plugins"]',
		);
		await act(async () =>
			more?.dispatchEvent(new browser.MouseEvent("click", { bubbles: true })),
		);
		expect(
			browser.document.querySelector(".activity-rail-more-name")?.textContent,
		).toBe("Custom Tool");
		const pin = browser.document.querySelector(".activity-rail-more-pin");
		await act(async () =>
			pin?.dispatchEvent(new browser.MouseEvent("click", { bubbles: true })),
		);
		expect(
			browser.document.querySelector(`[data-activity-id="${pluginId}"]`),
		).not.toBeNull();
		expect(
			JSON.parse(
				browser.localStorage.getItem("forgeax.activityRail.pinned.v3") ?? "[]",
			),
		).toContain(pluginId);
	} finally {
		const { act } = await import("react");
		await act(async () => root?.unmount());
		await dispose?.();
		await browser.happyDOM.close();
		for (const [name, descriptor] of Object.entries(previous)) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
	}
});
