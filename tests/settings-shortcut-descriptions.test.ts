import { describe, expect, test } from "vitest";
import { toSettingsShortcutDescriptions } from "../src/integration/settings-shortcut-descriptions";

describe("Settings shortcut presentation boundary", () => {
	test("preserves supported product groups and description order", () => {
		const groups = [
			"layout",
			"mode",
			"overlay",
			"focus",
			"general",
			"edit",
		] as const;
		const shortcuts = groups.map((group, index) => ({
			combo: String(index),
			label: group,
			group,
		}));

		expect(toSettingsShortcutDescriptions(shortcuts)).toEqual(shortcuts);
	});

	test("shows unfamiliar contribution groups as general without changing routing input", () => {
		const shortcuts = Object.freeze([
			Object.freeze({
				combo: "Ctrl+R",
				label: "Inspect runtime",
				group: "runtime-tools",
			}),
			Object.freeze({
				combo: "Ctrl+D",
				label: "Duplicate selection",
				group: "edit",
			}),
		]);

		expect(toSettingsShortcutDescriptions(shortcuts)).toEqual([
			{ combo: "Ctrl+R", label: "Inspect runtime", group: "general" },
			{ combo: "Ctrl+D", label: "Duplicate selection", group: "edit" },
		]);
		expect(shortcuts[0]?.group).toBe("runtime-tools");
	});

	test("reads current labels at each Settings request without replacing contributions", () => {
		let label = "Save";
		const shortcut = Object.freeze({
			combo: "Ctrl+S",
			group: "edit",
			get label() {
				return label;
			},
		});
		const snapshot = Object.freeze([shortcut]);

		expect(toSettingsShortcutDescriptions(snapshot)[0]?.label).toBe("Save");
		label = "Localized save";
		expect(toSettingsShortcutDescriptions(snapshot)[0]?.label).toBe(
			"Localized save",
		);
		expect(snapshot[0]).toBe(shortcut);
	});

	test("does not treat inherited object property names as supported groups", () => {
		for (const group of ["constructor", "toString", "__proto__", ""]) {
			expect(
				toSettingsShortcutDescriptions([{ combo: "X", label: group, group }])[0]
					?.group,
			).toBe("general");
		}
	});

	test("projects descriptions without copying executable shortcut callbacks", () => {
		const shortcut = {
			combo: "G",
			label: "Game View",
			group: "edit",
			match: () => true,
			run: () => true,
		};

		expect(toSettingsShortcutDescriptions([shortcut])).toEqual([
			{ combo: "G", label: "Game View", group: "edit" },
		]);
		expect(toSettingsShortcutDescriptions([])).toEqual([]);
	});
});
