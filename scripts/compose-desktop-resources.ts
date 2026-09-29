import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	type ArtifactManifest,
	composeArtifacts,
	verifyArtifactManifest,
} from "./artifact-manifest";
import { stageDesktopEngineDependencies } from "./desktop-engine-dependencies";
import { type DesktopPlatform, platformTargets } from "./desktop-platforms";
import {
	createDesktopRuntimeManifest,
	verifyDesktopRuntimeManifest,
} from "./desktop-runtime-manifest";
import {
	materializeRuntimeWeb,
	type RuntimeSidecarContext,
	runtimeArtifactInputs,
} from "./runtime-artifacts";

const IDE_ROOT = resolve(import.meta.dirname, "..");

function fail(message: string): never {
	throw new Error(`[desktop-resource-compose] ${message}`);
}

function argument(name: string): string | undefined {
	const index = Bun.argv.indexOf(name);
	return index >= 0 ? Bun.argv[index + 1] : undefined;
}

type Replacement = { source: string; destination: string };

export function replaceDirectoriesTransactionally(
	replacements: Replacement[],
): void {
	const transaction = `${process.pid}-${Date.now()}`;
	const prepared = replacements.map(({ source, destination }) => ({
		source: resolve(source),
		destination: resolve(destination),
		backup: `${resolve(destination)}.replace-${transaction}`,
		hadDestination: existsSync(destination),
		installed: false,
	}));
	if (prepared.length === 0)
		fail("at least one directory replacement is required");
	for (const item of prepared) {
		if (!existsSync(item.source))
			fail(`staged directory is missing: ${item.source}`);
		if (existsSync(item.backup))
			fail(`replacement backup already exists: ${item.backup}`);
		mkdirSync(dirname(item.destination), { recursive: true });
	}
	try {
		for (const item of prepared)
			if (item.hadDestination) renameSync(item.destination, item.backup);
		for (const item of prepared) {
			renameSync(item.source, item.destination);
			item.installed = true;
		}
	} catch (error) {
		for (const item of [...prepared].reverse()) {
			if (item.installed && existsSync(item.destination))
				rmSync(item.destination, { recursive: true, force: true });
			if (item.hadDestination && existsSync(item.backup))
				renameSync(item.backup, item.destination);
		}
		throw error;
	}
	for (const item of prepared)
		if (item.hadDestination)
			rmSync(item.backup, { recursive: true, force: true });
}

export function composeDesktopResources(
	common: string,
	target: string,
	platform: DesktopPlatform,
	context: RuntimeSidecarContext,
	ideRoot = IDE_ROOT,
): void {
	const root = resolve(ideRoot);
	const stagingRoot = join(root, "release-work/staging");
	const stagedResources = join(
		stagingRoot,
		`desktop-resources-${platform}-${process.pid}`,
	);
	const stagedDist = join(
		stagingRoot,
		`desktop-dist-${platform}-${process.pid}`,
	);
	if (existsSync(stagedResources) || existsSync(stagedDist))
		fail("compose staging path already exists");
	mkdirSync(stagingRoot, { recursive: true });
	try {
		const inputs = runtimeArtifactInputs(common, target, platform, context);
		composeArtifacts(stagedResources, inputs);
		stageDesktopEngineDependencies(stagedResources);
		materializeRuntimeWeb(common, stagedDist);
		const commonManifest = verifyArtifactManifest(
			inputs[0].root,
			inputs[0].manifest,
			inputs[0].expected,
		) as ArtifactManifest;
		const targetManifest = verifyArtifactManifest(
			inputs[1].root,
			inputs[1].manifest,
			inputs[1].expected,
		) as ArtifactManifest;
		const manifest = createDesktopRuntimeManifest(
			stagedResources,
			platform,
			commonManifest,
			targetManifest,
		);
		verifyDesktopRuntimeManifest(stagedResources, manifest, platform, {
			common: {
				artifactId: commonManifest.artifactId,
				digest: commonManifest.digest,
			},
			target: {
				artifactId: targetManifest.artifactId,
				digest: targetManifest.digest,
			},
		});
		replaceDirectoriesTransactionally([
			{
				source: stagedResources,
				destination: join(root, "src-tauri/resources"),
			},
			{ source: stagedDist, destination: join(root, "dist") },
		]);
	} catch (error) {
		rmSync(stagedResources, { recursive: true, force: true });
		rmSync(stagedDist, { recursive: true, force: true });
		throw error;
	}
}

if (import.meta.main) {
	const platform = argument("--platform") as DesktopPlatform | undefined;
	const common = argument("--runtime-common");
	const target = argument("--runtime-target");
	const contextPath = argument("--context");
	if (
		!platform ||
		!(platform in platformTargets) ||
		!common ||
		!target ||
		!contextPath
	) {
		fail(
			"--platform, --runtime-common, --runtime-target, and --context are required",
		);
	}
	const context = JSON.parse(
		readFileSync(contextPath, "utf8"),
	) as RuntimeSidecarContext;
	composeDesktopResources(common, target, platform, context);
	console.log(
		JSON.stringify({ code: "IDE_DESKTOP_RESOURCES_COMPOSED", platform }),
	);
}
