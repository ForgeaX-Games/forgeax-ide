import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { build, type Rollup } from "vite";
import { expect, test } from "vitest";
import {
	createIdeRuntimeAliases,
	IDE_RUNTIME_DEDUPE,
} from "../scripts/vite-runtime-contract";

const ideRoot = resolve(import.meta.dirname, "..");
const interfaceRoot = resolve(ideRoot, "../interface");

test("the product owner recognizes real cleanup barriers across installed importer roots", async () => {
	const entry = resolve(ideRoot, "product-owner-fixture.ts");
	const legacy = resolve(interfaceRoot, "src/product-owner-errors-fixture.ts");
	const output = await build({
		root: ideRoot,
		configFile: false,
		logLevel: "silent",
		resolve: {
			alias: createIdeRuntimeAliases({ ideRoot, interfaceRoot }),
			dedupe: [...IDE_RUNTIME_DEDUPE],
		},
		plugins: [
			{
				name: "product-owner-fixture",
				resolveId(id) {
					return id === entry || id === legacy ? id : null;
				},
				load(id) {
					if (id === entry)
						return `
        export { createIdeApplicationOwner } from './src/product/application-owner';
        export { ExtensionCleanupDeferredError, ExtensionUnloadDeferredError } from '@forgeax/extension-platform/extensions';
        export { PageClosePreparationDeferredError } from '@forgeax/app-shell/pages';
        export * as legacy from ${JSON.stringify(legacy)};
      `;
					if (id === legacy)
						return `export { ExtensionCleanupDeferredError, ExtensionUnloadDeferredError } from '@forgeax/extension-platform/extensions'; export { PageClosePreparationDeferredError } from '@forgeax/app-shell/pages';`;
					return null;
				},
			},
		],
		build: {
			write: false,
			minify: false,
			lib: { entry, formats: ["iife"], name: "ProductOwner" },
		},
	});
	const result = (
		Array.isArray(output) ? output[0] : output
	) as Rollup.RollupOutput;
	const chunk = result.output.find(
		(item): item is Rollup.OutputChunk => item.type === "chunk",
	)!;
	const runtime = runInNewContext(`${chunk.code}\nProductOwner`, {
		process: { env: { NODE_ENV: "production" } },
		queueMicrotask,
	});
	for (const name of [
		"ExtensionCleanupDeferredError",
		"ExtensionUnloadDeferredError",
		"PageClosePreparationDeferredError",
	]) {
		expect(runtime[name]).toBe(runtime.legacy[name]);
		const owner = runtime.createIdeApplicationOwner();
		let blocked = true;
		let disposals = 0;
		const error =
			name === "ExtensionUnloadDeferredError"
				? new runtime.legacy[name]("owner", new Error("pending"))
				: new runtime.legacy[name]("pending");
		const lease = owner.acquire(async () => ({
			host: {},
			async dispose() {
				disposals++;
				if (blocked) throw error;
			},
		}));
		await lease.ready;
		lease.release();
		await new Promise((done) => setTimeout(done, 0));
		expect(owner.getSnapshot()).toMatchObject({
			status: "blocked",
			retryable: true,
		});
		blocked = false;
		await owner.retryShutdown();
		expect(disposals).toBe(2);
		expect(owner.getSnapshot()).toEqual({ status: "ready" });
	}
	const owner = runtime.createIdeApplicationOwner();
	const ordinary = Object.assign(new Error("ordinary teardown"), {
		code: "extension.cleanup-deferred",
	});
	const lease = owner.acquire(async () => ({
		host: {},
		dispose() {
			throw ordinary;
		},
	}));
	await lease.ready;
	lease.release();
	await new Promise((done) => setTimeout(done, 0));
	expect(owner.getSnapshot()).toMatchObject({
		status: "blocked",
		retryable: false,
	});
	await expect(owner.retryShutdown()).rejects.toBe(ordinary);
});
