#!/usr/bin/env bun
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { packageManager } from "../package.json";
import { completeSourceWorkspace } from "./complete-source-workspace";
import { registryIndependentLock } from "./registry-independent-lock";

const root = resolve(import.meta.dirname, "../../..");
const ide = resolve(import.meta.dirname, "..");
const updateLock = Bun.argv.includes("--update-lock");
if (`bun@${Bun.version}` !== packageManager)
	throw new Error(`Web workspace installation requires ${packageManager}`);
const {
	writeIdeIntegrationWorkspaceManifest,
	ensureIdeIntegrationPackageLinks,
} = await import(join(root, "scripts/lib/ide-integration-workspace.ts"));
const { runIdeWorkspaceInstall } = await import(
	join(root, "scripts/lib/ide-install-diagnostics.ts")
);
const workspace = join(root, ".forgeax/ide-source-workspace");
writeIdeIntegrationWorkspaceManifest(workspace);
const manifestPath = join(workspace, "package.json");
writeFileSync(
	manifestPath,
	`${JSON.stringify(
		completeSourceWorkspace(
			JSON.parse(readFileSync(manifestPath, "utf8")),
			JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
			root,
			"../../",
		),
		null,
		2,
	)}\n`,
);
const sourceLock = join(ide, ".ci/web-source.bun.lock");
const installLock = join(workspace, "bun.lock");
// Seed updates from the committed resolution instead of upgrading unrelated ranges.
if (!updateLock || existsSync(sourceLock))
	copyFileSync(sourceLock, installLock);
const result = await runIdeWorkspaceInstall({
	root,
	cwd: workspace,
	env: process.env,
	args: [
		"install",
		"--ignore-scripts",
		...(updateLock ? [] : ["--frozen-lockfile"]),
	],
});
if (result.status !== 0) process.exit(result.status ?? 1);
if (updateLock)
	writeFileSync(
		sourceLock,
		registryIndependentLock(readFileSync(installLock, "utf8")),
	);
ensureIdeIntegrationPackageLinks(root);
