import type {
	AppHost,
	ApplicationShortcut,
} from "@forgeax/app-shell/application";
import {
	createProductShellShortcuts,
	describeProductShortcuts,
} from "../product/shell-shortcuts";
import { useShellStore } from "../product/shell-state-runtime";

// One catalog per runtime. Settings reads exactly the definitions given to its router.
// Weak ownership does not keep disposed application hosts alive across recovery.
const catalogs = new WeakMap<AppHost, readonly ApplicationShortcut[]>();

export function createIdeShellShortcutFactory(t: (key: string) => string) {
	return function createIdeShellShortcuts({
		host,
		toggleCommandPalette,
	}: {
		host: AppHost;
		toggleCommandPalette: () => void;
	}): readonly ApplicationShortcut[] {
		const existing = catalogs.get(host);
		if (existing) return existing;
		const shortcuts = createProductShellShortcuts({
			getState: useShellStore.getState,
			t,
			toggleCommandPalette,
		});
		catalogs.set(host, shortcuts);
		return shortcuts;
	};
}

export function buildIdeShortcutDescriptions(
	host: AppHost,
): readonly ApplicationShortcut[] {
	const shortcuts = catalogs.get(host);
	if (!shortcuts)
		throw new Error(
			"Product shortcuts must be configured before Settings renders",
		);
	return describeProductShortcuts(shortcuts, host.shortcuts);
}
