import { Window } from "happy-dom";
import { expect, test, vi } from "vitest";

// The Editor facade's portalled primitives use the Editor workspace React copy
// in Node. The browser dedupes React; this test isolates the App Shell lifecycle.
vi.mock("@forgeax/editor/ui/popover", () => ({
	Popover: () => null,
	PopoverContent: () => null,
	PopoverTrigger: () => null,
}));
vi.mock("@forgeax/editor/ui/dropdown-menu", () => ({
	DropdownMenu: () => null,
	DropdownMenuContent: () => null,
	DropdownMenuItem: () => null,
	DropdownMenuSeparator: () => null,
	DropdownMenuTrigger: () => null,
}));

test("IDE page tabs follow the shared App Shell page lifecycle", async () => {
	const browser = new Window({ url: "http://localhost:18920" });
	browser.HTMLElement.prototype.scrollIntoView = () => {};
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
		CSS: { escape: (value: string) => value.replaceAll('"', '\\"') },
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
		const { IdePageTabStrip } = await import("../src/product/page-tab-strip");
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
		const owner = "@forgeax-plugin/ide-page-tab-test";
		const panelId = qualifyContributionId(owner, "panel", "main");
		const pageTypeId = qualifyContributionId(owner, "page", "sample");
		control.contributePagePlatform(owner, {
			panelTypes: [
				{ id: panelId, runtime: { kind: "inline", render: () => null } },
			],
			pageTypes: [
				{
					id: pageTypeId,
					title: "Sample",
					cardinality: "singleton",
					layout: {
						version: 1,
						root: { kind: "tabs", placements: ["main"] },
					},
					panels: [{ id: "main", panelTypeId: panelId }],
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
					children: createElement(IdePageTabStrip),
				}),
			),
		);
		expect(mount.querySelector(".page-tab-list")).toBeNull();
		await act(async () => {
			await host.pages.open({ typeId: pageTypeId });
		});
		expect(mount.querySelector(".page-tab__label")?.textContent).toBe("Sample");
		const page = host.pages.getSnapshot().instances[0];
		expect(page).toBeDefined();
		await act(async () => {
			await host.pages.close(page?.encodedKey ?? "");
		});
		expect(mount.querySelector(".page-tab-list")).toBeNull();
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
