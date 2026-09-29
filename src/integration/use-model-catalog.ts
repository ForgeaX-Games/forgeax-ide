import type { ModelCatalogState } from "@forgeax/chat/runtime";
import { useEffect, useState } from "react";
import {
	listModelsWithMeta,
	type ModelCatalogWithMeta,
} from "./rest-model-config-client";

// Composer, TopBar and Settings share one browser-side catalog request. The
// server owns its upstream TTL; this layer only prevents duplicate product
// requests and keeps mounted consumers synchronized.
function cacheKey(providerId?: string | null): string {
	return providerId?.trim() || "gateway";
}

export interface ModelCatalogService {
	peek(providerId?: string | null): ModelCatalogWithMeta | undefined;
	subscribe(
		providerId: string | null | undefined,
		subscriber: (payload: ModelCatalogWithMeta) => void,
	): () => void;
	load(
		providerId?: string | null,
		force?: boolean,
	): Promise<ModelCatalogWithMeta>;
	refreshAll(): Promise<void>;
}

export function createModelCatalogService(
	fetchCatalog: (
		providerId?: string | null,
	) => Promise<ModelCatalogWithMeta> = listModelsWithMeta,
): ModelCatalogService {
	const cached = new Map<string, ModelCatalogWithMeta>();
	const inflight = new Map<string, Promise<ModelCatalogWithMeta>>();
	const subscribers = new Map<
		string,
		Set<(payload: ModelCatalogWithMeta) => void>
	>();

	function subscriberSet(
		key: string,
	): Set<(payload: ModelCatalogWithMeta) => void> {
		let set = subscribers.get(key);
		if (!set) {
			set = new Set();
			subscribers.set(key, set);
		}
		return set;
	}

	async function load(
		providerId?: string | null,
		force = false,
	): Promise<ModelCatalogWithMeta> {
		const key = cacheKey(providerId);
		const hit = cached.get(key);
		if (hit && !force) return hit;

		const current = inflight.get(key);
		if (current) return current;

		const next = (async () => {
			try {
				const payload = await fetchCatalog(providerId);
				cached.set(key, payload);
				for (const subscriber of subscriberSet(key)) subscriber(payload);
				return payload;
			} finally {
				inflight.delete(key);
			}
		})();
		inflight.set(key, next);
		return next;
	}

	return {
		peek(providerId) {
			return cached.get(cacheKey(providerId));
		},

		subscribe(providerId, subscriber) {
			const set = subscriberSet(cacheKey(providerId));
			set.add(subscriber);
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				set.delete(subscriber);
			};
		},

		load,

		async refreshAll() {
			const keys = new Set([...cached.keys(), ...subscribers.keys()]);
			await Promise.all(
				[...keys].map((key) =>
					load(key === "gateway" ? undefined : key, true).catch(
						() => undefined,
					),
				),
			);
		},
	};
}

const modelCatalogService = createModelCatalogService();

export function useModelCatalog(providerId?: string | null): ModelCatalogState {
	const [payload, setPayload] = useState<ModelCatalogWithMeta | null>(
		modelCatalogService.peek(providerId) ?? null,
	);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		const subscriber = (next: ModelCatalogWithMeta): void => {
			if (!cancelled) setPayload(next);
		};
		const unsubscribe = modelCatalogService.subscribe(providerId, subscriber);

		const hit = modelCatalogService.peek(providerId);
		if (hit) {
			setPayload(hit);
		} else {
			modelCatalogService
				.load(providerId)
				.then((next) => {
					if (!cancelled) {
						setPayload(next);
						setError(null);
					}
				})
				.catch((cause: unknown) => {
					if (!cancelled)
						setError(cause instanceof Error ? cause.message : String(cause));
				});
		}

		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [providerId]);

	const refresh = async (): Promise<void> => {
		try {
			await modelCatalogService.load(providerId, true);
			setError(null);
		} catch (cause: unknown) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	};

	return {
		models: payload?.models ?? null,
		driver: payload?.driver ?? null,
		error,
		refresh,
	};
}

export async function refreshAllModelCatalogs(): Promise<void> {
	await modelCatalogService.refreshAll();
}
