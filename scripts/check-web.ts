#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

// Keep Web validation independent of Engine's floating authoring harness.
process.env.FORGEAX_SKIP_HARNESS_SYNC = "1";

function run(command: string, args: string[], env = process.env): void {
	const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

// The POSIX integration tests require this binary even in a fresh local checkout.
// Keep the prerequisite with the shared gate, not in each CI provider's YAML.
if (process.platform !== "win32") {
	run(
		"cargo",
		[
			"build",
			"--manifest-path",
			"src-tauri/Cargo.toml",
			"--bin",
			"runtime-guardian",
		],
		{
			...process.env,
			FORGEAX_BUILD_RUNTIME_GUARDIAN: "1",
		},
	);
}

// Source AppShell exports point into dist, so build them before resolving imports.
for (const script of [
	"prepare:app-shell",
	"check:dependencies",
	"lint:types",
	"lint:biome",
	"test",
	"build:web",
	"check:release-sources",
	"diagnostics",
]) {
	run(process.execPath, [
		"run",
		script,
		...(script === "diagnostics" ? ["--", "--json"] : []),
	]);
}
