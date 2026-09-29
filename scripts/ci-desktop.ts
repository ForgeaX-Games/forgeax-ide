#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DESKTOP_SOURCE_CONTEXT_PATH } from "./build-source-sidecar";
import { resolveStudioIntegrationInput } from "./ci-integration-input";
import { platformTargets } from "./desktop-platforms";
import { localBuildSource } from "./local-build-source";
import {
	assertNativeProductSourceStable,
	DESKTOP_BUILD_SOURCE_PATH,
} from "./native-product-receipt";
import { gitValue } from "./release-artifact-identity";

export const desktopCiStages = [
	"prepare",
	"install",
	"build",
	"verify",
	"archive",
] as const;
export type DesktopCiStage = (typeof desktopCiStages)[number];
export async function runDesktopCi(
	execute: (stage: DesktopCiStage) => void | Promise<void>,
): Promise<void> {
	for (const stage of desktopCiStages) await execute(stage);
}

export function desktopCiTarget(
	os = process.platform,
	arch = process.arch,
	requested?: string,
) {
	const platform = Object.entries(platformTargets).find(
		([, target]) => target.os === os && target.arch === arch,
	)?.[0];
	if (!platform)
		throw new Error(`unsupported desktop build host: ${os}/${arch}`);
	if (requested && requested !== platform)
		throw new Error(
			`requested ${requested} requires a native build host; got ${platform}`,
		);
	if (platform === "linux-x64")
		return {
			platform,
			...platformTargets[platform],
			bundles: "deb" as const,
			bundleTargets: "deb",
		};
	if (platform === "macos-arm64")
		return {
			platform,
			...platformTargets[platform],
			bundles: "dmg" as const,
			// Tauri removes the intermediate app when only DMG is requested.
			// Finalization and verification need it; archive only the installer.
			bundleTargets: "app,dmg",
		};
	throw new Error(`CI desktop packaging is not enabled for ${platform}`);
}

export function desktopCiMacosApp(ide: string, triple: string): string {
	const directory = join(
		ide,
		"src-tauri/target",
		triple,
		"release/bundle/macos",
	);
	const apps = readdirSync(directory, { withFileTypes: true }).filter(
		(entry) => entry.isDirectory() && entry.name.endsWith(".app"),
	);
	if (apps.length !== 1 || !apps[0])
		throw new Error("expected exactly one macOS app bundle");
	return join(directory, apps[0].name);
}

export async function installDesktopCiBrowser(
	ide: string,
	install: (cli: string) => void,
): Promise<string> {
	const require = createRequire(join(ide, "package.json"));
	const entry = require.resolve("playwright-core");
	const manifest = require.resolve("playwright-core/package.json");
	install(join(dirname(manifest), "cli.js"));
	const { chromium } = await import(pathToFileURL(entry).href);
	const executable = chromium.executablePath();
	if (!existsSync(executable))
		throw new Error(
			`Chromium installation did not produce the selected browser: ${executable}`,
		);
	console.log(`[ci:desktop] Chromium: ${executable}`);
	return executable;
}

export function archiveDesktopCi(
	ide: string,
	target: ReturnType<typeof desktopCiTarget>,
	currentSource: unknown = localBuildSource(resolve(ide, "../..")),
): void {
	assertNativeProductSourceStable(
		join(ide, DESKTOP_BUILD_SOURCE_PATH),
		currentSource,
	);
	const formats = [target.bundles];
	const bundle = join(ide, "src-tauri/target", target.triple, "release/bundle");
	const output = join(ide, "blueking-artifacts", target.platform);
	rmSync(output, { recursive: true, force: true });
	mkdirSync(output, { recursive: true });
	const hashes: string[] = [];
	for (const format of formats) {
		const extension = `.${format}`;
		const files = readdirSync(join(bundle, format)).filter((file) =>
			file.endsWith(extension),
		);
		if (files.length !== 1)
			throw new Error(`expected exactly one ${format} installer`);
		const file = files[0]!;
		// BlueKing UploadArtifactory silently skips filenames containing spaces.
		const archivedName = file.replace(/\s+/g, "-");
		copyFileSync(join(bundle, format, file), join(output, archivedName));
		hashes.push(
			`${createHash("sha256")
				.update(readFileSync(join(output, archivedName)))
				.digest("hex")}  ${archivedName}`,
		);
	}
	// The pipeline artifact repository flattens filenames across jobs. Keep
	// existing Linux names, and namespace the new Mac metadata to avoid clashes.
	const prefix = target.os === "darwin" ? `${target.platform}-` : "";
	const manifest = `${prefix}desktop-runtime-manifest.json`;
	copyFileSync(
		join(ide, "src-tauri/resources/runtime/desktop-runtime-manifest.json"),
		join(output, manifest),
	);
	hashes.push(
		`${createHash("sha256")
			.update(readFileSync(join(output, manifest)))
			.digest("hex")}  ${manifest}`,
	);
	copyFileSync(
		join(ide, DESKTOP_SOURCE_CONTEXT_PATH),
		join(output, `${prefix}source-context.json`),
	);
	hashes.push(
		`${createHash("sha256")
			.update(readFileSync(join(output, `${prefix}source-context.json`)))
			.digest("hex")}  ${prefix}source-context.json`,
	);
	writeFileSync(join(output, `${prefix}SHA256SUMS`), `${hashes.join("\n")}\n`);
}

async function main(): Promise<void> {
	const args = Bun.argv.slice(2);
	const requested = desktopCiStages.includes(args[0] as DesktopCiStage)
		? (args.shift() as DesktopCiStage)
		: undefined;
	const explicitPlatform = args.shift();
	if (
		args.length ||
		(explicitPlatform &&
			!["linux-x64", "macos-arm64"].includes(explicitPlatform))
	) {
		throw new Error(
			"usage: bun run ci:desktop[:prepare|:install|:build|:verify|:archive] [linux-x64|macos-arm64]",
		);
	}
	const target = desktopCiTarget(
		process.platform,
		process.arch,
		explicitPlatform,
	);
	const ide = resolve(import.meta.dirname, "..");
	const root = resolve(ide, "../..");
	const tools = join(ide, "release-work/ci-tools");
	process.env.FORGEAX_INTEGRATION_ROOT = root;
	process.env.FORGEAX_REQUIRE_PUBLISHABLE_SHADER_INPUTS = "1";
	// Resource staging fetches only pinned, referenced harness documents.
	process.env.FORGEAX_SKIP_HARNESS_SYNC = "1";
	process.env.PATH =
		join(tools, "node_modules/.bin") + delimiter + process.env.PATH;
	function run(command: string, args: string[], cwd = ide): void {
		const result = spawnSync(command, args, {
			cwd,
			stdio: "inherit",
			env: process.env,
		});
		if (result.error) throw result.error;
		if (result.status !== 0)
			throw new Error(`${command} ${args.join(" ")} failed: ${result.status}`);
	}
	const bun = (args: string[], cwd = ide) => run(process.execPath, args, cwd);
	async function execute(stage: DesktopCiStage): Promise<void> {
		console.log(`[ci:desktop] ${stage}`);
		if (stage === "prepare") {
			// CI adapters supply the same immutable source contract. Local rehearsal
			// may use uncommitted work; the Tauri hook records that dirty source.
			const expected = process.env.FORGEAX_CI_IDE_REVISION;
			if (process.env.CI || expected) {
				if (
					!expected ||
					!/^[a-f0-9]{40}$/.test(expected) ||
					gitValue(ide, "rev-parse", "HEAD") !== expected
				)
					throw new Error("immutable IDE revision mismatch");
				if (gitValue(ide, "status", "--porcelain", "--untracked-files=all"))
					throw new Error("IDE checkout must be clean");
			}
			const inputs = JSON.parse(
				readFileSync(join(ide, "product/integration-inputs.json"), "utf8"),
			);
			const studio = resolveStudioIntegrationInput(inputs);
			if (
				inputs.settings?.repository !== "ForgeaX-Games/forgeax-settings" ||
				!/^[a-f0-9]{40}$/.test(inputs.settings?.revision)
			)
				throw new Error("invalid Settings input");
			if (gitValue(root, "rev-parse", "HEAD") !== studio.revision) {
				run("git", ["fetch", "origin", studio.revision], root);
				run("git", ["checkout", "--detach", studio.revision], root);
			}
			run(
				"git",
				[
					"submodule",
					"update",
					"--init",
					"--recursive",
					"packages/server",
					"packages/orchestrator",
					"packages/agent-host",
					"packages/cli",
					"packages/editor",
					"packages/platform-io",
					"packages/interface",
					"packages/chat",
					"packages/dashboard",
					"packages/settings",
				],
				root,
			);
			const settings = join(root, "packages/settings");
			run("git", ["fetch", "origin", "main"], settings);
			run(
				"git",
				["merge-base", "--is-ancestor", inputs.settings.revision, "FETCH_HEAD"],
				settings,
			);
			run("git", ["checkout", "--detach", inputs.settings.revision], settings);
			// AppShell is an IDE integration input outside Studio's submodule graph.
			bun(["scripts/materialize-ci-app-shell.ts"]);
			for (const command of ["node", "rustc"]) run(command, ["--version"]);
		} else if (stage === "install") {
			// Resolve workspace:* from the same complete source graph and frozen
			// lock used by the Tauri hook, including the CLI needed to invoke it.
			bun(["scripts/install-desktop-source-workspace.ts"]);
			const pnpm = (
				await import("./desktop-toolchain")
			).desktopToolchainSources(ide, root).pnpm;
			run("npm", [
				"install",
				"--prefix",
				tools,
				"--no-save",
				"--ignore-scripts",
				`pnpm@${pnpm}`,
			]);
			// Keep the desktop path subject to the same Biome and strict TypeScript
			// gate as the web PR path before expensive native compilation begins. The
			// type check prepares shader inputs, which invoke wasm-pack, so use the
			// same toolchain setup that the later Tauri build uses.
			run("bash", [
				"-e",
				"-c",
				'source .ci/wasm-toolchain.sh; bun scripts/desktop-toolchain.ts verify; exec "$@"',
				"ci-desktop",
				process.execPath,
				"run",
				"lint",
			]);
		} else if (stage === "build") {
			// Environment setup is platform-specific; resource preparation is only
			// invoked by Tauri's default beforeBuildCommand.
			run("bash", [
				"-e",
				"-c",
				'source .ci/wasm-toolchain.sh; exec "$@"',
				"ci-desktop",
				process.execPath,
				"run",
				"build:desktop",
				"--ci",
				"--target",
				target.triple,
				"--bundles",
				target.bundleTargets,
			]);
			if (target.os === "darwin") {
				bun([
					"run",
					"finalize:macos-bundle",
					"--bundle-root",
					join(ide, "src-tauri/target", target.triple, "release/bundle"),
					"--target",
					target.triple,
				]);
			}
		} else if (stage === "verify") {
			if (target.os === "darwin")
				bun([
					"run",
					"verify:macos-bundle",
					"--app",
					desktopCiMacosApp(ide, target.triple),
				]);
			bun(["run", "test", "tests/desktop-resources.test.ts"]);
			process.env.IDE_SMOKE_GPU_DIAGNOSTICS = "1";
			// Resolve and install from the final workspace after the Tauri hook.
			// A bootstrap Playwright version can select a different browser revision.
			process.env.IDE_BROWSER_EXECUTABLE = await installDesktopCiBrowser(
				ide,
				(cli) => bun([cli, "install", "chromium"]),
			);
			process.env.FORGEAX_RESOURCE_ROOT = join(ide, "src-tauri/resources");
			process.env.FORGEAX_BUN_EXECUTABLE = join(
				process.env.FORGEAX_RESOURCE_ROOT,
				"sidecars",
				`bun-${target.triple}${target.extension}`,
			);
			run(
				join(
					process.env.FORGEAX_RESOURCE_ROOT,
					"sidecars",
					`forgeax-server-${target.triple}${target.extension}`,
				),
				["--verify-runtime-imports"],
				join(process.env.FORGEAX_RESOURCE_ROOT, "server-runtime"),
			);
			bun(["run", "smoke:desktop-runtime"]);
			bun(["run", "smoke:production-bundle"]);
		} else if (stage === "archive") {
			archiveDesktopCi(ide, target);
		}
	}
	if (requested) await execute(requested as DesktopCiStage);
	else
		await runDesktopCi((stage) => {
			// Dependency installation can replace module links. Each stage starts
			// afresh so verification cannot retain pre-build module resolutions.
			const result = spawnSync(
				process.execPath,
				["run", `ci:desktop:${stage}`, target.platform],
				{ cwd: ide, stdio: "inherit", env: process.env },
			);
			if (result.error) throw result.error;
			if (result.status !== 0) process.exit(result.status ?? 1);
		});
}

if (import.meta.main) await main();
