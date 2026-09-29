import { Window } from "happy-dom";
import { expect, test } from "vitest";

test("IDE build chip shows the fetched application version and tag history", async () => {
	const browser = new Window({ url: "http://localhost:18920" });
	const fetch = async (input: RequestInfo | URL) => {
		const path = String(input);
		const body = path.endsWith("/api/version/tags")
			? { tags: [{ tag: "v1.2.3", date: "2026-09-20", message: "Release" }] }
			: {
					version: "v1.2.3",
					sha: "abc123",
					date: "2026-09-20",
					totalCommits: 12,
					branch: "main",
				};
		return { ok: true, json: async () => body } as Response;
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
		const { ForgeaxBuildChip, ideBuildVersionStatusItem } = await import(
			"../src/product/build-version-status"
		);
		expect(ideBuildVersionStatusItem.id).toBe("forgeax-build-version");
		const mount = browser.document.createElement("div");
		browser.document.body.append(mount);
		root = createRoot(mount as unknown as Parameters<typeof createRoot>[0]);
		await act(async () => root?.render(createElement(ForgeaxBuildChip)));
		expect(mount.querySelector(".sb-chip-label")?.textContent).toBe("v1.2.3");
		await act(async () =>
			mount
				.querySelector("button")
				?.dispatchEvent(new browser.MouseEvent("click", { bubbles: true })),
		);
		expect(browser.document.body.textContent).toContain("main · abc123");
		expect(browser.document.body.textContent).toContain("Release");
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
