import { resolve } from "node:path";
import { build, type Rollup } from "vite";
import {
	createIdeRuntimeAliases,
	IDE_RUNTIME_DEDUPE,
} from "../../scripts/vite-runtime-contract.ts";

const ideRoot = resolve(import.meta.dirname, "../..");
const interfaceRoot = resolve(ideRoot, "../interface");

const entry = resolve(ideRoot, "product-native-menu-fixture.ts");
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
			{ find: /^@\/(.+)$/, replacement: `${resolve(interfaceRoot, "src")}/$1` },
		],
		dedupe: [...IDE_RUNTIME_DEDUPE],
	},
	plugins: [
		{
			name: "product-native-menu-fixture",
			enforce: "pre",
			resolveId(id, importer) {
				if (importer?.endsWith("/src/product/application-native-menu.tsx")) {
					if (id === "@tauri-apps/api/core") return "virtual:native-core";
					if (id === "@tauri-apps/api/event") return "virtual:native-event";
				}
				return id === entry || id.startsWith("virtual:native-") ? id : null;
			},
			load(id) {
				if (id === "virtual:native-core")
					return `export const invoke = (...args) => globalThis.native.publish(...args);`;
				if (id === "virtual:native-event")
					return `export const listen = (...args) => globalThis.native.listen(...args);`;
				return id === entry
					? `
      import { createElement } from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { createIdeNativeMenuBridge } from './src/product/application-native-menu';
      import { warmApplicationMenus, configureApplicationRecentProjectsRuntime } from '@forgeax/interface/application';
      import { configureStudioDomainClients } from './src/product/product-clients';
      import { ideRecentProjectsRuntime } from './src/product/recent-projects-runtime';
      configureApplicationRecentProjectsRuntime(ideRecentProjectsRuntime);
      export { ideRecentProjectsRuntime };
      import { getRecentGames, warmRecentGames } from '@forgeax/interface/lib/recent-games';
      export { createAppHost } from '@forgeax/interface/core/app-shell';
      export { changeLanguage } from './src/product/product-locale';
      export const sameWarmer = warmApplicationMenus === warmRecentGames;
      export { getRecentGames };
      configureStudioDomainClients({ projects: { listProjects: () => globalThis.native.projects() } });
      const Bridge = createIdeNativeMenuBridge(ideRecentProjectsRuntime.warm);
      export function mount(runtime) {
        const container = document.createElement('div'); document.body.append(container);
        const root = createRoot(container);
        flushSync(() => root.render(createElement(Bridge, { runtime })));
        return () => { flushSync(() => root.unmount()); container.remove(); };
      }
    `
					: null;
			},
		},
	],
	build: {
		write: false,
		minify: false,
		lib: { entry, formats: ["iife"], name: "ProductNativeMenu" },
	},
});
const result = (
	Array.isArray(output) ? output[0] : output
) as Rollup.RollupOutput;
const code = result.output.find(
	(item): item is Rollup.OutputChunk => item.type === "chunk",
)!.code;
process.stdout.write(JSON.stringify(code));
