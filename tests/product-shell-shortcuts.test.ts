import { createApplicationShortcutRegistry } from "@forgeax/app-shell/application";
import { describe, expect, test, vi } from "vitest";
import {
	createProductShellShortcuts,
	describeProductShortcuts,
	type ProductShortcutState,
} from "../src/product/shell-shortcuts";

function fixture() {
	let locale = "en";
	const calls: unknown[] = [];
	let state: ProductShortcutState = {
		activeOverlay: null,
		fullscreen: false,
		chatpanelCollapsed: true,
		toggleFullscreen: () => {
			calls.push("fullscreen");
		},
		toggleSidebar: () => {
			calls.push("sidebar");
		},
		toggleChatpanel: () => {
			calls.push("chat");
		},
		closeOverlay: () => {
			calls.push("close");
		},
		openOverlay: (id, param) => {
			calls.push([id, param]);
		},
		setFullscreen: (value) => {
			calls.push(value);
		},
	};
	const shortcuts = createProductShellShortcuts({
		getState: () => state,
		t: (key) => `${locale}:${key}`,
		toggleCommandPalette: () => {
			calls.push("palette");
		},
	});
	return {
		shortcuts,
		calls,
		setState: (patch: Partial<ProductShortcutState>) => {
			state = { ...state, ...patch };
		},
		setLocale: (next: string) => {
			locale = next;
		},
	};
}
const event = (fields: Partial<KeyboardEvent> = {}) =>
	({
		key: "",
		code: "",
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		shiftKey: false,
		...fields,
	}) as KeyboardEvent;

describe("IDE product shortcut catalog", () => {
	test("keeps the complete product order and explicit dispatch priorities", () => {
		const { shortcuts } = fixture();
		expect(shortcuts.map((s) => s.combo)).toEqual([
			"Ctrl+Shift+F",
			"Ctrl+Shift+Enter",
			"Ctrl+Shift+B",
			"Ctrl+Shift+C",
			"F1",
			"Ctrl+Shift+D",
			"Ctrl+,",
			"Ctrl+Shift+H",
			"Esc",
			"Ctrl+Shift+0",
			"Ctrl+/",
			"Ctrl+K",
		]);
		expect(shortcuts.map((s) => s.priority)).toEqual([
			...Array(11).fill(10),
			-20,
		]);
		expect(shortcuts.filter((s) => s.allowInInput).map((s) => s.combo)).toEqual(
			["Esc", "Ctrl+/"],
		);
		expect(Object.isFrozen(shortcuts)).toBe(true);
	});

	test("updates translated labels without replacing routing definitions", () => {
		const f = fixture();
		const first = f.shortcuts[0]!;
		f.setLocale("zh");
		expect(f.shortcuts[0]).toBe(first);
		expect(first.label).toBe("zh:shortcuts.gameFullscreen");
	});

	test("reads current shell state at dispatch rather than a startup snapshot", () => {
		const f = fixture();
		const settings = f.shortcuts.find((s) => s.combo === "Ctrl+,")!;
		expect(settings.match(event({ key: ",", metaKey: true }))).toBe(true);
		expect(
			settings.match(event({ key: ",", ctrlKey: true, shiftKey: true })),
		).toBe(false);
		settings.run(event());
		f.setState({ activeOverlay: "settings" });
		settings.run(event());
		expect(f.calls).toEqual([["settings", undefined], "close"]);
	});

	test("keeps layout, plugin, changelog and palette actions product-owned", () => {
		const f = fixture();
		for (const combo of [
			"Ctrl+Shift+F",
			"Ctrl+Shift+B",
			"Ctrl+Shift+C",
			"Ctrl+Shift+H",
			"Ctrl+Shift+0",
			"Ctrl+K",
		]) {
			expect(f.shortcuts.find((s) => s.combo === combo)!.run(event())).toBe(
				true,
			);
		}
		expect(f.calls).toEqual([
			"fullscreen",
			"sidebar",
			"chat",
			["settings", "changelog"],
			["settings", "plugins"],
			"palette",
		]);
		expect(f.shortcuts.at(-1)!.match(event({ ctrlKey: true, key: "K" }))).toBe(
			true,
		);
		expect(
			f.shortcuts.at(-1)!.match(event({ ctrlKey: true, key: undefined })),
		).toBe(false);
	});

	test("keeps description deduplication separate from live routing priority and lifetime", () => {
		const f = fixture();
		const registry = createApplicationShortcutRegistry();
		const duplicate = registry.register({ ...f.shortcuts[8]!, priority: 100 });
		const run = vi.fn(() => true);
		const remove = registry.register({
			combo: "Z",
			label: "Extra",
			group: "edit",
			priority: 200,
			match: () => true,
			run,
		});
		const descriptions = describeProductShortcuts(f.shortcuts, registry);
		expect(descriptions.map((s) => s.combo)).toEqual([
			...f.shortcuts.slice(0, -1).map((s) => s.combo),
			"Z",
			"Ctrl+K",
		]);
		expect(descriptions[8]).toBe(f.shortcuts[8]!);
		expect(registry.snapshot()[0]!.combo).toBe("Z");
		const retained = descriptions.at(-2)!;
		remove();
		retained.run(event());
		expect(run).not.toHaveBeenCalled();
		duplicate();
		expect(describeProductShortcuts(f.shortcuts, registry)).toEqual(
			f.shortcuts,
		);
		registry.dispose();
	});

	test("retains distinct labels or groups on the same key", () => {
		const f = fixture();
		const registry = createApplicationShortcutRegistry();
		registry.register({ ...f.shortcuts[8]!, label: "Another owner" });
		registry.register({ ...f.shortcuts[8]!, group: "edit" });
		expect(
			describeProductShortcuts(f.shortcuts, registry).filter(
				(s) => s.combo === "Esc",
			),
		).toHaveLength(3);
		registry.dispose();
	});
});
