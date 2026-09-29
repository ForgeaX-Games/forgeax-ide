import { resolve } from "node:path";
import { build, type Rollup } from "vite";
import {
	createIdeRuntimeAliases,
	IDE_RUNTIME_DEDUPE,
} from "../../scripts/vite-runtime-contract.ts";

const ideRoot = resolve(import.meta.dirname, "../..");
const interfaceRoot = resolve(ideRoot, "../interface");

const entry = resolve(ideRoot, "product-keyboard-fixture.ts");
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
			name: "product-keyboard-fixture",
			resolveId(id) {
				return id === entry ? id : null;
			},
			load(id) {
				return id === entry
					? `
      import { createElement, StrictMode } from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { IdeKeyboardRouter } from './src/product/application-keyboard';
      export { isIdeTypingTarget, shouldSkipIdeShortcut } from './src/product/application-keyboard';
      export { registerGlobalKeydownHandler as compatibilityRegister } from '@forgeax/interface/lib/global-shortcuts';
      export { registerApplicationKeydownHandler as productRegister } from '@forgeax/app-shell/application';
      export { createAppHost } from '@forgeax/interface/core/app-shell';
      import { createApplicationShellStoreContext, configureApplicationShellStore } from '@forgeax/interface/application';
      import { initializeIdeShellStore, getIdeShellStore } from './src/product/shell-state-runtime';
      initializeIdeShellStore(createApplicationShellStoreContext());
      configureApplicationShellStore(getIdeShellStore);
      export const store = getIdeShellStore();
      export function mount(runtime) {
        const container = document.createElement('div'); document.body.append(container);
        const root = createRoot(container);
        flushSync(() => root.render(createElement(StrictMode, null, createElement(IdeKeyboardRouter, {runtime}))));
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
		lib: { entry, formats: ["iife"], name: "ProductKeyboard" },
	},
});
const result = (
	Array.isArray(output) ? output[0] : output
) as Rollup.RollupOutput;
const code = result.output.find(
	(item): item is Rollup.OutputChunk => item.type === "chunk",
)!.code;
process.stdout.write(JSON.stringify(code));
