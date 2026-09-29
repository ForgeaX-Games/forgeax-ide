#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const ideRoot = resolve(import.meta.dirname, "..");
const integrationRoot = resolve(ideRoot, "../..");
const vite = join(ideRoot, "node_modules/vite/bin/vite.js");
const desktopBuild = Bun.argv.includes("--desktop");
const appShell = spawnSync(process.execPath, ["run", "prepare:app-shell"], {
	cwd: ideRoot,
	stdio: "inherit",
});
if (appShell.error) throw appShell.error;
if (appShell.status !== 0) process.exit(appShell.status ?? 1);
const result = spawnSync(process.execPath, [vite, "build"], {
	cwd: ideRoot,
	stdio: "inherit",
	env: {
		...process.env,
		FORGEAX_INTEGRATION_ROOT: integrationRoot,
		...(desktopBuild ? { FORGEAX_DESKTOP_BUILD: "1" } : {}),
	},
});
process.exit(result.status ?? 1);
