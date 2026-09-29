import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	checkVersionFiles,
	deriveWixVersion,
	readVersionFiles,
	synchronizeVersionFiles,
} from "../../scripts/sync-release-version";

describe("IDE release version synchronization", () => {
	test("keeps the checked-in release files synchronized", () => {
		const root = join(import.meta.dirname, "../..");
		const version = JSON.parse(
			readFileSync(join(root, "package.json"), "utf8"),
		).version;
		expect(checkVersionFiles(root, version)).toEqual([]);
	});

	test("updates package, Tauri, Cargo manifest, and only the IDE Cargo.lock package", () => {
		const files = {
			packageJson: '{"name":"@forgeax/ide","version":"0.1.0"}\n',
			tauriConfig: '{"version":"0.1.0"}\n',
			cargoToml:
				'[package]\nname = "forgeax-ide-desktop"\nversion = "0.1.0"\n\n[dependencies]\n',
			cargoLock:
				'[[package]]\nname = "other"\nversion = "0.1.0"\n\n[[package]]\nname = "forgeax-ide-desktop"\nversion = "0.1.0"\n',
		};
		const updated = synchronizeVersionFiles(files, "1.2.3");
		expect(JSON.parse(updated.packageJson).version).toBe("1.2.3");
		expect(JSON.parse(updated.tauriConfig).version).toBe("1.2.3");
		expect(JSON.parse(updated.tauriConfig).bundle.windows.wix.version).toBe(
			"1.2.3",
		);
		expect(updated.cargoToml).toContain('version = "1.2.3"');
		expect(updated.cargoLock).toContain(
			'name = "forgeax-ide-desktop"\nversion = "1.2.3"',
		);
		expect(updated.cargoLock).toContain('name = "other"\nversion = "0.1.0"');
	});

	test("derives the MSI build number from the prerelease sequence", () => {
		expect(deriveWixVersion("0.3.31-alpha.1")).toBe("0.3.31.1");
		expect(deriveWixVersion("0.3.31-alpha.42")).toBe("0.3.31.42");
		expect(() => deriveWixVersion("0.3.31-alpha")).toThrow(
			"MSI-compatible numeric build",
		);
		expect(() => deriveWixVersion("0.3.31-alpha.65536")).toThrow(
			"MSI-compatible numeric build",
		);
	});

	test("checks all four on-disk versions and rejects ranges", () => {
		const root = mkdtempSync(join(tmpdir(), "ide-version-"));
		mkdirSync(join(root, "src-tauri"));
		const synced = synchronizeVersionFiles(
			{
				packageJson: '{"version":"0.1.0"}',
				tauriConfig: '{"version":"0.1.0"}',
				cargoToml: '[package]\nversion = "0.1.0"\n',
				cargoLock:
					'[[package]]\nname = "forgeax-ide-desktop"\nversion = "0.1.0"\n',
			},
			"2.0.0",
		);
		writeFileSync(join(root, "package.json"), synced.packageJson);
		writeFileSync(join(root, "src-tauri/tauri.conf.json"), synced.tauriConfig);
		writeFileSync(join(root, "src-tauri/Cargo.toml"), synced.cargoToml);
		writeFileSync(join(root, "src-tauri/Cargo.lock"), synced.cargoLock);
		expect(checkVersionFiles(root, "2.0.0")).toEqual([]);
		writeFileSync(
			join(root, "package.json"),
			readFileSync(join(root, "package.json"), "utf8").replace(
				"2.0.0",
				"2.0.1",
			),
		);
		expect(checkVersionFiles(root, "2.0.0")).toEqual(["packageJson"]);
		expect(() =>
			synchronizeVersionFiles(readVersionFiles(root), "^2.0.0"),
		).toThrow("invalid exact version");
		rmSync(root, { recursive: true, force: true });
	});
});
