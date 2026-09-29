import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { assertSourceIntegration } from "../../scripts/build-source-sidecar";
import { localRepositorySource } from "../../scripts/local-build-source";
import { desktopBuildPlatform } from "../../scripts/prepare-desktop";

test("desktop resources match the requested native Tauri target", () => {
	expect(desktopBuildPlatform("darwin", "arm64", "aarch64-apple-darwin")).toBe(
		"macos-arm64",
	);
	expect(desktopBuildPlatform("win32", "x64", "x86_64-pc-windows-msvc")).toBe(
		"windows-x64",
	);
	expect(() =>
		desktopBuildPlatform("darwin", "arm64", "x86_64-apple-darwin"),
	).toThrow("native build");
	expect(() =>
		desktopBuildPlatform("darwin", "arm64", "universal-apple-darwin"),
	).toThrow("native build");
	expect(() => desktopBuildPlatform("linux", "arm64", "")).toThrow(
		"unsupported desktop build host",
	);
});

test("local source receipt distinguishes committed, edited and untracked source", () => {
	const root = mkdtempSync(join(tmpdir(), "ide-source-receipt-"));
	const git = (...args: string[]) => {
		const result = spawnSync(
			"git",
			["-c", "core.hooksPath=/dev/null", ...args],
			{ cwd: root, encoding: "utf8" },
		);
		if (result.status !== 0) throw new Error(result.stderr);
	};
	try {
		git("init", "-q");
		writeFileSync(join(root, "entry.ts"), "export const value = 1;\n");
		git("add", "entry.ts");
		git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-qm",
			"fixture",
		);
		const clean = localRepositorySource(root);
		expect(clean.dirty).toBe(false);
		writeFileSync(join(root, "entry.ts"), "export const value = 2;\n");
		writeFileSync(join(root, "new.ts"), "export const other = true;\n");
		mkdirSync(join(root, "node_modules"));
		writeFileSync(join(root, "node_modules/ignored.js"), "dependency");
		const dirty = localRepositorySource(root);
		expect(dirty.revision).toBe(clean.revision);
		expect(dirty.dirty).toBe(true);
		expect(dirty.diffSha256).not.toBe(clean.diffSha256);
		expect(dirty.untracked.map(({ path }) => path)).toEqual(["new.ts"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("local source receipt excludes only declared Tauri product outputs", () => {
	const root = mkdtempSync(join(tmpdir(), "ide-generated-source-"));
	const git = (...args: string[]) => {
		const result = spawnSync(
			"git",
			["-c", "core.hooksPath=/dev/null", ...args],
			{ cwd: root, encoding: "utf8" },
		);
		if (result.status !== 0) throw new Error(result.stderr);
	};
	try {
		mkdirSync(join(root, "src-tauri/resources"), { recursive: true });
		writeFileSync(join(root, "src-tauri/resources/sidecar"), "placeholder");
		writeFileSync(join(root, "entry.ts"), "export const value = 1;\n");
		git("init", "-q");
		git("add", ".");
		git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-qm",
			"fixture",
		);
		writeFileSync(
			join(root, "src-tauri/resources/sidecar"),
			"generated replacement",
		);
		expect(localRepositorySource(root, ["src-tauri/resources"]).dirty).toBe(
			false,
		);
		writeFileSync(join(root, "entry.ts"), "export const value = 2;\n");
		expect(localRepositorySource(root, ["src-tauri/resources"]).dirty).toBe(
			true,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("desktop installation rejects a different Studio revision before changing dependencies", () => {
	const root = mkdtempSync(join(tmpdir(), "ide-pinned-source-"));
	const git = (...args: string[]) => {
		const result = spawnSync(
			"git",
			["-c", "core.hooksPath=/dev/null", ...args],
			{ cwd: root, encoding: "utf8" },
		);
		if (result.status !== 0) throw new Error(result.stderr);
		return result.stdout.trim();
	};
	try {
		git("init", "-q");
		writeFileSync(join(root, "package.json"), '{"name":"fixture"}');
		git("add", "package.json");
		git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-qm",
			"fixture",
		);
		const revision = git("rev-parse", "HEAD");
		const product = join(root, "packages/ide/product");
		mkdirSync(product, { recursive: true });
		const input = join(product, "integration-inputs.json");
		writeFileSync(
			input,
			JSON.stringify({
				studio: { repository: "ForgeaX-Games/forgeax-studio", revision },
			}),
		);
		expect(() => assertSourceIntegration(root)).not.toThrow();
		writeFileSync(
			input,
			JSON.stringify({
				studio: {
					repository: "ForgeaX-Games/forgeax-studio",
					revision: "a".repeat(40),
				},
			}),
		);
		expect(() => assertSourceIntegration(root)).toThrow(
			`current checkout is ${revision}`,
		);
		expect(() => assertSourceIntegration(root)).toThrow(
			"before installing desktop dependencies",
		);
		const scripts = join(root, "packages/ide/scripts");
		mkdirSync(scripts, { recursive: true });
		for (const file of [
			"install-desktop-source-workspace.ts",
			"complete-source-workspace.ts",
			"registry-independent-lock.ts",
			"build-source-sidecar.ts",
			"release-artifact-identity.ts",
			"artifact-manifest.ts",
			"desktop-platforms.ts",
			"executable-identity.ts",
		]) {
			copyFileSync(
				join(import.meta.dirname, "../../scripts", file),
				join(scripts, file),
			);
		}
		mkdirSync(join(root, "packages/ide/.ci"));
		copyFileSync(
			join(import.meta.dirname, "../../.ci/desktop-build-inputs.json"),
			join(root, "packages/ide/.ci/desktop-build-inputs.json"),
		);
		const result = spawnSync(
			"bun",
			[join(scripts, "install-desktop-source-workspace.ts")],
			{ cwd: root, encoding: "utf8" },
		);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("before installing desktop dependencies");
		expect(readFileSync(join(root, "package.json"), "utf8")).toBe(
			'{"name":"fixture"}',
		);
		expect(existsSync(join(root, "bun.lock"))).toBe(false);
		expect(existsSync(join(root, "node_modules"))).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
