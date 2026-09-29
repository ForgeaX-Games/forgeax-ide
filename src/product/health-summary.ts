import { createSettledPollingLifecycle } from "@forgeax/app-shell/react";
import { useSyncExternalStore } from "react";

interface HealthSummary {
	readonly uptime?: number;
	readonly wsClients?: number;
	readonly mem?: { readonly rss?: number };
}

type Snapshot =
	| { readonly state: "loading" }
	| { readonly state: "down" }
	| { readonly state: "ok"; readonly value: HealthSummary };

let snapshot: Snapshot = { state: "loading" };
const listeners = new Set<() => void>();
let stop: (() => void) | undefined;
const getSnapshot = () => snapshot;

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	if (listeners.size === 1) {
		const poll = createSettledPollingLifecycle({
			intervalMs: 5_000,
			timeoutMs: 5_000,
			async task(signal) {
				try {
					const response = await fetch("/api/health", {
						cache: "no-store",
						signal,
					});
					if (!response.ok) throw new Error(`/api/health ${response.status}`);
					const value = (await response.json()) as HealthSummary;
					signal.throwIfAborted();
					snapshot = { state: "ok", value };
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

/** Product-selected health projection with App Shell's settled polling lifecycle. */
export function useSharedHealth(): Snapshot {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
