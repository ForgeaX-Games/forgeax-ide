import { createSettledPollingLifecycle } from "@forgeax/app-shell/react";
import { useSyncExternalStore } from "react";

export type ExtensionCountKind = "model-binding" | "skill" | "tool" | "agent";
type ExtensionCounts = Record<
	ExtensionCountKind,
	{ count: number; ids: string[] }
>;
type Snapshot =
	| { state: "loading" | "down" }
	| { state: "ok"; value: ExtensionCounts };

function countExtensions(
	items: readonly { id: string; kind: string }[],
): ExtensionCounts {
	const counts: ExtensionCounts = {
		"model-binding": { count: 0, ids: [] },
		skill: { count: 0, ids: [] },
		tool: { count: 0, ids: [] },
		agent: { count: 0, ids: [] },
	};
	for (const item of items) {
		if (!Object.hasOwn(counts, item.kind)) continue;
		const row = counts[item.kind as ExtensionCountKind];
		row.count++;
		row.ids.push(item.id);
	}
	return counts;
}

// One page-level request shared by all mounted product pulse chips. AppShell
// owns scheduling/backoff; IDE selects the endpoint, cadence and projection.
let snapshot: Snapshot = { state: "loading" };
const listeners = new Set<() => void>();
let stop: (() => void) | undefined;
const getSnapshot = () => snapshot;
function subscribe(listener: () => void) {
	listeners.add(listener);
	if (listeners.size === 1) {
		const poll = createSettledPollingLifecycle({
			intervalMs: 12_000,
			timeoutMs: 5_000,
			async task(signal) {
				try {
					const response = await fetch("/api/extensions/list", {
						cache: "no-store",
						signal,
					});
					if (!response.ok)
						throw new Error(`/api/extensions/list ${response.status}`);
					const payload = (await response.json()) as {
						items: { id: string; kind: string }[];
					};
					signal.throwIfAborted();
					snapshot = { state: "ok", value: countExtensions(payload.items) };
				} catch (error) {
					if (!signal.aborted) snapshot = { state: "down" };
					throw error;
				} finally {
					if (!signal.aborted)
						listeners.forEach((notify) => {
							notify();
						});
				}
			},
		});
		stop = poll.dispose;
		poll.start();
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) {
			stop?.();
			stop = undefined;
		}
	};
}

export function useExtensionCounts() {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
