#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import buildInputs from "../.ci/desktop-build-inputs.json";
import { assertSourceIntegration } from "./build-source-sidecar";
import { completeSourceWorkspace } from "./complete-source-workspace";
import { registryIndependentLock } from "./registry-independent-lock";

// Install the complete source graph in the disposable integration checkout,
// restoring the Studio manifest and lock after preparing dependencies.
const root = resolve(import.meta.dirname, "../../..");
assertSourceIntegration(root);
const { createIdeIntegrationRootManifest, ensureIdeIntegrationPackageLinks } =
	await import(join(root, "scripts/lib/ide-integration-workspace.ts"));
const path = join(root, "package.json");
const original = readFileSync(path, "utf8");
const lockPath = join(root, "bun.lock");
const originalLock = existsSync(lockPath) ? readFileSync(lockPath) : undefined;
const desktopLock = resolve(
	import.meta.dirname,
	"../.ci/desktop-source.bun.lock",
);
const updateLock = Bun.argv.includes("--update-lock");
const expectedBun = JSON.parse(
	readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
).packageManager;
if (`bun@${Bun.version}` !== expectedBun)
	throw new Error(`desktop workspace installation requires ${expectedBun}`);
const rootManifest = JSON.parse(original);
const manifest = completeSourceWorkspace(
	createIdeIntegrationRootManifest(rootManifest, root),
	rootManifest,
	root,
	"",
);
manifest.overrides = {
	...manifest.overrides,
	playwright: buildInputs.playwright,
	"playwright-core": buildInputs.playwright,
};
try {
	writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
	writeFileSync(lockPath, readFileSync(desktopLock));
	const result = spawnSync(
		process.execPath,
		[
			"install",
			"--ignore-scripts",
			...(updateLock ? [] : ["--frozen-lockfile"]),
		],
		{ cwd: root, stdio: "inherit" },
	);
	if (result.status !== 0)
		throw new Error(`desktop dependency installation failed: ${result.status}`);
	if (updateLock)
		writeFileSync(
			desktopLock,
			registryIndependentLock(readFileSync(lockPath, "utf8")),
		);
	ensureIdeIntegrationPackageLinks(root);
} finally {
	writeFileSync(path, original);
	if (originalLock) writeFileSync(lockPath, originalLock);
	else rmSync(lockPath, { force: true });
}

// Editor's public Vite preset resolves Engine importers through its own hoisted
// workspace. Prepare that graph before CI lint, as well as the Tauri build hook.
// Restore the Studio manifest first so Bun uses Editor's committed lock here.
const editorInstall = spawnSync(
	process.execPath,
	["install", "--frozen-lockfile", "--ignore-scripts"],
	{ cwd: join(root, "packages/editor"), stdio: "inherit" },
);
if (editorInstall.error) throw editorInstall.error;
if (editorInstall.status !== 0)
	throw new Error(
		`Editor dependency installation failed: ${editorInstall.status}`,
	);
