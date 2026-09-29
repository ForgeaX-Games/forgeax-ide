import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { gitValue } from "./release-artifact-identity";

// Release manifests identify committed producers. Local Tauri builds also
// embed this receipt so uncommitted source is not mistaken for that base commit.
export function localRepositorySource(
	root: string,
	generatedPaths: string[] = [],
) {
	// Tauri replaces these product outputs after the source build has already
	// started. They are not authored source and must not make a final-product
	// provenance check fail merely because packaging did its job.
	const excludes = generatedPaths.map((path) => `:(exclude)${path}`);
	const diff = gitValue(
		root,
		"diff",
		"--binary",
		"HEAD",
		"--",
		".",
		...excludes,
	);
	const untracked = gitValue(
		root,
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z",
		"--",
		".",
		...excludes,
	)
		.split("\0")
		.filter((path) => path && !path.split("/").includes("node_modules"))
		.sort()
		.map((path) => {
			const absolute = join(root, path);
			const content = lstatSync(absolute).isSymbolicLink()
				? readlinkSync(absolute)
				: readFileSync(absolute);
			return {
				path,
				sha256: createHash("sha256").update(content).digest("hex"),
			};
		});
	return {
		revision: gitValue(root, "rev-parse", "HEAD"),
		dirty: diff.length > 0 || untracked.length > 0,
		diffSha256: createHash("sha256").update(diff).digest("hex"),
		untracked,
	};
}

export function localBuildSource(root: string) {
	const repositories = Object.fromEntries(
		[
			".",
			"packages/ide",
			"packages/editor",
			"packages/editor/packages/engine",
			"packages/interface",
			"packages/chat",
			"packages/settings",
			"packages/dashboard",
			"packages/server",
			"packages/orchestrator",
			"packages/agent-host",
			"packages/cli",
			"packages/platform-io",
		].map((path) => [
			path,
			localRepositorySource(
				join(root, path),
				path === "packages/ide" ? ["src-tauri/resources", "dist"] : [],
			),
		]),
	);
	return {
		schema: "forgeax-local-build-source/v1",
		bun:
			process.versions.bun ??
			execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(),
		repositories,
	};
}
