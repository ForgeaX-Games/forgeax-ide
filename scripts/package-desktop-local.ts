#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export type LocalPackageStep = { name: string; cwd: string; args: string[] };

export function runLocalPackageSteps(
	steps: LocalPackageStep[],
	output: string,
	env: NodeJS.ProcessEnv,
	metadata: Record<string, unknown> = {},
): void {
	mkdirSync(output, { recursive: true });
	const results: Array<
		LocalPackageStep & { status: number; signal: string | null }
	> = [];
	for (const step of steps) {
		const log = join(output, `${step.name}.log`);
		console.log(`[local-package] ${step.name} (${log})`);
		const fd = openSync(log, "w");
		let result: ReturnType<typeof spawnSync>;
		try {
			// Write while the stage runs: interrupts and large compiler outputs must
			// not discard diagnostics or terminate a build through maxBuffer limits.
			result = spawnSync(process.execPath, step.args, {
				cwd: step.cwd,
				env,
				stdio: ["ignore", fd, fd],
			});
		} finally {
			closeSync(fd);
		}
		if (result.error) appendFileSync(log, `\n${result.error}\n`);
		results.push({
			...step,
			status: result.status ?? 1,
			signal: result.signal,
		});
		writeFileSync(
			join(output, "steps.json"),
			JSON.stringify({ ...metadata, results }, null, 2),
		);
		if (result.error || result.status !== 0)
			throw new Error(`${step.name} failed; see ${log}`);
	}
}

export function localPackagePlan(
	_root: string,
	ide: string,
	target: string,
	platform: string,
	bundle: string,
): LocalPackageStep[] {
	const app = join(bundle, "macos/ForgeaX Studio.app");
	return [
		{ name: "prepare", cwd: ide, args: ["run", "prepare:desktop"] },
		{
			name: "resources",
			cwd: ide,
			args: ["run", "validate:desktop:resources", "--platform", platform],
		},
		{
			name: "tauri",
			cwd: ide,
			args: [
				"run",
				"tauri",
				"build",
				"--target",
				target,
				"--bundles",
				"app",
				"--config",
				JSON.stringify({ build: { beforeBuildCommand: null } }),
			],
		},
		{
			name: "finalize",
			cwd: ide,
			args: [
				"run",
				"finalize:macos-bundle",
				"--bundle-root",
				bundle,
				"--target",
				target,
			],
		},
		{
			name: "verify",
			cwd: ide,
			args: ["run", "verify:macos-bundle", "--app", app],
		},
	];
}

export function packageLocal(): void {
	if (process.argv.includes("--help")) {
		console.log(
			"Usage: bun run package:desktop:local\nBuild the prepared integration source into a verified local macOS App and DMG. Does not publish or launch.",
		);
		return;
	}
	if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch))
		throw new Error(
			"Local package entry currently supports macOS arm64/x64 only.",
		);
	const ide = resolve(import.meta.dir, "..");
	const root = resolve(
		process.env.FORGEAX_INTEGRATION_ROOT ?? join(ide, "../.."),
	);
	for (const path of [
		"packages/cli/package.json",
		"packages/orchestrator/package.json",
		"packages/server/src/main.ts",
	]) {
		if (!existsSync(join(root, path)))
			throw new Error(
				`Missing integration source ${path}; prepare the selected Studio checkout first.`,
			);
	}
	const target =
		process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
	const platform = process.arch === "arm64" ? "macos-arm64" : "macos-x64";
	const id = `local-${Date.now()}-${process.pid}`;
	const output = join(root, ".forgeax/local-packages", id);
	const cargo = join(output, "target");
	const bundle = join(cargo, target, "release/bundle");
	mkdirSync(output, { recursive: true });
	mkdirSync(join(ide, "src-tauri/resources/sidecars"), { recursive: true });
	const source = (cwd: string) => {
		const git = (args: string[]) => {
			const result = spawnSync("git", args, { cwd, encoding: "utf8" });
			if (result.status !== 0)
				throw new Error(`Cannot record source provenance in ${cwd}`);
			return result.stdout.trim();
		};
		return {
			path: cwd,
			head: git(["rev-parse", "HEAD"]),
			changes: git(["status", "--porcelain"]),
			pins: git(["submodule", "status", "--recursive"]),
		};
	};
	writeFileSync(
		join(output, "sources.json"),
		JSON.stringify({ studio: source(root), ide: source(ide) }, null, 2),
	);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
		CARGO_TARGET_DIR: cargo,
	};
	delete env.GITHUB_SHA;
	delete env.FORGEAX_SOURCE_HEAD;
	runLocalPackageSteps(
		localPackagePlan(root, ide, target, platform, bundle),
		output,
		env,
		{ root, ide, bun: Bun.version, target, bundle },
	);
	console.log(`[local-package] Verified App and DMG: ${bundle}`);
}

if (import.meta.main) packageLocal();
