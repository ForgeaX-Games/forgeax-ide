import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const desktopPackage = "forgeax-ide-desktop";

export function deriveWixVersion(version: string): string {
	if (!exactVersion.test(version))
		throw new Error(`invalid exact version: ${version}`);
	const [core, prerelease] = version.split("-", 2);
	const [major, minor, patch] = core.split(".").map(Number);
	if (major > 255 || minor > 255 || patch > 65_535) {
		throw new Error(`version exceeds MSI limits: ${version}`);
	}
	if (!prerelease) return core;
	const build = prerelease.split(".").at(-1);
	if (!build || !/^\d+$/.test(build) || Number(build) > 65_535) {
		throw new Error(
			`prerelease must end in an MSI-compatible numeric build: ${version}`,
		);
	}
	return `${core}.${Number(build)}`;
}

export type VersionFileState = {
	packageJson: string;
	tauriConfig: string;
	cargoToml: string;
	cargoLock: string;
};

export function synchronizeVersionFiles(
	files: VersionFileState,
	version: string,
): VersionFileState {
	if (!exactVersion.test(version))
		throw new Error(`invalid exact version: ${version}`);
	const packageJson = JSON.parse(files.packageJson) as Record<string, unknown>;
	const tauriConfig = JSON.parse(files.tauriConfig) as Record<string, unknown>;
	packageJson.version = version;
	tauriConfig.version = version;
	const bundle =
		typeof tauriConfig.bundle === "object" && tauriConfig.bundle !== null
			? (tauriConfig.bundle as Record<string, unknown>)
			: {};
	const windows =
		typeof bundle.windows === "object" && bundle.windows !== null
			? (bundle.windows as Record<string, unknown>)
			: {};
	const wix =
		typeof windows.wix === "object" && windows.wix !== null
			? (windows.wix as Record<string, unknown>)
			: {};
	tauriConfig.bundle = {
		...bundle,
		windows: {
			...windows,
			wix: { ...wix, version: deriveWixVersion(version) },
		},
	};

	const cargoTomlPattern =
		/(^\[package\][\s\S]*?^version\s*=\s*")[^"]+("\s*$)/m;
	if (!cargoTomlPattern.test(files.cargoToml))
		throw new Error("Cargo.toml package version is missing");
	const cargoToml = files.cargoToml.replace(cargoTomlPattern, `$1${version}$2`);

	const packageBlockPattern = new RegExp(
		`(\\[\\[package\\]\\]\\nname = "${desktopPackage}"\\nversion = ")[^"]+("[\\s\\S]*?)(?=\\n\\[\\[package\\]\\]|$)`,
	);
	const match = packageBlockPattern.exec(files.cargoLock);
	if (!match)
		throw new Error(`Cargo.lock package ${desktopPackage} is missing`);
	const cargoLock = files.cargoLock.replace(
		packageBlockPattern,
		`$1${version}$2`,
	);
	return {
		packageJson: `${JSON.stringify(packageJson, null, 2)}\n`,
		tauriConfig: `${JSON.stringify(tauriConfig, null, 2)}\n`,
		cargoToml,
		cargoLock,
	};
}

export function readVersionFiles(root: string): VersionFileState {
	return {
		packageJson: readFileSync(join(root, "package.json"), "utf8"),
		tauriConfig: readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"),
		cargoToml: readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8"),
		cargoLock: readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8"),
	};
}

function writeVersionFiles(root: string, files: VersionFileState): void {
	writeFileSync(join(root, "package.json"), files.packageJson);
	writeFileSync(join(root, "src-tauri/tauri.conf.json"), files.tauriConfig);
	writeFileSync(join(root, "src-tauri/Cargo.toml"), files.cargoToml);
	writeFileSync(join(root, "src-tauri/Cargo.lock"), files.cargoLock);
}

export function checkVersionFiles(root: string, version: string): string[] {
	if (!exactVersion.test(version))
		throw new Error(`invalid exact version: ${version}`);
	const current = readVersionFiles(root);
	const packageVersion = (
		JSON.parse(current.packageJson) as { version?: string }
	).version;
	const tauriConfig = JSON.parse(current.tauriConfig) as {
		version?: string;
		bundle?: { windows?: { wix?: { version?: string } } };
	};
	const tauriVersion = tauriConfig.version;
	const wixVersion = tauriConfig.bundle?.windows?.wix?.version;
	const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(current.cargoToml)?.[1];
	const lockPattern = new RegExp(
		`\\[\\[package\\]\\]\\nname = "${desktopPackage}"\\nversion = "([^"]+)"`,
	);
	const lockVersion = lockPattern.exec(current.cargoLock)?.[1];
	return [
		packageVersion === version ? undefined : "packageJson",
		tauriVersion === version ? undefined : "tauriConfig",
		wixVersion === deriveWixVersion(version) ? undefined : "tauriWixVersion",
		cargoVersion === version ? undefined : "cargoToml",
		lockVersion === version ? undefined : "cargoLock",
	].filter((value): value is string => value !== undefined);
}

if (import.meta.main) {
	const root = join(import.meta.dirname, "..");
	const versionIndex = Bun.argv.indexOf("--version");
	const version = versionIndex >= 0 ? Bun.argv[versionIndex + 1] : undefined;
	if (!version)
		throw new Error(
			"usage: sync-release-version --version X.Y.Z [--check|--write]",
		);
	if (Bun.argv.includes("--write")) {
		writeVersionFiles(
			root,
			synchronizeVersionFiles(readVersionFiles(root), version),
		);
		console.log(
			JSON.stringify({ code: "IDE_RELEASE_VERSION_SYNCED", version }),
		);
	} else {
		const mismatches = checkVersionFiles(root, version);
		if (mismatches.length) {
			console.error(
				JSON.stringify({
					code: "IDE_RELEASE_VERSION_MISMATCH",
					version,
					files: mismatches,
				}),
			);
			process.exit(1);
		}
		console.log(JSON.stringify({ code: "IDE_RELEASE_VERSION_VALID", version }));
	}
}
