#!/usr/bin/env bun

import { execFileSync, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
	type ArtifactDescriptor,
	type ArtifactManifest,
	composeArtifacts,
	createArtifactManifest,
	normalizePortableArtifactFiles,
} from "./artifact-manifest";
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
	throw new Error(`[web-runtime-artifact] ${message}`);
}

function argument(name: string): string | undefined {
	const index = Bun.argv.indexOf(name);
	return index >= 0 ? Bun.argv[index + 1] : undefined;
}

function descriptor(): ArtifactDescriptor {
	return {
		artifactId: "ide-web-bundle/v1",
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
			buildScripts: [
				trackedIdentityFile(IDE_ROOT, "scripts/build-web.ts"),
				trackedIdentityFile(IDE_ROOT, "scripts/ensure-shader-build-inputs.ts"),
				trackedIdentityFile(IDE_ROOT, "vite.config.ts"),
			],
			toolchains: {
				bun:
					process.versions.bun ??
					execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(),
				node: process.version,
				"publishable-shader-inputs":
					process.env.FORGEAX_REQUIRE_PUBLISHABLE_SHADER_INPUTS === "1"
						? "required"
						: "not-required",
				"integration-revision": gitValue(INTEGRATION_ROOT, "rev-parse", "HEAD"),
				"editor-revision": gitValue(EDITOR_ROOT, "rev-parse", "HEAD"),
				"engine-revision": gitValue(ENGINE_ROOT, "rev-parse", "HEAD"),
			},
		},
		scope: "common",
		target: null,
	};
}

function readManifest(path: string): ArtifactManifest {
	if (!existsSync(path)) fail(`manifest is missing: ${path}`);
	return JSON.parse(readFileSync(path, "utf8")) as ArtifactManifest;
}

export function createWebArtifactFromDirectory(
	source: string,
	output: string,
): ArtifactManifest {
	const sourceRoot = resolve(source);
	const outputRoot = resolve(output);
	if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory())
		fail(`Web bundle is missing: ${sourceRoot}`);
	if (existsSync(outputRoot)) fail(`output already exists: ${outputRoot}`);
	const temporary = `${outputRoot}.create-${process.pid}`;
	if (existsSync(temporary))
		fail(`temporary output already exists: ${temporary}`);
	try {
		const payload = join(temporary, "payload");
		mkdirSync(temporary, { recursive: true });
		cpSync(sourceRoot, payload, {
			recursive: true,
			dereference: false,
			force: false,
		});
		normalizePortableArtifactFiles(payload);
		const manifest = createArtifactManifest(payload, descriptor());
		writeFileSync(
			join(temporary, "manifest.json"),
			`${JSON.stringify(manifest, null, 2)}\n`,
			{ flag: "wx" },
		);
		renameSync(temporary, outputRoot);
		return manifest;
	} catch (error) {
		rmSync(temporary, { recursive: true, force: true });
		throw error;
	}
}

export function materializeWebArtifact(
	input: string,
	destination: string,
): void {
	const inputRoot = resolve(input);
	composeArtifacts(resolve(destination), [
		{
			root: join(inputRoot, "payload"),
			manifest: readManifest(join(inputRoot, "manifest.json")),
			expected: descriptor(),
		},
	]);
}

function buildWebArtifact(output: string): void {
	const dist = join(IDE_ROOT, "dist");
	if (existsSync(dist))
		fail(`refusing to build over existing Web dist: ${dist}`);
	const result = spawnSync(process.execPath, ["run", "build:web"], {
		cwd: IDE_ROOT,
		stdio: "inherit",
		env: { ...process.env, FORGEAX_INTEGRATION_ROOT: INTEGRATION_ROOT },
	});
	if (result.status !== 0) fail(`build:web failed (${result.status})`);
	createWebArtifactFromDirectory(dist, output);
	rmSync(dist, { recursive: true, force: true });
}

if (import.meta.main) {
	const command = Bun.argv[2];
	if (command === "build") {
		const output = argument("--output");
		if (!output) fail("build requires --output");
		buildWebArtifact(output);
	} else if (command === "materialize") {
		const input = argument("--input");
		const output = argument("--output");
		if (!input || !output) fail("materialize requires --input and --output");
		materializeWebArtifact(input, output);
	} else {
		fail(
			"usage: build --output <artifact> | materialize --input <artifact> --output <dist>",
		);
	}
}
