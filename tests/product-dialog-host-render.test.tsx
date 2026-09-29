import { applicationDialogs } from "@forgeax/app-shell/application";
import { Window } from "happy-dom";
import { expect, test } from "vitest";

test("IDE dialog presentation settles the shared confirm and unsaved queues", async () => {
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
		const { IdeDialogHost } = await import("../src/product/dialog-host");
		const mount = browser.document.createElement("div");
		browser.document.body.append(mount);
		root = createRoot(mount as unknown as Parameters<typeof createRoot>[0]);

		let confirm!: Promise<boolean>;
		await act(async () => {
			confirm = applicationDialogs.confirm({
				body: "Delete this?",
				danger: true,
			});
			root?.render(createElement(IdeDialogHost));
		});
		const confirmDialog = browser.document.querySelector(
			'[role="alertdialog"]',
		);
		expect(confirmDialog?.textContent).toContain("Delete this?");
		expect(confirmDialog?.textContent).toContain("Confirm action");
		const confirmButton = [...browser.document.querySelectorAll("button")].find(
			(button) => button.textContent === "Confirm",
		);
		await act(async () =>
			confirmButton?.dispatchEvent(
				new browser.MouseEvent("click", { bubbles: true }),
			),
		);
		expect(await confirm).toBe(true);

		let unsaved!: Promise<"save" | "discard" | "cancel">;
		await act(async () => {
			unsaved = applicationDialogs.unsaved({ body: "Save before closing?" });
		});
		const unsavedDialog = browser.document.querySelector(
			'[role="alertdialog"]',
		);
		expect(unsavedDialog?.textContent).toContain("Save before closing?");
		const discardButton = [...browser.document.querySelectorAll("button")].find(
			(button) => button.textContent === "Don't Save",
		);
		await act(async () =>
			discardButton?.dispatchEvent(
				new browser.MouseEvent("click", { bubbles: true }),
			),
		);
		expect(await unsaved).toBe("discard");
		expect(applicationDialogs.getSnapshot()).toHaveLength(0);
	} finally {
		const { act } = await import("react");
		await act(async () => root?.unmount());
		applicationDialogs.cancelAll();
		await browser.happyDOM.close();
		for (const [name, descriptor] of Object.entries(previous)) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
	}
});
