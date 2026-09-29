#!/usr/bin/env bun

import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
	type ArtifactDescriptor,
	type ArtifactManifest,
	type ComposeInput,
	composeArtifacts,
	createArtifactManifest,
} from "./artifact-manifest";
import { type DesktopPlatform, platformTargets } from "./desktop-platforms";
import {
	gitProducer,
	gitValue,
	trackedIdentityFile,
} from "./release-artifact-identity";

const IDE_ROOT = resolve(import.meta.dirname, "..");
const INTEGRATION_ROOT = resolve(IDE_ROOT, "../..");
const EDITOR_ROOT = join(INTEGRATION_ROOT, "packages/editor");
const ENGINE_ROOT = join(EDITOR_ROOT, "packages/engine");

function fail(message: string): never {
	throw new Error(`[engine-runtime-artifacts] ${message}`);
}

function argument(name: string): string | undefined {
	const index = Bun.argv.indexOf(name);
	return index >= 0 ? Bun.argv[index + 1] : undefined;
}

function run(command: string, args: string[], cwd: string): void {
	const result = spawnSync(command, args, {
		cwd,
		stdio: "inherit",
		env: process.env,
	});
	if (result.status !== 0)
		fail(`command failed (${result.status}): ${command} ${args.join(" ")}`);
}

export { trackedIdentityFile } from "./release-artifact-identity";

function releaseSourceIdentity(): Record<string, string> {
	return {
		"ide-revision": gitValue(IDE_ROOT, "rev-parse", "HEAD"),
		"integration-revision": gitValue(INTEGRATION_ROOT, "rev-parse", "HEAD"),
	};
}

function engineDescriptor(): ArtifactDescriptor {
	return {
		artifactId: "engine-runtime-common/v1",
		producer: gitProducer(ENGINE_ROOT, "ForgeaX-Games/forgeax-engine"),
		inputs: {
			lockfiles: [trackedIdentityFile(ENGINE_ROOT, "pnpm-lock.yaml")],
			buildScripts: [
				trackedIdentityFile(ENGINE_ROOT, "scripts/stage-desktop-runtime.mjs"),
			],
			toolchains: {
				node: process.version,
				...releaseSourceIdentity(),
				"editor-revision": gitValue(EDITOR_ROOT, "rev-parse", "HEAD"),
			},
		},
		scope: "common",
		target: null,
	};
}

export function editorDescriptor(
	scope: "common" | "target",
	platform?: DesktopPlatform,
): ArtifactDescriptor {
	const target = platform ? platformTargets[platform] : undefined;
	return {
		artifactId:
			scope === "common"
				? "editor-engine-runtime-common/v1"
				: "editor-engine-runtime-target/v1",
		producer: gitProducer(EDITOR_ROOT, "ForgeaX-Games/forgeax-editor"),
		inputs: {
			lockfiles: [trackedIdentityFile(EDITOR_ROOT, "bun.lock")],
			buildScripts: [
				trackedIdentityFile(
					EDITOR_ROOT,
					"scripts/stage-desktop-engine-runtime.ts",
				),
				...(scope === "target"
					? [
							trackedIdentityFile(
								IDE_ROOT,
								"scripts/engine-runtime-artifacts.ts",
								"ide/scripts/engine-runtime-artifacts.ts",
							),
							trackedIdentityFile(
								IDE_ROOT,
								"scripts/desktop-platforms.ts",
								"ide/scripts/desktop-platforms.ts",
							),
						]
					: []),
			].sort((left, right) =>
				left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
			),
			toolchains: {
				bun:
					process.versions.bun ??
					execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(),
				node: process.version,
				...releaseSourceIdentity(),
				"engine-revision": gitValue(ENGINE_ROOT, "rev-parse", "HEAD"),
			},
		},
		scope,
		target: target ? { platform: platform!, triple: target.triple } : null,
	};
}

export function assertTargetHost(
	platform: DesktopPlatform,
	hostPlatform = process.platform,
	hostArch = process.arch,
): void {
	const expected =
		platform === "macos-arm64"
			? ["darwin", "arm64"]
			: platform === "macos-x64"
				? ["darwin", "x64"]
				: platform === "linux-x64"
					? ["linux", "x64"]
					: ["win32", "x64"];
	if (hostPlatform !== expected[0] || hostArch !== expected[1]) {
		fail(
			`${platform} artifact must be staged on ${expected.join("/")}; current host is ${hostPlatform}/${hostArch}`,
		);
	}
}

function writeManifest(
	root: string,
	manifestPath: string,
	descriptor: ArtifactDescriptor,
): void {
	const manifest = createArtifactManifest(root, descriptor);
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
		flag: "wx",
	});
}

/** Narrow the installed native closure to the IDE product's exact OS/CPU/libc target. */
export function pruneIncompatibleTargetPackages(
	payload: string,
	platform: DesktopPlatform,
): void {
	const target = platformTargets[platform];
	const libc = target.triple.endsWith("-linux-gnu") ? "glibc" : undefined;
	const modules = join(payload, "engine/node_modules");
	const accepts = (
		constraint: string[] | string | undefined,
		value: string,
	): boolean => {
		const values =
			typeof constraint === "string" ? [constraint] : (constraint ?? []);
		return (
			!values.includes(`!${value}`) &&
			(!values.some((entry) => !entry.startsWith("!")) ||
				values.includes(value) ||
				values.includes("any"))
		);
	};
	const packages = readdirSync(modules, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.flatMap((entry) =>
			entry.name.startsWith("@")
				? readdirSync(join(modules, entry.name)).map((name) =>
						join(modules, entry.name, name),
					)
				: [join(modules, entry.name)],
		);
	for (const directory of packages) {
		const path = join(directory, "package.json");
		if (!existsSync(path)) continue;
		const manifest = JSON.parse(readFileSync(path, "utf8")) as {
			os?: string[] | string;
			cpu?: string[] | string;
			libc?: string[] | string;
		};
		if (
			!accepts(manifest.os, target.os) ||
			!accepts(manifest.cpu, target.arch) ||
			(libc && !accepts(manifest.libc, libc))
		) {
			rmSync(directory, { recursive: true });
		}
	}
}

export function createEngineCommonArtifacts(output: string): void {
	const root = resolve(output);
	if (existsSync(root)) fail(`output already exists: ${root}`);
	const engine = join(root, "engine");
	const editor = join(root, "editor");
	mkdirSync(root, { recursive: true });
	run(
		process.execPath,
		[
			join(ENGINE_ROOT, "scripts/stage-desktop-runtime.mjs"),
			"--output",
			join(engine, "payload"),
		],
		ENGINE_ROOT,
	);
	run(
		process.execPath,
		[
			join(EDITOR_ROOT, "scripts/stage-desktop-engine-runtime.ts"),
			"--scope",
			"common",
			"--output",
			join(editor, "payload"),
		],
		EDITOR_ROOT,
	);
	writeManifest(
		join(engine, "payload"),
		join(engine, "manifest.json"),
		engineDescriptor(),
	);
	writeManifest(
		join(editor, "payload"),
		join(editor, "manifest.json"),
		editorDescriptor("common"),
	);
}

export function createEngineTargetArtifact(
	output: string,
	platform: DesktopPlatform,
): void {
	assertTargetHost(platform);
	const root = resolve(output);
	if (existsSync(root)) fail(`output already exists: ${root}`);
	mkdirSync(root, { recursive: true });
	run(
		process.execPath,
		[
			join(EDITOR_ROOT, "scripts/stage-desktop-engine-runtime.ts"),
			"--scope",
			"target",
			"--output",
			join(root, "payload"),
		],
		EDITOR_ROOT,
	);
	pruneIncompatibleTargetPackages(join(root, "payload"), platform);
	writeManifest(
		join(root, "payload"),
		join(root, "manifest.json"),
		editorDescriptor("target", platform),
	);
}

function manifest(path: string): ArtifactManifest {
	if (!existsSync(path)) fail(`manifest is missing: ${path}`);
	return JSON.parse(readFileSync(path, "utf8")) as ArtifactManifest;
}

function commonInputs(commonRoot: string): ComposeInput[] {
	return [
		{
			root: join(commonRoot, "engine/payload"),
			manifest: manifest(join(commonRoot, "engine/manifest.json")),
			expected: engineDescriptor(),
		},
		{
			root: join(commonRoot, "editor/payload"),
			manifest: manifest(join(commonRoot, "editor/manifest.json")),
			expected: editorDescriptor("common"),
		},
	];
}

function targetInput(
	targetRoot: string,
	platform: DesktopPlatform,
): ComposeInput {
	return {
		root: join(targetRoot, "payload"),
		manifest: manifest(join(targetRoot, "manifest.json")),
		expected: editorDescriptor("target", platform),
	};
}

export function composeEngineCommonArtifacts(
	common: string,
	destination: string,
): void {
	composeArtifacts(resolve(destination), commonInputs(resolve(common)));
}

export function composeEngineTargetArtifact(
	target: string,
	platform: DesktopPlatform,
	destination: string,
): void {
	composeArtifacts(resolve(destination), [
		targetInput(resolve(target), platform),
	]);
}

export function composeEngineArtifacts(
	common: string,
	target: string,
	platform: DesktopPlatform,
	destination: string,
): void {
	const commonRoot = resolve(common);
	const targetRoot = resolve(target);
	const output = resolve(destination);
	composeArtifacts(output, [
		...commonInputs(commonRoot),
		targetInput(targetRoot, platform),
	]);
}

if (import.meta.main) {
	const command = Bun.argv[2];
	if (command === "common") {
		const output = argument("--output");
		if (!output) fail("--output is required");
		createEngineCommonArtifacts(output);
	} else if (command === "target") {
		const output = argument("--output");
		const platform = argument("--platform") as DesktopPlatform | undefined;
		if (!output || !platform || !(platform in platformTargets))
			fail("target requires --output and a supported --platform");
		createEngineTargetArtifact(output, platform);
	} else if (command === "compose") {
		const common = argument("--common");
		const target = argument("--target");
		const destination = argument("--destination");
		const platform = argument("--platform") as DesktopPlatform | undefined;
		if (
			!common ||
			!target ||
			!destination ||
			!platform ||
			!(platform in platformTargets)
		)
			fail(
				"compose requires --common, --target, --destination, and a supported --platform",
			);
		composeEngineArtifacts(common, target, platform, destination);
	} else {
		fail("command must be common, target, or compose");
	}
	console.log(
		JSON.stringify({ code: "ENGINE_RUNTIME_ARTIFACT_COMMAND_OK", command }),
	);
}
