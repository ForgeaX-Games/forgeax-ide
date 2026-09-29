import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build, createServer, type Rollup } from "vite";
import { describe, expect, test } from "vitest";
import {
	createIdeRuntimeAliases,
	IDE_OPTIMIZE_DEPS_EXCLUDE,
	IDE_RUNTIME_DEDUPE,
} from "../scripts/vite-runtime-contract";

const ideRoot = resolve(import.meta.dirname, "..");
const interfaceRoot = resolve(ideRoot, "../interface");
const publicEntry = (specifier: string): string =>
	fileURLToPath(import.meta.resolve(specifier));

function chunks(
	output: Awaited<ReturnType<typeof build>>,
): Rollup.OutputChunk[] {
	const outputs = Array.isArray(output) ? output : [output];
	return outputs
		.flatMap((entry) => ("output" in entry ? entry.output : []))
		.filter((entry): entry is Rollup.OutputChunk => entry.type === "chunk");
}

describe("IDE Vite runtime contract", () => {
	test("product shortcut catalog shares live store and Settings definitions without importing the compatibility builder", async () => {
		const entry = resolve(ideRoot, "shortcut-ownership.ts");
		const output = await build({
			root: ideRoot,
			configFile: false,
			logLevel: "silent",
			resolve: {
				alias: [
					...createIdeRuntimeAliases({ ideRoot, interfaceRoot }),
					{
						find: /^@forgeax\/interface\/(.+)$/,
						replacement: `${resolve(interfaceRoot, "src")}/$1`,
					},
					{
						find: /^@\/(.+)$/,
						replacement: `${resolve(interfaceRoot, "src")}/$1`,
					},
				],
				dedupe: [...IDE_RUNTIME_DEDUPE],
			},
			plugins: [
				{
					name: "shortcut-ownership-entry",
					resolveId(id) {
						return id === entry ? id : null;
					},
					load(id) {
						return id === entry
							? `
          import { createIdeShellShortcutFactory, buildIdeShortcutDescriptions } from './src/integration/product-shortcuts';
          import { t } from './src/product/product-locale';
          import { initializeIdeShellStore, getIdeShellStore } from './src/product/shell-state-runtime';
          import { createApplicationShellStoreContext, configureApplicationShellStore } from '@forgeax/interface/application';
          initializeIdeShellStore(createApplicationShellStoreContext());
          configureApplicationShellStore(getIdeShellStore);
          export const factory = createIdeShellShortcutFactory(t);
          export { buildIdeShortcutDescriptions as describe };
          export { buildShortcuts as compatibility } from '@forgeax/interface/lib/global-shortcuts';
          export { useShellStore as store } from '@forgeax/interface/store';
          export { setLocale, configureLocaleRuntime as configureLocale, getLocale as compatibilityLocale, t as compatibilityT } from '@forgeax/interface/i18n';
          export { createIdeLocaleRuntime, getLocale as productLocale, setLocale as setProductLocale, t as productT } from './src/product/product-locale';
          export { createApplicationShortcutRegistry as registry } from '@forgeax/app-shell/application';
        `
							: null;
					},
				},
			],
			build: {
				write: false,
				minify: false,
				lib: { entry, formats: ["iife"], name: "ShortcutOwnership" },
			},
		});
		const entries = chunks(output);
		expect(entries).toHaveLength(1);
		const runtime = runInNewContext(`${entries[0]!.code}\nShortcutOwnership`, {
			process: { env: { NODE_ENV: "production" } },
		});
		const host = { shortcuts: runtime.registry() };
		runtime.configureLocale(runtime.createIdeLocaleRuntime);
		let toggles = 0;
		const catalog = runtime.factory({
			host,
			toggleCommandPalette: () => {
				toggles++;
			},
		});
		expect(runtime.factory({ host, toggleCommandPalette: () => {} })).toBe(
			catalog,
		);
		const rows = (items: any[]) =>
			Array.from(items, ({ combo, group, label, priority, allowInInput }) => ({
				combo,
				group,
				label,
				priority,
				allowInInput,
			}));
		expect(rows(catalog)).toEqual(rows(runtime.compatibility()));
		expect(runtime.describe(host)[0]).toBe(catalog[0]);
		for (const locale of ["zh", "en"]) {
			runtime.setLocale(locale);
			expect(runtime.productLocale()).toBe(locale);
			expect(runtime.compatibilityT("errorBoundary.retry")).toBe(
				runtime.productT("errorBoundary.retry"),
			);
			expect(rows(runtime.describe(host))).toEqual(
				rows(runtime.compatibility()),
			);
		}
		runtime.setProductLocale("zh");
		expect(runtime.compatibilityLocale()).toBe("zh");
		expect(rows(runtime.describe(host))).toEqual(rows(runtime.compatibility()));
		const legacy = runtime.compatibility();
		for (const key of [
			",",
			"/",
			"Escape",
			"F1",
			"Enter",
			"k",
			")",
			undefined,
		]) {
			for (const code of [
				"Comma",
				"Slash",
				"KeyF",
				"KeyB",
				"KeyC",
				"KeyD",
				"KeyH",
				"Digit0",
				"KeyK",
				"Enter",
				undefined,
			]) {
				for (let mask = 0; mask < 16; mask++) {
					const event = {
						key,
						code,
						ctrlKey: Boolean(mask & 1),
						metaKey: Boolean(mask & 2),
						shiftKey: Boolean(mask & 4),
						altKey: Boolean(mask & 8),
					};
					expect(
						Array.from(catalog, (shortcut: any) => shortcut.match(event)),
					).toEqual(
						Array.from(legacy, (shortcut: any) => shortcut.match(event)),
					);
				}
			}
		}
		runtime.store.setState({ activeOverlay: null });
		catalog.find((s: any) => s.combo === "Ctrl+,").run({});
		expect(runtime.store.getState().activeOverlay).toBe("settings");
		runtime.store.setState({ activeOverlay: "settings" });
		catalog.find((s: any) => s.combo === "Ctrl+,").run({});
		expect(runtime.store.getState().activeOverlay).toBeNull();
		catalog.at(-1).run({});
		expect(toggles).toBe(1);
		const other = { shortcuts: runtime.registry() };
		expect(
			runtime.factory({ host: other, toggleCommandPalette: () => {} }),
		).not.toBe(catalog);
		host.shortcuts.dispose();
		other.shortcuts.dispose();
	});

	test("shares the real product queue with Interface compatibility writers", async () => {
		const entry = resolve(ideRoot, "composer-ownership.ts");
		const output = await build({
			root: ideRoot,
			configFile: false,
			logLevel: "silent",
			resolve: {
				alias: [
					...createIdeRuntimeAliases({ ideRoot, interfaceRoot }),
					{
						find: /^@forgeax\/interface\/(.+)$/,
						replacement: `${resolve(interfaceRoot, "src")}/$1`,
					},
					{
						find: /^@\/(.+)$/,
						replacement: `${resolve(interfaceRoot, "src")}/$1`,
					},
				],
				dedupe: [...IDE_RUNTIME_DEDUPE],
			},
			plugins: [
				{
					name: "composer-ownership-entry",
					resolveId(id) {
						return id === entry ? id : null;
					},
					load(id) {
						return id === entry
							? `
            export { configureComposerInsertRuntime as configure, requestComposerInsert as legacyRequest, clearComposerPendingInsert as legacyClear } from '@forgeax/interface/lib/composer-bridge';
            export { createComposerInsertRuntimeBinding as createBinding } from '@forgeax/interface/lib/composer-insert-runtime';
            export { createComposerReferenceQueue as createQueue, createIdeComposerInsertRuntime as factory, requestComposerInsert as productRequest, clearComposerPendingInsert as productClear, useComposerPendingInsert } from './src/integration/composer-reference-queue';
          `
							: null;
					},
				},
			],
			build: {
				write: false,
				minify: false,
				lib: { entry, formats: ["iife"], name: "ComposerOwnership" },
			},
		});
		const entries = chunks(output);
		expect(entries).toHaveLength(1);
		const runtime = runInNewContext(`${entries[0]!.code}\nComposerOwnership`, {
			process: { env: { NODE_ENV: "production" } },
		});
		const pill = (display: string) => ({
			kind: "file",
			display,
			detail: display,
			tooltip: { title: display, lines: [] },
		});
		const early = pill("early"),
			product = pill("product"),
			legacy = pill("legacy");
		runtime.legacyRequest(early);
		runtime.configure(runtime.factory);
		const queue = runtime.factory([]);
		expect(queue.getQueue()[0]).toBe(early);
		runtime.productRequest(product);
		runtime.legacyRequest(legacy);
		expect(Array.from(queue.getQueue())).toEqual([early, product, legacy]);
		runtime.legacyClear();
		expect(queue.getPending()).toBe(product);
		runtime.configure(runtime.factory);
		runtime.productClear();
		expect(queue.getPending()).toBe(legacy);
		runtime.legacyClear();
		expect(queue.getPending()).toBeNull();
		expect(typeof runtime.useComposerPendingInsert).toBe("function");
		// Initial adoption cannot invoke a subscriber which reenters the old
		// queue and causes the provider to reject every subsequent startup retry.
		const binding = runtime.createBinding();
		const owner = runtime.createQueue();
		binding.request(early);
		let adoptionCalls = 0;
		const stop = owner.runtime.subscribe(() => {
			adoptionCalls++;
			binding.request(legacy);
		});
		binding.configure(owner.createRuntime);
		binding.configure(owner.createRuntime);
		expect(adoptionCalls).toBe(0);
		expect(binding.getPending()).toBe(early);
		expect(binding.getQueue()).toBe(owner.runtime.getQueue());
		stop();
	});

	test("injects product page services and shares project identity with compatibility readers", async () => {
		const entry = resolve(ideRoot, "product-pages-identity.ts");
		const output = await build({
			root: ideRoot,
			configFile: false,
			logLevel: "silent",
			resolve: {
				alias: [
					...createIdeRuntimeAliases({ ideRoot, interfaceRoot }),
					{
						find: /^@forgeax\/interface\/(.+)$/,
						replacement: `${resolve(interfaceRoot, "src")}/$1`,
					},
					{
						find: /^@\/(.+)$/,
						replacement: `${resolve(interfaceRoot, "src")}/$1`,
					},
				],
				dedupe: [...IDE_RUNTIME_DEDUPE],
			},
			plugins: [
				{
					name: "product-pages-identity",
					resolveId(id) {
						return id === entry ? id : null;
					},
					load(id) {
						return id === entry
							? `
          import { createAppHost } from '@forgeax/interface/core/app-shell/host';
          import { configureApplicationProjectContext } from '@forgeax/interface/application';
          import { createIdePageServices } from './src/product/page-services';
          import { ideProjectContext } from './src/product/project-context';
          configureApplicationProjectContext(ideProjectContext);
          export { ideProjectContext as project };
          export { getCurrentProject, setCurrentProject, subscribeCurrentProject } from '@forgeax/interface/lib/project-context';
          export { PageClosePreparationDeferredError as legacyError } from '@forgeax/interface/core/page-platform/session';
          export { PageClosePreparationDeferredError as sharedError } from '@forgeax/app-shell/pages';
          export { qualifyContributionId } from '@forgeax/types/page';
          export let selected;
          export const result = createAppHost({ createPageServices(commands) { selected = createIdePageServices(commands); return selected; } });
        `
							: null;
					},
				},
			],
			build: {
				write: false,
				minify: false,
				lib: { entry, formats: ["iife"], name: "ProductPages" },
			},
		});
		const entries = chunks(output);
		expect(entries).toHaveLength(1);
		const values = new Map<string, string>();
		const storage = {
			get length() {
				return values.size;
			},
			key: (index: number) => [...values.keys()][index] ?? null,
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
			removeItem: (key: string) => values.delete(key),
		};
		const runtime = runInNewContext(`${entries[0]!.code}\nProductPages`, {
			process: { env: { NODE_ENV: "production" } },
			localStorage: storage,
			crypto,
		});
		expect(runtime.result.host.pages).toBe(runtime.selected.pages);
		expect(runtime.legacyError).toBe(runtime.sharedError);
		const changes: string[] = [];
		const remove = runtime.subscribeCurrentProject((id: string) =>
			changes.push(id),
		);
		runtime.project.setCurrentProject("alpha");
		expect(runtime.getCurrentProject()).toBe("alpha");
		runtime.setCurrentProject("beta");
		expect(runtime.project.getCurrentProject()).toBe("beta");
		expect(changes).toEqual(["alpha", "beta"]);
		const owner = "@forgeax-plugin/product-page-test";
		const pageId = runtime.qualifyContributionId(owner, "page", "project");
		const panelId = runtime.qualifyContributionId(owner, "panel", "main");
		runtime.result.control.contributePagePlatform(owner, {
			panelTypes: [
				{ id: panelId, runtime: { kind: "inline", render: () => null } },
			],
			pageTypes: [
				{
					id: pageId,
					title: "Project",
					cardinality: "singleton",
					restorePolicy: "project",
					panels: [{ id: "main", panelTypeId: panelId }],
					layout: { version: 1, root: { kind: "tabs", placements: ["main"] } },
				},
			],
		});
		await runtime.result.host.pages.open({ typeId: pageId });
		expect(
			JSON.parse(values.get("forgeax:project:beta:recent-page")!).typeId,
		).toBe(pageId);
		remove();
		await runtime.result.control.dispose();
	});

	test("shares the dialog service and host across IDE and Interface importer roots", async () => {
		const alias = createIdeRuntimeAliases({ ideRoot, interfaceRoot });
		const callers = [
			resolve(ideRoot, "src/dialog-caller.ts"),
			resolve(interfaceRoot, "src/dialog-host.ts"),
		];
		const entry = resolve(ideRoot, "dialog-identity.ts");
		const server = await createServer({
			root: ideRoot,
			configFile: false,
			logLevel: "silent",
			resolve: { alias, dedupe: [...IDE_RUNTIME_DEDUPE] },
			optimizeDeps: {
				noDiscovery: true,
				exclude: [...IDE_OPTIMIZE_DEPS_EXCLUDE],
			},
			server: { middlewareMode: true },
		});
		try {
			for (const entry of ["application", "react", "pages"]) {
				const specifier = `@forgeax/app-shell/${entry}`;
				const ids = await Promise.all(
					callers.map((importer) =>
						server.pluginContainer.resolveId(specifier, importer),
					),
				);
				expect(ids[0]?.id).toBe(realpathSync(publicEntry(specifier)));
				expect(ids[1]?.id).toBe(ids[0]?.id);
				expect(IDE_OPTIMIZE_DEPS_EXCLUDE as readonly string[]).toContain(
					specifier,
				);
			}
		} finally {
			await server.close();
		}

		const output = await build({
			root: ideRoot,
			configFile: false,
			logLevel: "silent",
			resolve: { alias, dedupe: [...IDE_RUNTIME_DEDUPE] },
			plugins: [
				{
					name: "cross-root-dialog-fixture",
					resolveId(id) {
						return id === entry || callers.includes(id) ? id : null;
					},
					load(id) {
						if (id === entry)
							return `export { PageClosePreparationDeferredError as callerError } from '@forgeax/app-shell/pages'; export { PageClosePreparationDeferredError as hostError } from '@forgeax/app-shell/application'; export { applicationDialogs as caller } from ${JSON.stringify(callers[0])}; export { applicationDialogs as host, useApplicationDialogRequest } from ${JSON.stringify(callers[1])};`;
						if (callers.includes(id))
							return 'export { applicationDialogs } from "@forgeax/app-shell/application"; export { useApplicationDialogRequest } from "@forgeax/app-shell/react";';
						return null;
					},
				},
			],
			build: {
				write: false,
				minify: false,
				lib: { entry, formats: ["iife"], name: "DialogIdentity" },
			},
		});
		const entries = chunks(output);
		expect(entries).toHaveLength(1);
		const moduleIds = Object.keys(entries[0]!.modules);
		const shellModules = moduleIds.filter((id) => id.includes("/app-shell/"));
		expect(shellModules.length).toBeGreaterThan(0);
		expect(
			shellModules.every((id) =>
				id.startsWith(
					dirname(realpathSync(publicEntry("@forgeax/app-shell/application"))) +
						"/",
				),
			),
		).toBe(true);
		const runtime = runInNewContext(`${entries[0]!.code}\nDialogIdentity`, {
			process: { env: { NODE_ENV: "production" } },
		});
		expect(runtime.caller).toBe(runtime.host);
		expect(runtime.callerError).toBe(runtime.hostError);
		expect(typeof runtime.useApplicationDialogRequest).toBe("function");
		const pending = runtime.caller.confirm({ body: "Cross-root request" });
		const request = runtime.host.getSnapshot()[0];
		expect(request.options.body).toBe("Cross-root request");
		runtime.host.resolveConfirmAlert(request.id, true);
		expect(await pending).toBe(true);
	});

	test("builds the installed App Shell window through its public export", async () => {
		const aliases = createIdeRuntimeAliases({ ideRoot, interfaceRoot });
		expect(
			aliases.some((alias) => alias.find.test("@forgeax/app-shell/window")),
		).toBe(false);
		const output = await build({
			root: ideRoot,
			configFile: false,
			logLevel: "silent",
			resolve: { alias: aliases, dedupe: [...IDE_RUNTIME_DEDUPE] },
			build: {
				write: false,
				minify: false,
				lib: {
					entry: resolve(
						import.meta.dirname,
						"fixtures/app-shell-window-entry.ts",
					),
					formats: ["es"],
				},
			},
		});

		const moduleIds = chunks(output).flatMap((chunk) =>
			Object.keys(chunk.modules),
		);
		expect(moduleIds.some((id) => id.includes("/app-shell/dist/"))).toBe(true);
		expect(
			chunks(output).some((chunk) => chunk.code.includes("resolvedSurfaceKey")),
		).toBe(true);
	});

	test("keeps every stateful Interface entry point out of optimizeDeps snapshots", () => {
		expect(IDE_OPTIMIZE_DEPS_EXCLUDE).toEqual([
			"@forgeax/app-shell/window",
			"@forgeax/app-shell/application",
			"@forgeax/app-shell/react",
			"@forgeax/app-shell/pages",
			"@forgeax/app-shell/dock",
			"@forgeax/extension-platform/extensions",
			"@forgeax/interface/store",
			"@forgeax/interface/store-parts/session-client",
			"@forgeax/interface/lib/menu-registry",
		]);
	});

	test("builds the store and session-client imports as one module identity", async () => {
		const output = await build({
			root: ideRoot,
			configFile: false,
			logLevel: "silent",
			resolve: {
				alias: [
					...createIdeRuntimeAliases({ ideRoot, interfaceRoot }),
					{
						find: /^@forgeax\/interface\/(.+)$/,
						replacement: `${resolve(interfaceRoot, "src")}/$1`,
					},
					{
						find: /^@\/(.+)$/,
						replacement: `${resolve(interfaceRoot, "src")}/$1`,
					},
				],
				dedupe: [...IDE_RUNTIME_DEDUPE],
			},
			build: {
				write: false,
				minify: false,
				lib: {
					entry: resolve(
						import.meta.dirname,
						"fixtures/session-client-identity.ts",
					),
					formats: ["es"],
				},
			},
		});

		const sessionClientId = resolve(
			interfaceRoot,
			"src/store-parts/session-client.ts",
		);
		const moduleIds = chunks(output).flatMap((chunk) =>
			Object.keys(chunk.modules),
		);
		expect(moduleIds.filter((id) => id === sessionClientId)).toHaveLength(1);
	});
});
