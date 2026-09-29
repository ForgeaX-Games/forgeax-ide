import { createRequire } from "node:module";
import { join } from "node:path";

// Playwright owns filesystem-relative assets and must execute from its intact
// installed package. Resolve explicitly because compiled Bun ESM imports use
// /$bunfs as their package root rather than the packaged runtime directory.
const root = process.env.FORGEAX_RESOURCE_ROOT;
if (!root)
	throw new Error("FORGEAX_RESOURCE_ROOT is required for packaged Playwright");
const playwright = createRequire(import.meta.url)(
	join(root, "server-runtime/node_modules/playwright/index.js"),
) as typeof import("playwright-core");
export const {
	chromium,
	firefox,
	webkit,
	devices,
	selectors,
	request,
	errors,
} = playwright;
