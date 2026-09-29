import { Window } from "happy-dom";
import { expect, test } from "vitest";

test("IDE directory modal links the selected folder before activating its project", async () => {
	const browser = new Window({ url: "http://localhost:18920" });
	const requested: string[] = [];
	const globals = {
		window: browser,
		document: browser.document,
		navigator: browser.navigator,
		HTMLElement: browser.HTMLElement,
		Element: browser.Element,
		Node: browser.Node,
		Document: browser.Document,
		MutationObserver: browser.MutationObserver,
		CustomEvent: browser.CustomEvent,
		getComputedStyle: browser.getComputedStyle.bind(browser),
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (input: RequestInfo | URL) => {
			requested.push(String(input));
			return new Response(
				JSON.stringify({
					dir: "/workspace/game",
					dirDisplay: "/workspace/game",
					parent: "/workspace",
					parentDisplay: "/workspace",
					name: "game",
					selfHasForgeaX: true,
					selfHasGame: true,
					entries: [],
				}),
			);
		},
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
		const { IdeProjectDirectoryModal } = await import(
			"../src/product/project-directory-modal"
		);
		const order: string[] = [];
		const mount = browser.document.createElement("div");
		browser.document.body.append(mount);
		root = createRoot(mount as unknown as Parameters<typeof createRoot>[0]);
		await act(async () => {
			root?.render(
				createElement(IdeProjectDirectoryModal, {
					onClose: () => order.push("close"),
					linkProject: async (path) => {
						order.push(`link:${path}`);
						return { ok: true, slug: "game" };
					},
					setActiveGame: async (slug) => {
						order.push(`activate:${slug}`);
					},
				}),
			);
			await Promise.resolve();
		});
		expect(requested).toEqual(["/api/fs/browse?dir=~"]);
		const select = mount.querySelector(".tb-modal-btn.primary");
		expect(select?.hasAttribute("disabled")).toBe(false);
		await act(async () => {
			select?.dispatchEvent(new browser.MouseEvent("click", { bubbles: true }));
			await Promise.resolve();
		});
		expect(order).toEqual(["link:/workspace/game", "close", "activate:game"]);
	} finally {
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
