import {
	type AppHost,
	type ApplicationShortcut,
	installApplicationKeyboardRouter,
} from "@forgeax/app-shell/application";
import { useEffect } from "react";
import { getIdeShellStore } from "./shell-state-runtime";

/** Product editor and composer surfaces remain authoritative at event time. */
export function isIdeTypingTarget(event: KeyboardEvent): boolean {
	if (
		typeof document !== "undefined" &&
		document.querySelector('.im-editor[data-listening="1"]')
	)
		return true;
	const target = event.target;
	if (!target || !(target instanceof Element)) return false;
	if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return true;
	if ((target as HTMLElement).isContentEditable) return true;
	return (
		target.closest(
			'.im-editor, .kc-composer-rich, [data-kc-composer], [contenteditable="true"]',
		) !== null
	);
}

export function shouldSkipIdeShortcut(
	event: KeyboardEvent,
	shortcut: ApplicationShortcut,
): boolean {
	if (shortcut.group !== "edit") return false;
	const target = event.target;
	if (target instanceof Element && target.closest("[data-fx-keyboard-surface]"))
		return true;
	if (getIdeShellStore().getState().activeOverlay) return true;
	const anchor =
		typeof document === "undefined"
			? null
			: document.querySelector<HTMLElement>('[data-surface-anchor="edit"]');
	return !anchor || anchor.getClientRects().length === 0;
}

export interface IdeKeyboardRuntime {
	readonly host: Pick<AppHost, "keybindings" | "shortcuts">;
	readonly shellShortcuts?: readonly ApplicationShortcut[];
}

const NO_SHORTCUTS: readonly ApplicationShortcut[] = [];
export function IdeKeyboardRouter({
	runtime,
}: {
	readonly runtime: IdeKeyboardRuntime;
}): null {
	useEffect(
		() =>
			installApplicationKeyboardRouter({
				keybindings: runtime.host.keybindings,
				contributions: runtime.host.shortcuts,
				shortcuts: runtime.shellShortcuts ?? NO_SHORTCUTS,
				isTypingTarget: isIdeTypingTarget,
				shouldSkipShortcut: shouldSkipIdeShortcut,
			}),
		[runtime],
	);
	return null;
}
