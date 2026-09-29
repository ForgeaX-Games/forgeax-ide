import { describe, expect, test } from "vitest";
import type { ModelCatalogWithMeta } from "../src/integration/rest-model-config-client";
import { createModelCatalogService } from "../src/integration/use-model-catalog";

function deferred<T>(): {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(cause: unknown): void;
} {
	let resolve!: (value: T) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<T>((accept, decline) => {
		resolve = accept;
		reject = decline;
	});
	return { promise, resolve, reject };
}

describe("IDE model catalog service", () => {
	test("normalizes provider keys, coalesces in-flight reads, and broadcasts metadata", async () => {
		const request = deferred<ModelCatalogWithMeta>();
		const calls: Array<string | null | undefined> = [];
		const service = createModelCatalogService((providerId) => {
			calls.push(providerId);
			return request.promise;
		});
		const updates: ModelCatalogWithMeta[] = [];
		service.subscribe("codex", (payload) => updates.push(payload));

		const first = service.load(" codex ");
		const second = service.load("codex");
		expect(calls).toEqual([" codex "]);

		const payload: ModelCatalogWithMeta = {
			models: [{ id: "gpt-5" }],
			driver: { id: "codex", source: "kernel", ids: 1 },
		};
		request.resolve(payload);
		expect(await first).toEqual(payload);
		expect(await second).toEqual(payload);
		expect(service.peek("codex")).toEqual(payload);
		expect(updates).toEqual([payload]);
	});

	test("force refreshes known catalogs without notifying disposed subscribers", async () => {
		let revision = 0;
		const service = createModelCatalogService(async (providerId) => ({
			models: [{ id: `${providerId ?? "gateway"}-${++revision}` }],
		}));
		const updates: ModelCatalogWithMeta[] = [];
		const dispose = service.subscribe(null, (payload) => updates.push(payload));

		await service.load(null);
		dispose();
		dispose();
		await service.refreshAll();

		expect(updates).toEqual([{ models: [{ id: "gateway-1" }] }]);
		expect(service.peek(null)).toEqual({ models: [{ id: "gateway-2" }] });
	});

	test("does not let a rejected request poison retries or other known catalogs", async () => {
		const attempts = new Map<string, number>();
		const service = createModelCatalogService(async (providerId) => {
			const key = providerId ?? "gateway";
			const count = (attempts.get(key) ?? 0) + 1;
			attempts.set(key, count);
			if (key === "broken" || count === 1)
				throw new Error(`${key} unavailable`);
			return { models: [{ id: `${key}-ok` }] };
		});

		service.subscribe("broken", () => undefined);
		await expect(service.load("codex")).rejects.toThrow("codex unavailable");
		expect(await service.load("codex")).toEqual({
			models: [{ id: "codex-ok" }],
		});
		await expect(service.refreshAll()).resolves.toBeUndefined();
		expect(service.peek("codex")).toEqual({ models: [{ id: "codex-ok" }] });
		expect(service.peek("broken")).toBeUndefined();
	});
});
