#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import desktopBuildInputs from "../.ci/desktop-build-inputs.json";
import {
	type ArtifactDescriptor,
	type ArtifactManifest,
	createArtifactManifest,
	normalizePortableArtifactFiles,
	sha256,
	verifyArtifactManifest,
} from "./artifact-manifest";
import {
	type SourceSidecarContext,
	validateSourceBinary,
} from "./build-source-sidecar";
import { type DesktopPlatform, platformTargets } from "./desktop-platforms";
import {
	composeEngineCommonArtifacts,
	composeEngineTargetArtifact,
} from "./engine-runtime-artifacts";
import { assertTargetExecutable } from "./executable-identity";
import {
	gitProducer,
	gitValue,
	submoduleRevision,
	trackedIdentityFile,
} from "./release-artifact-identity";
import type { ReleaseContext } from "./resolve-release-context";
import { stageEngineProjectSkills } from "./stage-engine-project-skills";
import { materializeWebArtifact } from "./web-runtime-artifact";

const IDE_ROOT = resolve(import.meta.dirname, "..");
export type RuntimeSidecarContext = ReleaseContext | SourceSidecarContext;
function isSourceContext(
	context: RuntimeSidecarContext,
): context is SourceSidecarContext {
	return (
		"schema" in context && context.schema === "forgeax-server-source-build/v1"
	);
}
const INTEGRATION_ROOT = resolve(IDE_ROOT, "../..");
const AGENT_HOST_ROOT = join(INTEGRATION_ROOT, "packages/agent-host");
const EDITOR_ROOT = join(INTEGRATION_ROOT, "packages/editor");
const ORCHESTRATOR_ROOT = join(INTEGRATION_ROOT, "packages/orchestrator");
const SERVER_ROOT = join(INTEGRATION_ROOT, "packages/server");
const COPY_EXCLUDES = new Set([
	".git",
	".forgeax-harness",
	"node_modules",
	"target",
	"__tests__",
	"test",
	"tests",
	".vite",
	".forgeax",
	"host-games",
	"shared-assets",
	"engine-assets",
]);

const DESKTOP_RUNTIME_LOCAL_HELPERS = [
	"scripts/server-runtime-assets.ts",
	"scripts/desktop-environment.ts",
	"scripts/desktop-ports.ts",
	"scripts/desktop-pipe.ts",
	"scripts/desktop-process-tree.ts",
	"scripts/desktop-runtime-layout.ts",
	"scripts/desktop-windows-job.ts",
] as const;

const SERVER_NATIVE_PRELOAD_LOCAL_HELPERS = [
	"scripts/server-runtime-assets.ts",
	"scripts/desktop-environment.ts",
] as const;

const RUNTIME_GUARDIAN_BUILD_INPUTS = [
	"src-tauri/Cargo.lock",
	"src-tauri/Cargo.toml",
	"src-tauri/build.rs",
	"src-tauri/src/bin/runtime-guardian.rs",
] as const;

/** Exact local source closure bundled into each common runtime entrypoint. */
export function runtimeArtifactBuildScriptPaths(
	scope: "common" | "target",
	platform?: DesktopPlatform,
	sourceBuild = false,
): string[] {
	const common =
		scope === "common"
			? [
					...DESKTOP_RUNTIME_LOCAL_HELPERS,
					...SERVER_NATIVE_PRELOAD_LOCAL_HELPERS,
					"scripts/desktop-engine.ts",
					"scripts/desktop-runtime.ts",
					"scripts/server-native-preload.ts",
					"scripts/forgeax-core-serve-entry.ts",
					"scripts/bundle-desktop-orchestrator-kits.ts",
					"product/engine-harness-input.json",
					"scripts/engine-harness-documents.ts",
					"scripts/stage-engine-project-skills.ts",
				]
			: [
					"scripts/desktop-platforms.ts",
					"scripts/executable-identity.ts",
					...(platform === "windows-x64" ? [] : RUNTIME_GUARDIAN_BUILD_INPUTS),
				];
	const source = sourceBuild
		? [
				"scripts/build-source-sidecar.ts",
				...SERVER_NATIVE_PRELOAD_LOCAL_HELPERS,
				"scripts/executable-identity.ts",
				"scripts/server-playwright-runtime.ts",
				"scripts/server-native-preload.ts",
				"scripts/install-desktop-source-workspace.ts",
				".ci/desktop-build-inputs.json",
			]
		: [];
	return [
		...new Set(["scripts/runtime-artifacts.ts", ...common, ...source]),
	].sort();
}

export function runtimeArtifactBuildScriptInputs(
	scope: "common" | "target",
	platform?: DesktopPlatform,
	sourceBuild = false,
) {
	return runtimeArtifactBuildScriptPaths(scope, platform, sourceBuild).map(
		(path) => trackedIdentityFile(IDE_ROOT, path),
	);
}

type PackageJson = {
	version?: string;
	packageManager?: string;
	optionalDependencies?: Record<string, string>;
};

function fail(message: string): never {
	throw new Error(`[runtime-artifacts] ${message}`);
}

function argument(name: string): string | undefined {
	const index = Bun.argv.indexOf(name);
	return index >= 0 ? Bun.argv[index + 1] : undefined;
}

function readJson(path: string): PackageJson {
	return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
}

function copyTree(source: string, destination: string, exclude = false): void {
	if (!existsSync(source)) fail(`required source is missing: ${source}`);
	cpSync(source, destination, {
		recursive: true,
		dereference: true,
		force: true,
		filter: exclude ? (path) => !COPY_EXCLUDES.has(basename(path)) : undefined,
	});
}

function copyVerifiedExecutable(
	source: string,
	destination: string,
	platform: DesktopPlatform,
): void {
	const sourceBytes = readFileSync(source);
	assertTargetExecutable(sourceBytes, platform);
	const digest = sha256(sourceBytes);
	copyFileSync(source, destination);
	if (sha256(readFileSync(destination)) !== digest)
		fail(`executable changed while staging: ${destination}`);
}

function run(args: string[], cwd = IDE_ROOT): void {
	const result = spawnSync(process.execPath, args, {
		cwd,
		stdio: "inherit",
		env: { ...process.env, FORGEAX_INTEGRATION_ROOT: INTEGRATION_ROOT },
	});
	if (result.status !== 0)
		fail(`command failed (${result.status}): bun ${args.join(" ")}`);
}

function runCommand(
	command: string,
	args: string[],
	cwd = IDE_ROOT,
	extraEnv: NodeJS.ProcessEnv = {},
): void {
	const result = spawnSync(command, args, {
		cwd,
		stdio: "inherit",
		env: {
			...process.env,
			FORGEAX_INTEGRATION_ROOT: INTEGRATION_ROOT,
			...extraEnv,
		},
	});
	if (result.status !== 0)
		fail(`command failed (${result.status}): ${command} ${args.join(" ")}`);
}

export function runtimeArtifactDescriptor(
	scope: "common" | "target",
	platform?: DesktopPlatform,
	context?: RuntimeSidecarContext,
): ArtifactDescriptor {
	const target = platform ? platformTargets[platform] : undefined;
	const buildScripts = runtimeArtifactBuildScriptInputs(
		scope,
		platform,
		!!context && isSourceContext(context),
	);
	const toolchains: Record<string, string> = {
		bun: Bun.version,
		node: process.version,
		"integration-revision": gitValue(INTEGRATION_ROOT, "rev-parse", "HEAD"),
		"editor-revision": submoduleRevision(INTEGRATION_ROOT, "packages/editor"),
		"engine-revision": submoduleRevision(EDITOR_ROOT, "packages/engine"),
		"server-revision": submoduleRevision(INTEGRATION_ROOT, "packages/server"),
	};
	if (scope === "common") {
		toolchains["agent-host-revision"] = submoduleRevision(
			INTEGRATION_ROOT,
			"packages/agent-host",
		);
		toolchains["cli-revision"] = submoduleRevision(
			INTEGRATION_ROOT,
			"packages/cli",
		);
		toolchains["orchestrator-revision"] = submoduleRevision(
			INTEGRATION_ROOT,
			"packages/orchestrator",
		);
		toolchains["publishable-shader-inputs"] =
			process.env.FORGEAX_REQUIRE_PUBLISHABLE_SHADER_INPUTS === "1"
				? "required"
				: "not-required";
	} else {
		if (!context) fail("target artifact requires release context");
		if (isSourceContext(context)) {
			if (
				context.platform !== platform ||
				context.sourceRevisions.server !== toolchains["server-revision"] ||
				context.sourceRevisions.studio !== toolchains["integration-revision"]
			)
				fail("source server provenance mismatch");
			const lockHash = sha256(
				readFileSync(join(IDE_ROOT, ".ci/desktop-source.bun.lock")),
			);
			if (
				context.dependencyLockSha256 !== lockHash ||
				context.bunVersion !== Bun.version
			)
				fail("source server build inputs mismatch");
			toolchains["server-source-binary-sha256"] = context.sha256;
			toolchains["server-source-bun-version"] = context.bunVersion;
			toolchains["server-source-lock-sha256"] = lockHash;
		} else
			toolchains["server-candidate-manifest-sha256"] =
				context.sidecarManifestSha256;
		toolchains["server-service-version"] = context.serviceVersion;
	}
	return {
		artifactId:
			scope === "common"
				? "ide-desktop-runtime-common/v1"
				: "ide-desktop-runtime-target/v1",
		producer: gitProducer(IDE_ROOT, "ForgeaX-Games/forgeax-ide"),
		inputs: {
			lockfiles: [
				trackedIdentityFile(
					IDE_ROOT,
					".ci/web-source.bun.lock",
					"ide/.ci/web-source.bun.lock",
				),
				trackedIdentityFile(
					INTEGRATION_ROOT,
					"bun.lock",
					"integration/bun.lock",
				),
			],
			buildScripts,
			toolchains,
		},
		scope,
		target: target ? { platform: platform!, triple: target.triple } : null,
	};
}

function writeManifest(
	root: string,
	path: string,
	artifactDescriptor: ArtifactDescriptor,
): ArtifactManifest {
	const manifest = createArtifactManifest(root, artifactDescriptor);
	writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
	return manifest;
}

function readManifest(path: string): ArtifactManifest {
	if (!existsSync(path)) fail(`manifest is missing: ${path}`);
	return JSON.parse(readFileSync(path, "utf8")) as ArtifactManifest;
}

function createOutput(
	output: string,
	build: (temporary: string, payload: string) => void,
): void {
	const root = resolve(output);
	if (existsSync(root)) fail(`output already exists: ${root}`);
	const temporary = `${root}.create-${process.pid}`;
	if (existsSync(temporary))
		fail(`temporary output already exists: ${temporary}`);
	try {
		const payload = join(temporary, "payload");
		mkdirSync(payload, { recursive: true });
		build(temporary, payload);
		renameSync(temporary, root);
	} catch (error) {
		rmSync(temporary, { recursive: true, force: true });
		throw error;
	}
}

function resolveDependency(
	parent: string,
	name: string,
	fallbacks: readonly string[],
	version?: string,
): string | null {
	const candidates = [join(parent, "node_modules", name)];
	for (
		let ancestor = dirname(parent);
		ancestor !== dirname(ancestor);
		ancestor = dirname(ancestor)
	) {
		if (basename(ancestor) === "node_modules")
			candidates.push(join(ancestor, name));
		if (ancestor === INTEGRATION_ROOT || ancestor === IDE_ROOT) break;
	}
	candidates.push(...fallbacks.map((root) => join(root, name)));
	for (const candidate of candidates) {
		try {
			const resolved = realpathSync(candidate);
			if (
				existsSync(join(resolved, "package.json")) &&
				(!version ||
					readJson(join(resolved, "package.json")).version === version)
			)
				return resolved;
		} catch {
			// Continue through the declared install roots.
		}
	}
	for (const store of [
		join(INTEGRATION_ROOT, "node_modules/.bun"),
		join(IDE_ROOT, "node_modules/.bun"),
	]) {
		if (!existsSync(store)) continue;
		for (const entry of readdirSync(store)) {
			const candidate = join(store, entry, "node_modules", name);
			if (
				existsSync(join(candidate, "package.json")) &&
				(!version ||
					readJson(join(candidate, "package.json")).version === version)
			)
				return candidate;
		}
	}
	return null;
}

export function sharpNativePackageNames(
	optional: Record<string, string>,
	platform: DesktopPlatform,
): string[] {
	const suffix =
		platform === "macos-arm64"
			? "darwin-arm64"
			: platform === "macos-x64"
				? "darwin-x64"
				: platform === "linux-x64"
					? "linux-x64"
					: "win32-x64";
	return Object.keys(optional)
		.filter(
			(name) =>
				name === `@img/sharp-${suffix}` ||
				name === `@img/sharp-libvips-${suffix}`,
		)
		.sort();
}

function stageServerTargetRuntime(
	payload: string,
	platform: DesktopPlatform,
	sourceBuild: boolean,
): string[] {
	const destination = join(payload, "server-runtime/node_modules");
	const fallbacks = [
		join(SERVER_ROOT, "node_modules"),
		join(INTEGRATION_ROOT, "node_modules"),
		join(IDE_ROOT, "node_modules"),
	];
	const sharp = resolveDependency(SERVER_ROOT, "sharp", fallbacks);
	if (!sharp) fail("server sharp dependency is not installed");
	const optional =
		readJson(join(sharp, "package.json")).optionalDependencies ?? {};
	const names = sharpNativePackageNames(optional, platform);
	if (names.length === 0)
		fail(`sharp native dependencies are not declared for ${platform}`);
	const required: string[] = [];
	if (sourceBuild) {
		const playwright = resolveDependency(
			SERVER_ROOT,
			"playwright",
			fallbacks,
			desktopBuildInputs.playwright,
		);
		if (!playwright) fail("server playwright dependency is not installed");
		const playwrightCore = resolveDependency(
			playwright,
			"playwright-core",
			fallbacks,
			desktopBuildInputs.playwright,
		);
		if (!playwrightCore)
			fail("server playwright-core dependency is not installed");
		copyTree(playwright, join(destination, "playwright"), true);
		copyTree(playwrightCore, join(destination, "playwright-core"), true);
		required.push(
			"server-runtime/node_modules/playwright/package.json",
			"server-runtime/node_modules/playwright-core/package.json",
		);
	}
	for (const name of names) {
		const source = resolveDependency(sharp, name, fallbacks, optional[name]);
		if (!source)
			fail(
				`sharp native dependency is not installed at ${optional[name]}: ${name}`,
			);
		copyTree(source, join(destination, name), true);
		required.push(`server-runtime/node_modules/${name}/package.json`);
	}
	return required;
}

function stageServerCommonRuntime(payload: string): string[] {
	const required: string[] = [];
	const orchestratorRuntime = join(payload, "server-runtime/orchestrator");
	copyTree(
		join(ORCHESTRATOR_ROOT, "builtin"),
		join(orchestratorRuntime, "builtin"),
	);
	run([
		join(IDE_ROOT, "scripts/bundle-desktop-orchestrator-kits.ts"),
		"--source",
		join(ORCHESTRATOR_ROOT, "builtin/kits"),
		"--outdir",
		join(orchestratorRuntime, "builtin/kits"),
	]);
	required.push(
		"server-runtime/orchestrator/builtin/kits/workspace/tools/read_file.ts",
	);
	const watcherWorker = join(
		ORCHESTRATOR_ROOT,
		"src/api/lib/watcher-worker.mjs",
	);
	if (existsSync(watcherWorker)) {
		run([
			"build",
			watcherWorker,
			"--target=bun",
			"--packages=bundle",
			"--outfile",
			join(payload, "server-runtime/assets/watcher-worker.mjs"),
		]);
		required.push("server-runtime/assets/watcher-worker.mjs");
	}
	const playerLauncher = join(
		INTEGRATION_ROOT,
		"packages/build/player-launcher/player-launcher.ts",
	);
	if (!existsSync(playerLauncher))
		fail(`player launcher source is missing: ${playerLauncher}`);
	mkdirSync(join(payload, "server-runtime"), { recursive: true });
	copyFileSync(
		playerLauncher,
		join(payload, "server-runtime/player-launcher.ts"),
	);
	run([
		"build",
		join(ORCHESTRATOR_ROOT, "src/kernel/mcp/forgeax-tools-server.mjs"),
		"--target=bun",
		"--packages=bundle",
		"--outfile",
		join(payload, "server-runtime/assets/forgeax-tools-server.mjs"),
	]);
	required.push(
		"server-runtime/player-launcher.ts",
		"server-runtime/assets/forgeax-tools-server.mjs",
	);
	const commandSource = join(ORCHESTRATOR_ROOT, "builtin/commands");
	const commands = readdirSync(commandSource)
		.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
		.sort();
	if (!commands.length)
		fail(`server builtin commands are missing: ${commandSource}`);
	for (const name of commands) {
		const output = `server-runtime/commands/${name.slice(0, -3)}.mjs`;
		run([
			"build",
			join(commandSource, name),
			"--target=bun",
			"--packages=bundle",
			"--outfile",
			join(payload, output),
		]);
		required.push(output);
	}
	const cliEntry = join(IDE_ROOT, "scripts/forgeax-core-serve-entry.ts");
	run([
		"build",
		join(IDE_ROOT, "scripts/server-native-preload.ts"),
		"--target=bun",
		"--outfile",
		join(payload, "server-runtime/native-preload.mjs"),
	]);
	run([
		"build",
		join(AGENT_HOST_ROOT, "src/main.ts"),
		"--target=bun",
		"--packages=bundle",
		"--outfile",
		join(payload, "server-runtime/agent-host.mjs"),
	]);
	if (!existsSync(cliEntry))
		fail(`forgeax-core serve entry is missing: ${cliEntry}`);
	run([
		"build",
		cliEntry,
		"--target=bun",
		"--packages=bundle",
		"--external",
		"react-devtools-core",
		"--outfile",
		join(payload, "server-runtime/forgeax-core-serve.mjs"),
	]);
	const assets = [
		[join(SERVER_ROOT, "src/game/game-charter.md"), "game-charter.md"],
		[
			join(ORCHESTRATOR_ROOT, "src/kernel/ui-bridge-contract.json"),
			"ui-bridge-contract.json",
		],
	] as const;
	for (const [source, name] of assets) {
		if (!existsSync(source)) fail(`server runtime asset is missing: ${source}`);
		const output = join(payload, "server-runtime/assets", name);
		mkdirSync(dirname(output), { recursive: true });
		copyFileSync(source, output);
	}
	return [
		...required,
		"server-runtime/native-preload.mjs",
		"server-runtime/agent-host.mjs",
		"server-runtime/forgeax-core-serve.mjs",
		"server-runtime/assets/game-charter.md",
		"server-runtime/assets/ui-bridge-contract.json",
	];
}

export function stageGameCreationResources(payload: string): string[] {
	const librarySource = join(SERVER_ROOT, "assets/asset-library");
	for (const file of ["worker.js", "provenance.json"]) {
		if (!existsSync(join(librarySource, file)))
			fail(
				`Studio asset library ${file} is missing; build Server asset-library resources first`,
			);
	}
	copyTree(librarySource, join(payload, "product/asset-library"));
	const catalog = join(payload, "editor/apps/standalone/template-catalog.ts");
	if (!existsSync(catalog))
		fail(`composed Editor template catalog is missing: ${catalog}`);
	copyTree(
		join(SERVER_ROOT, "templates/game-minimal"),
		join(payload, "server/templates/game-minimal"),
		true,
	);
	const templates = join(payload, "editor/packages/engine/templates");
	if (!existsSync(templates))
		fail(`composed Engine templates are missing: ${templates}`);
	const required = [
		"product/asset-library/worker.js",
		"product/asset-library/provenance.json",
		"editor/apps/standalone/template-catalog.ts",
		"server/templates/game-minimal/forge.json",
		"server/templates/game-minimal/main.ts",
	];
	let templateCount = 0;
	for (const entry of readdirSync(templates, { withFileTypes: true })) {
		if (
			!entry.isDirectory() ||
			entry.name.startsWith(".") ||
			entry.name.startsWith("_") ||
			entry.name === "node_modules"
		)
			continue;
		const templateRoot = join(templates, entry.name);
		const manifestPath = join(templateRoot, "forge.json");
		const manifestRelative = `editor/packages/engine/templates/${entry.name}/forge.json`;
		if (!existsSync(manifestPath) || !statSync(manifestPath).isFile())
			fail(`packaged game template is incomplete: ${manifestRelative}`);
		// Engine validates forge.json before producing the common artifact. Its
		// verified manifest covers every template file; IDE only checks composition.
		required.push(manifestRelative);
		templateCount += 1;
	}
	if (templateCount === 0) fail("no engine game templates were staged");
	return [
		...required,
		...stageEngineProjectSkills(
			join(EDITOR_ROOT, "packages/engine"),
			payload,
			submoduleRevision(EDITOR_ROOT, "packages/engine"),
		),
	];
}

export function createRuntimeCommonArtifact(
	output: string,
	webCommon: string,
	engineCommon: string,
	localSource?: unknown,
): ArtifactManifest {
	let result: ArtifactManifest | undefined;
	createOutput(output, (temporary, payload) => {
		materializeWebArtifact(webCommon, join(payload, "interface/dist"));
		const engine = join(temporary, "engine-common");
		composeEngineCommonArtifacts(engineCommon, engine);
		copyTree(engine, payload);
		rmSync(engine, { recursive: true, force: true });
		mkdirSync(join(payload, "runtime"), { recursive: true });
		if (localSource !== undefined)
			writeFileSync(
				join(payload, "runtime/local-build-source.json"),
				`${JSON.stringify(localSource, null, 2)}\n`,
			);
		run([
			"build",
			join(IDE_ROOT, "scripts/desktop-runtime.ts"),
			"--target=bun",
			"--outfile",
			join(payload, "runtime/local-runtime.mjs"),
		]);
		run([
			"build",
			join(IDE_ROOT, "scripts/desktop-engine.ts"),
			"--target=bun",
			"--outfile",
			join(payload, "runtime/engine-runtime.mjs"),
		]);
		const required = [
			...stageGameCreationResources(payload),
			...stageServerCommonRuntime(payload),
		];
		for (const path of required)
			if (!existsSync(join(payload, path)))
				fail(`common runtime resource is missing: ${path}`);
		normalizePortableArtifactFiles(payload);
		result = writeManifest(
			payload,
			join(temporary, "manifest.json"),
			runtimeArtifactDescriptor("common"),
		);
	});
	return result!;
}

export function createRuntimeTargetArtifact(
	output: string,
	platform: DesktopPlatform,
	engineTarget: string,
	serverSidecarRoot: string,
	context: RuntimeSidecarContext,
): ArtifactManifest {
	let result: ArtifactManifest | undefined;
	const target = platformTargets[platform];
	createOutput(output, (temporary, payload) => {
		const engine = join(temporary, "engine-target");
		composeEngineTargetArtifact(engineTarget, platform, engine);
		copyTree(engine, payload);
		rmSync(engine, { recursive: true, force: true });
		const sharpResources = stageServerTargetRuntime(
			payload,
			platform,
			isSourceContext(context),
		);
		const sidecars = join(payload, "sidecars");
		mkdirSync(sidecars, { recursive: true });
		const bunSidecar = join(
			sidecars,
			`bun-${target.triple}${target.extension}`,
		);
		if (
			`bun@${Bun.version}` !==
			readJson(join(IDE_ROOT, "package.json")).packageManager
		)
			fail("bundled Bun version differs from IDE packageManager");
		copyVerifiedExecutable(process.execPath, bunSidecar, platform);
		if (target.extension === "") chmodSync(bunSidecar, 0o755);
		if (target.os !== process.platform || target.arch !== process.arch)
			fail(`bundled Bun must be validated on native ${platform} host`);
		const bunProbe = spawnSync(bunSidecar, ["--version"], {
			encoding: "utf8",
		});
		if (
			bunProbe.error ||
			bunProbe.status !== 0 ||
			bunProbe.stdout.trim() !== Bun.version
		)
			fail(`bundled Bun version check failed for ${platform}`);
		if (platform !== "windows-x64") {
			runCommand(
				"cargo",
				[
					"build",
					"--manifest-path",
					join(IDE_ROOT, "src-tauri/Cargo.toml"),
					"--bin",
					"runtime-guardian",
					"--target",
					target.triple,
					"--release",
				],
				IDE_ROOT,
				{ FORGEAX_BUILD_RUNTIME_GUARDIAN: "1" },
			);
			const guardianSource = join(
				IDE_ROOT,
				"src-tauri/target",
				target.triple,
				"release",
				`runtime-guardian${target.extension}`,
			);
			if (!existsSync(guardianSource) || !statSync(guardianSource).isFile()) {
				fail(`runtime guardian build output is missing: ${guardianSource}`);
			}
			const guardianSidecar = join(
				sidecars,
				`runtime-guardian-${target.triple}`,
			);
			copyVerifiedExecutable(guardianSource, guardianSidecar, platform);
			chmodSync(guardianSidecar, 0o755);
		}
		const serverName = `forgeax-server-${target.triple}${target.extension}`;
		const serverSource = join(
			resolve(serverSidecarRoot),
			"sidecars",
			serverName,
		);
		if (!existsSync(serverSource) || statSync(serverSource).size < 1_048_576)
			fail(`validated server sidecar is missing: ${serverSource}`);
		if (isSourceContext(context))
			validateSourceBinary(
				context,
				readFileSync(serverSource),
				platform,
				readJson(join(SERVER_ROOT, "package.json")).version!,
			);
		const serverSidecar = join(sidecars, serverName);
		copyVerifiedExecutable(serverSource, serverSidecar, platform);
		if (target.extension === "") {
			chmodSync(serverSidecar, 0o755);
		}
		for (const path of [
			`sidecars/bun-${target.triple}${target.extension}`,
			...(platform === "windows-x64"
				? []
				: [`sidecars/runtime-guardian-${target.triple}${target.extension}`]),
			`sidecars/${serverName}`,
			...sharpResources,
		])
			if (!existsSync(join(payload, path)))
				fail(`target runtime resource is missing: ${path}`);
		result = writeManifest(
			payload,
			join(temporary, "manifest.json"),
			runtimeArtifactDescriptor("target", platform, context),
		);
	});
	return result!;
}

export function materializeRuntimeWeb(
	common: string,
	destination: string,
): void {
	const commonRoot = resolve(common);
	const manifest = readManifest(join(commonRoot, "manifest.json"));
	verifyArtifactManifest(
		join(commonRoot, "payload"),
		manifest,
		runtimeArtifactDescriptor("common"),
	);
	const output = resolve(destination);
	if (existsSync(output)) fail(`Web destination already exists: ${output}`);
	copyTree(join(commonRoot, "payload/interface/dist"), output);
}

export function runtimeArtifactInputs(
	common: string,
	target: string,
	platform: DesktopPlatform,
	context: RuntimeSidecarContext,
) {
	const commonRoot = resolve(common);
	const targetRoot = resolve(target);
	return [
		{
			root: join(commonRoot, "payload"),
			manifest: readManifest(join(commonRoot, "manifest.json")),
			expected: runtimeArtifactDescriptor("common"),
		},
		{
			root: join(targetRoot, "payload"),
			manifest: readManifest(join(targetRoot, "manifest.json")),
			expected: runtimeArtifactDescriptor("target", platform, context),
		},
	];
}

if (import.meta.main) {
	const command = Bun.argv[2];
	const output = argument("--output");
	if (!output) fail("--output is required");
	if (command === "common") {
		const webCommon = argument("--web-common");
		const engineCommon = argument("--engine-common");
		if (!webCommon || !engineCommon)
			fail("common requires --web-common and --engine-common");
		createRuntimeCommonArtifact(output, webCommon, engineCommon);
	} else if (command === "target") {
		const platform = argument("--platform") as DesktopPlatform | undefined;
		const engineTarget = argument("--engine-target");
		const serverSidecarRoot = argument("--server-sidecar-root");
		const contextPath = argument("--context");
		if (
			!platform ||
			!(platform in platformTargets) ||
			!engineTarget ||
			!serverSidecarRoot ||
			!contextPath
		) {
			fail(
				"target requires --platform, --engine-target, --server-sidecar-root, and --context",
			);
		}
		const context = JSON.parse(
			readFileSync(contextPath, "utf8"),
		) as RuntimeSidecarContext;
		createRuntimeTargetArtifact(
			output,
			platform,
			engineTarget,
			serverSidecarRoot,
			context,
		);
	} else {
		fail("command must be common or target");
	}
	console.log(
		JSON.stringify({ code: "DESKTOP_RUNTIME_ARTIFACT_COMMAND_OK", command }),
	);
}
