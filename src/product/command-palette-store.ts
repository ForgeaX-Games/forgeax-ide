import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();

function notify(): void {
	for (const listener of listeners) listener();
}

export function getIdeCommandPaletteOpen(): boolean {
	return open;
}
export function setIdeCommandPaletteOpen(next: boolean): void {
	if (open === next) return;
	open = next;
	notify();
}
export function toggleIdeCommandPalette(): void {
	setIdeCommandPaletteOpen(!open);
}
export function subscribeIdeCommandPalette(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
export function useIdeCommandPaletteOpen(): boolean {
	return useSyncExternalStore(
		subscribeIdeCommandPalette,
		getIdeCommandPaletteOpen,
		() => false,
	);
}
