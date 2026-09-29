import type { ApplicationShortcut } from "@forgeax/app-shell/application";
import type { SettingsRuntime } from "@forgeax/settings";

type SettingsShortcut = ReturnType<SettingsRuntime["buildShortcuts"]>[number];
const settingsGroups: Record<SettingsShortcut["group"], true> = {
	layout: true,
	mode: true,
	overlay: true,
	focus: true,
	general: true,
	edit: true,
};

function isSettingsGroup(group: string): group is SettingsShortcut["group"] {
	return Object.hasOwn(settingsGroups, group);
}

// Settings owns a closed display taxonomy; application routing groups stay open.
// Read live labels at the builder boundary without changing any registration.
export function toSettingsShortcutDescriptions(
	shortcuts: readonly Pick<ApplicationShortcut, "combo" | "label" | "group">[],
): SettingsShortcut[] {
	return shortcuts.map(({ combo, label, group }) => ({
		combo,
		label,
		group: isSettingsGroup(group) ? group : "general",
	}));
}
