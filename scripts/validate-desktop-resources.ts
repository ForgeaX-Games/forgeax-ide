import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { verifyDesktopEngineDependencies } from "./desktop-engine-dependencies";
import { type DesktopPlatform, platformTargets } from "./desktop-platforms";
import {
	DESKTOP_ENGINE_REQUIRED_ROOT_RESOURCE_PATHS,
	desktopEngineConfigImportErrors,
} from "./desktop-runtime-layout";
import {
	readDesktopRuntimeManifest,
	verifyDesktopRuntimeManifest,
} from "./desktop-runtime-manifest";

type ResourceError = { code: string; path?: string };

const REQUIRED_COMMON_RESOURCES = [
	"runtime/local-runtime.mjs",
	"runtime/engine-runtime.mjs",
	"interface/dist/index.html",
	...DESKTOP_ENGINE_REQUIRED_ROOT_RESOURCE_PATHS,
	"engine/node_modules/vite/bin/vite.js",
	"editor/apps/standalone/template-catalog.ts",
	"server/templates/game-minimal/forge.json",
	"server/templates/game-minimal/main.ts",
	"engine/node_modules/@forgeax/engine-wgpu-wasm/pkg/wgpu_wasm_bg.wasm",
	"engine/node_modules/@forgeax/engine-fbx/pkg/fbx-wasm.wasm",
	"engine/node_modules/@forgeax/engine-codec/pkg/basis_transcoder.wasm",
	"server-runtime/native-preload.mjs",
	"server-runtime/agent-host.mjs",
	"server-runtime/forgeax-core-serve.mjs",
	"server-runtime/assets/game-charter.md",
	"server-runtime/assets/ui-bridge-contract.json",
] as const;

export function validateDesktopResources(
	root: string,
	platform: DesktopPlatform,
): ResourceError[] {
	const errors: ResourceError[] = [];
	const config = JSON.parse(
		readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"),
	) as {
		build?: { frontendDist?: string };
		bundle?: { active?: boolean; externalBin?: string[]; resources?: string[] };
	};
	if (config.build?.frontendDist !== "../dist")
		errors.push({ code: "frontend-dist-invalid" });
	if (config.bundle?.active !== true) errors.push({ code: "bundle-inactive" });
	if (
		JSON.stringify(config.bundle?.externalBin) !==
		JSON.stringify(["resources/sidecars/bun"])
	)
		errors.push({ code: "sidecar-contract-mismatch" });
	if (!config.bundle?.resources?.includes("resources"))
		errors.push({ code: "resources-contract-missing" });
	if (!existsSync(join(root, "src-tauri/capabilities/main.json")))
		errors.push({ code: "main-capability-missing" });
	const target = platformTargets[platform];
	const sidecarPath = join(
		root,
		`src-tauri/resources/sidecars/forgeax-server-${target.triple}${target.extension}`,
	);
	if (!existsSync(sidecarPath))
		errors.push({ code: "production-sidecar-missing", path: sidecarPath });
	else {
		const stat = statSync(sidecarPath);
		if (!stat.isFile() || stat.size < 1_048_576)
			errors.push({ code: "production-sidecar-invalid", path: sidecarPath });
		else if (
			readFileSync(sidecarPath)
				.subarray(0, 512)
				.toString()
				.includes("IDE_SIDECAR_PLACEHOLDER")
		)
			errors.push({ code: "placeholder-sidecar", path: sidecarPath });
	}
	const bunPath = join(
		root,
		`src-tauri/resources/sidecars/bun-${target.triple}${target.extension}`,
	);
	if (
		!existsSync(bunPath) ||
		!statSync(bunPath).isFile() ||
		statSync(bunPath).size < 1_048_576
	) {
		errors.push({ code: "bun-sidecar-missing-or-invalid", path: bunPath });
	}
	if (platform !== "windows-x64") {
		const guardianPath = join(
			root,
			`src-tauri/resources/sidecars/runtime-guardian-${target.triple}${target.extension}`,
		);
		if (
			!existsSync(guardianPath) ||
			!statSync(guardianPath).isFile() ||
			(statSync(guardianPath).mode & 0o111) === 0
		) {
			errors.push({
				code: "runtime-guardian-missing-or-invalid",
				path: guardianPath,
			});
		}
	}
	const rustShell = readFileSync(join(root, "src-tauri/src/lib.rs"), "utf8");
	const rustSidecars = [...rustShell.matchAll(/\.sidecar\("([^"]+)"\)/g)].map(
		(match) => match[1],
	);
	if (JSON.stringify(rustSidecars) !== JSON.stringify(["bun"]))
		errors.push({ code: "rust-sidecar-contract-mismatch" });

	const resources = join(root, "src-tauri/resources");
	const manifestPath = join(resources, "runtime/desktop-runtime-manifest.json");
	if (!existsSync(manifestPath))
		errors.push({ code: "runtime-manifest-missing", path: manifestPath });
	else {
		try {
			verifyDesktopRuntimeManifest(
				resources,
				readDesktopRuntimeManifest(resources),
				platform,
			);
		} catch {
			errors.push({ code: "runtime-manifest-invalid", path: manifestPath });
		}
	}
	try {
		verifyDesktopEngineDependencies(resources);
	} catch (error) {
		errors.push({
			code: "engine-project-dependencies-invalid",
			path: String(error),
		});
	}
	for (const resource of REQUIRED_COMMON_RESOURCES) {
		if (!existsSync(join(resources, resource)))
			errors.push({
				code: "runtime-required-resource-missing",
				path: resource,
			});
	}
	for (const importPath of desktopEngineConfigImportErrors(
		join(resources, "engine"),
	)) {
		errors.push({
			code: "runtime-engine-config-import-missing",
			path: `engine/${importPath}`,
		});
	}
	return errors;
}

if (import.meta.main) {
	const index = Bun.argv.indexOf("--platform");
	const platform = Bun.argv[index + 1] as DesktopPlatform;
	if (!(platform in platformTargets))
		throw new Error("release platform is required");
	const root = join(import.meta.dirname, "..");
	const errors = validateDesktopResources(root, platform);
	if (errors.length) {
		console.error(
			JSON.stringify({
				code: "IDE_DESKTOP_RESOURCES_INVALID",
				platform,
				errors,
			}),
		);
		process.exit(1);
	}
	console.log(
		JSON.stringify({ code: "IDE_DESKTOP_RESOURCES_VALID", platform }),
	);
}
