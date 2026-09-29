import type { PillPayload } from "@forgeax/chat/runtime";
import { useSyncExternalStore } from "react";

/** Product state shared by the Chat adapter and the shell's reference writers.
 * Scope is this product page, so application recovery does not discard drafts.
 */
export function createComposerReferenceQueue() {
	let queue: readonly PillPayload[] = [];
	let adopted = false;
	const listeners = new Set<() => void>();
	const emit = () => {
		for (const listener of listeners) listener();
	};
	const runtime = {
		getQueue: () => queue,
		getPending: () => queue[0] ?? null,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		request(payload: PillPayload) {
			queue = [...queue, payload];
			emit();
		},
		clear() {
			queue = queue.slice(1);
			emit();
		},
	};
	return {
		runtime,
		createRuntime(pending: readonly PillPayload[]) {
			if (!adopted) {
				// Older shell requests precede any product-local requests. Preserve
				// object identity, and never import the shell's queue implementation.
				queue = [...pending, ...queue];
				adopted = true;
				// Startup initializes this snapshot before bootstrap/product render.
				// Do not call subscribers inside the shell's ownership handoff: they
				// could write the old queue or throw before installation commits.
				// Ordinary request/clear mutations remain synchronous signals.
			}
			return runtime;
		},
	};
}

const composer = createComposerReferenceQueue();
export const createIdeComposerInsertRuntime = composer.createRuntime;
export const requestComposerInsert = composer.runtime.request;
export const clearComposerPendingInsert = composer.runtime.clear;
const getServerPending = () => null;

export function useComposerPendingInsert(): PillPayload | null {
	return useSyncExternalStore(
		composer.runtime.subscribe,
		composer.runtime.getPending,
		getServerPending,
	);
}
