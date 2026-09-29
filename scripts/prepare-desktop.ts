#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	buildSourceSidecar,
	DESKTOP_SOURCE_CONTEXT_PATH,
} from "./build-source-sidecar";
import { composeDesktopResources } from "./compose-desktop-resources";
import { type DesktopPlatform, platformTargets } from "./desktop-platforms";
import {
	createEngineCommonArtifacts,
	createEngineTargetArtifact,
} from "./engine-runtime-artifacts";
import { localBuildSource } from "./local-build-source";
import { DESKTOP_BUILD_SOURCE_PATH } from "./native-product-receipt";
import {
	createRuntimeCommonArtifact,
	createRuntimeTargetArtifact,
} from "./runtime-artifacts";
import { validateDesktopResources } from "./validate-desktop-resources";
import { createWebArtifactFromDirectory } from "./web-runtime-artifact";

export function desktopBuildPlatform(
	os = process.platform,
	arch = process.arch,
	triple = process.env.TAURI_ENV_TARGET_TRIPLE,
): DesktopPlatform {
	const entry = Object.entries(platformTargets).find(
		([, target]) => target.os === os && target.arch === arch,
	);
	if (!entry) throw new Error(`unsupported desktop build host: ${os}/${arch}`);
	if (triple && triple !== entry[1].triple)
		throw new Error(
			`desktop resources require a native build: ${triple} on ${os}/${arch}`,
		);
	return entry[0] as DesktopPlatform;
}

export async function prepareDesktop(): Promise<void> {
	const platform = desktopBuildPlatform();
	const root = resolve(import.meta.dirname, "..");
	const contextPath = join(root, DESKTOP_SOURCE_CONTEXT_PATH);
	const buildSourcePath = join(root, DESKTOP_BUILD_SOURCE_PATH);
	// A failed rebuild must not leave an earlier build's receipt available.
	rmSync(contextPath, { force: true });
	rmSync(buildSourcePath, { force: true });
	const run = (args: string[], cwd = root): void => {
		const result = spawnSync(process.execPath, args, {
			cwd,
			stdio: "inherit",
			env: process.env,
		});
		if (result.error) throw result.error;
		if (result.status !== 0)
			throw new Error(
				`desktop preparation failed: bun ${args.join(" ")} (${result.status})`,
			);
	};
	// The source context records this lock's digest. Install it here as well so
	// a Web-only or stale workspace cannot silently produce a different binary.
	run(["scripts/install-desktop-source-workspace.ts"]);
	const work = join(root, "release-work");
	mkdirSync(work, { recursive: true });
	const stage = mkdtempSync(join(work, "local-desktop-"));
	try {
		const source = localBuildSource(resolve(root, "../.."));
		// Reuse CI's resource composers and source revision checks.
		const server = join(stage, "server");
		const context = await buildSourceSidecar(server, platform);
		// Web preparation owns wgpu-wasm. Desktop also needs the native importers;
		// use their producer-owned fetch/build contracts before artifact staging.
		const cachedWasm =
			process.env.FORGEAX_CI_CACHE_PROFILE === "desktop" &&
			spawnSync(
				"python3",
				[join(root, ".ci/cache.py"), "ready", "wasm", "--profile", "desktop"],
				{ cwd: root, stdio: "inherit", env: process.env },
			).status === 0;
		for (const name of ["fbx", "codec"]) {
			if (cachedWasm) {
				console.log(`[desktop] reusing verified ${name} WASM cache`);
				continue;
			}
			const cwd = resolve(root, "../editor/packages/engine/packages", name);
			const fetch = spawnSync(process.execPath, ["run", "fetch-wasm"], {
				cwd,
				stdio: "inherit",
				env: process.env,
			});
			if (fetch.error) throw fetch.error;
			if (fetch.status !== 0) run(["run", "build:wasm"], cwd);
		}
		run(["run", "build:web", "--desktop"]);
		const webCommon = join(stage, "web");
		const engineCommon = join(stage, "engine-common");
		const engineTarget = join(stage, "engine-target");
		const runtimeCommon = join(stage, "runtime-common");
		const runtimeTarget = join(stage, "runtime-target");
		createWebArtifactFromDirectory(join(root, "dist"), webCommon);
		createEngineCommonArtifacts(engineCommon);
		createEngineTargetArtifact(engineTarget, platform);
		createRuntimeCommonArtifact(runtimeCommon, webCommon, engineCommon, source);
		createRuntimeTargetArtifact(
			runtimeTarget,
			platform,
			engineTarget,
			server,
			context,
		);
		composeDesktopResources(runtimeCommon, runtimeTarget, platform, context);
		const errors = validateDesktopResources(root, platform);
		if (errors.length)
			throw new Error(`desktop resources invalid: ${JSON.stringify(errors)}`);
		// The source snapshot deliberately ignores product output paths which the
		// composer replaces. Any other source drift makes this build unusable.
		const finalSource = localBuildSource(resolve(root, "../.."));
		if (JSON.stringify(finalSource) !== JSON.stringify(source)) {
			throw new Error(
				"desktop source changed during resource preparation; retry with a stable checkout",
			);
		}
		// CI archives this receipt after the hook's temporary artifacts are removed.
		writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`);
		// Capture before Tauri compiles the final product; a later finalizer must
		// never infer the historical build source from its current checkout.
		writeFileSync(buildSourcePath, `${JSON.stringify(finalSource, null, 2)}\n`);
		console.log(
			JSON.stringify({
				code: "IDE_LOCAL_DESKTOP_PREPARED",
				platform,
				sourceRevisions: context.sourceRevisions,
			}),
		);
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

if (import.meta.main) await prepareDesktop();
