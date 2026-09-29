import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import {
	DESKTOP_SOURCE_CONTEXT_PATH,
	type SourceSidecarContext,
} from "../scripts/build-source-sidecar";
import { archiveDesktopCi, desktopCiTarget } from "../scripts/ci-desktop";

const target = desktopCiTarget("linux", "x64");
const context: SourceSidecarContext = {
	schema: "forgeax-server-source-build/v1",
	serviceVersion: "1.2.3",
	platform: "linux-x64",
	targetTriple: target.triple,
	sourceRevisions: { studio: "a".repeat(40), server: "b".repeat(40) },
	bunVersion: execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(),
	dependencyLockSha256: "c".repeat(64),
	sha256: "d".repeat(64),
	size: 1_048_576,
};

function hookFixture() {
	const root = mkdtempSync(join(tmpdir(), "ide-hook-archive-"));
	const ide = join(root, "packages/ide");
	const write = (path: string, contents: string) => {
		const file = join(root, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, contents);
	};
	// Execute the real hook and its cleanup, replacing only expensive builders.
	write(
		"packages/ide/package.json",
		JSON.stringify({ scripts: { "build:web": "bun noop.ts" } }),
	);
	write("packages/ide/noop.ts", "");
	write("packages/editor/package.json", '{"name":"fixture-editor"}');
	for (const name of ["fbx", "codec"]) {
		write(
			`packages/editor/packages/engine/packages/${name}/package.json`,
			JSON.stringify({ scripts: { "fetch-wasm": "bun noop.ts" } }),
		);
		write(
			`packages/editor/packages/engine/packages/${name}/noop.ts`,
			`console.log("fixture fetch ${name}");`,
		);
	}
	const stubs: Record<string, string> = {
		"install-desktop-source-workspace.ts": "",
		"desktop-platforms.ts": `export const platformTargets = { 'linux-x64': { os: process.platform, arch: process.arch, triple: ${JSON.stringify(target.triple)} } };`,
		"build-source-sidecar.ts": `
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      export const DESKTOP_SOURCE_CONTEXT_PATH = ${JSON.stringify(DESKTOP_SOURCE_CONTEXT_PATH)};
      export async function buildSourceSidecar(output) {
        mkdirSync(output, { recursive: true });
        const context = ${JSON.stringify(context)};
        writeFileSync(join(output, 'source-context.json'), JSON.stringify(context));
        return context;
      }
    `,
		"engine-runtime-artifacts.ts":
			"export function createEngineCommonArtifacts() {} export function createEngineTargetArtifact() {}",
		"web-runtime-artifact.ts":
			"export function createWebArtifactFromDirectory() {}",
		"runtime-artifacts.ts":
			"export function createRuntimeCommonArtifact() {} export function createRuntimeTargetArtifact() {}",
		"compose-desktop-resources.ts":
			"export function composeDesktopResources() {}",
		"validate-desktop-resources.ts":
			'export function validateDesktopResources() { return process.env.FAIL_RESOURCE_VALIDATION ? ["fixture resource failure"] : []; }',
		"local-build-source.ts":
			'export function localBuildSource() { return { revision: "fixture" }; }',
		"native-product-receipt.ts":
			'export const DESKTOP_BUILD_SOURCE_PATH = "release-work/desktop-build-source.json";',
	};
	for (const [file, source] of Object.entries(stubs))
		write(`packages/ide/scripts/${file}`, source);
	copyFileSync(
		join(import.meta.dirname, "../scripts/prepare-desktop.ts"),
		join(ide, "scripts/prepare-desktop.ts"),
	);
	const installer = "ForgeaX Studio_1.2.3_amd64.deb";
	write(
		`packages/ide/src-tauri/target/${target.triple}/release/bundle/deb/${installer}`,
		"installer fixture",
	);
	const manifest = JSON.stringify({ sourceRevisions: context.sourceRevisions });
	write(
		"packages/ide/src-tauri/resources/runtime/desktop-runtime-manifest.json",
		manifest,
	);
	return {
		root,
		ide,
		manifest,
		run(fail = false, overrides: NodeJS.ProcessEnv = {}) {
			const env: NodeJS.ProcessEnv = {
				...process.env,
				FORGEAX_CI_CACHE_PROFILE: "",
				FAIL_RESOURCE_VALIDATION: fail ? "1" : "",
				...overrides,
			};
			delete env.TAURI_ENV_TARGET_TRIPLE;
			return spawnSync("bun", ["scripts/prepare-desktop.ts"], {
				cwd: ide,
				encoding: "utf8",
				env,
			});
		},
	};
}

test("desktop skips importer downloads only after the cache validator succeeds", () => {
	const fixture = hookFixture();
	try {
		mkdirSync(join(fixture.ide, ".ci"), { recursive: true });
		// The Python suite tests the real validator's source and payload checks;
		// exercise the hook's subprocess boundary for both outcomes here.
		writeFileSync(
			join(fixture.ide, ".ci/cache.py"),
			'import os, sys\nassert sys.argv[1:] == ["ready", "wasm", "--profile", "desktop"]\nsys.exit(0 if os.environ.get("CACHE_FIXTURE_READY") == "1" else 1)\n',
		);
		for (const ready of ["0", "1"]) {
			const result = fixture.run(false, {
				FORGEAX_CI_CACHE_PROFILE: "desktop",
				CACHE_FIXTURE_READY: ready,
			});
			expect(result.status, result.stderr).toBe(0);
			for (const name of ["fbx", "codec"]) {
				if (ready === "1") {
					expect(result.stdout).toContain(
						`reusing verified ${name} WASM cache`,
					);
					expect(result.stdout).not.toContain(`fixture fetch ${name}`);
				} else {
					expect(result.stdout).toContain(`fixture fetch ${name}`);
				}
			}
		}
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
}, 10_000);

test("CI archives the source receipt produced by the hook after temporary resources are removed", () => {
	const fixture = hookFixture();
	try {
		const result = fixture.run();
		expect(result.stderr).not.toContain("error:");
		expect(result.status).toBe(0);
		expect(readdirSync(join(fixture.ide, "release-work")).sort()).toEqual([
			"desktop-build-source.json",
			"desktop-source-context.json",
		]);
		expect(
			JSON.parse(
				readFileSync(join(fixture.ide, DESKTOP_SOURCE_CONTEXT_PATH), "utf8"),
			),
		).toEqual(context);
		const output = join(fixture.ide, "blueking-artifacts", target.platform);
		mkdirSync(output, { recursive: true });
		writeFileSync(join(output, "stale.deb"), "previous build");
		archiveDesktopCi(
			fixture.ide,
			target,
			JSON.parse(
				readFileSync(
					join(fixture.ide, "release-work/desktop-build-source.json"),
					"utf8",
				),
			),
		);
		const installer = "ForgeaX-Studio_1.2.3_amd64.deb";
		expect(readdirSync(output).sort()).toEqual(
			[
				installer,
				"SHA256SUMS",
				"desktop-runtime-manifest.json",
				"source-context.json",
			].sort(),
		);
		expect(readFileSync(join(output, installer), "utf8")).toBe(
			"installer fixture",
		);
		expect(
			readFileSync(join(output, "desktop-runtime-manifest.json"), "utf8"),
		).toBe(fixture.manifest);
		expect(
			JSON.parse(readFileSync(join(output, "source-context.json"), "utf8")),
		).toEqual(context);
		const hashes = [
			installer,
			"desktop-runtime-manifest.json",
			"source-context.json",
		].map(
			(file) =>
				`${createHash("sha256")
					.update(readFileSync(join(output, file)))
					.digest("hex")}  ${file}`,
		);
		expect(readFileSync(join(output, "SHA256SUMS"), "utf8")).toBe(
			`${hashes.join("\n")}\n`,
		);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
}, 10_000);

test("a failed hook removes an earlier receipt and cannot archive it as a successful build", () => {
	const fixture = hookFixture();
	try {
		const receipt = join(fixture.ide, DESKTOP_SOURCE_CONTEXT_PATH);
		const buildSource = join(
			fixture.ide,
			"release-work/desktop-build-source.json",
		);
		mkdirSync(dirname(receipt), { recursive: true });
		writeFileSync(receipt, JSON.stringify(context));
		writeFileSync(buildSource, JSON.stringify({ revision: "stale" }));
		const result = fixture.run(true);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("fixture resource failure");
		expect(existsSync(receipt)).toBe(false);
		expect(existsSync(buildSource)).toBe(false);
		expect(readdirSync(join(fixture.ide, "release-work"))).toEqual([]);
		expect(() =>
			archiveDesktopCi(fixture.ide, target, { revision: "fixture" }),
		).toThrow("ENOENT");
		expect(
			existsSync(
				join(fixture.ide, "blueking-artifacts", target.platform, "SHA256SUMS"),
			),
		).toBe(false);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
}, 10_000);

test("archive refuses a source snapshot that changed after desktop preparation", () => {
	const fixture = hookFixture();
	try {
		expect(fixture.run().status).toBe(0);
		expect(() =>
			archiveDesktopCi(fixture.ide, target, { revision: "changed" }),
		).toThrow("source changed after desktop preparation");
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
}, 10_000);

test("Mac DMG and metadata have distinct artifact names and matching hashes", () => {
	const root = mkdtempSync(join(tmpdir(), "ide-mac-archive-"));
	const mac = desktopCiTarget("darwin", "arm64");
	const source = { revision: "fixture" };
	const write = (name: string, contents: string) => {
		const path = join(root, name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, contents);
	};
	try {
		write("release-work/desktop-build-source.json", JSON.stringify(source));
		write(
			DESKTOP_SOURCE_CONTEXT_PATH,
			JSON.stringify({
				...context,
				platform: mac.platform,
				targetTriple: mac.triple,
			}),
		);
		write(
			"src-tauri/resources/runtime/desktop-runtime-manifest.json",
			'{"platform":"macos-arm64"}',
		);
		const bundle = `src-tauri/target/${mac.triple}/release/bundle/dmg/`;
		write(`${bundle}ForgeaX Studio_1.2.3_aarch64.dmg`, "dmg fixture");
		archiveDesktopCi(root, mac, source);
		const output = join(root, "blueking-artifacts/macos-arm64");
		const names = readdirSync(output).sort();
		expect(names).toEqual([
			"ForgeaX-Studio_1.2.3_aarch64.dmg",
			"macos-arm64-SHA256SUMS",
			"macos-arm64-desktop-runtime-manifest.json",
			"macos-arm64-source-context.json",
		]);
		const hashes = readFileSync(join(output, "macos-arm64-SHA256SUMS"), "utf8")
			.trim()
			.split("\n");
		expect(hashes).toHaveLength(3);
		for (const line of hashes) {
			const [hash, file = ""] = line.split("  ");
			expect(hash).toBe(
				createHash("sha256")
					.update(readFileSync(join(output, file)))
					.digest("hex"),
			);
		}
		write(`${bundle}stale.dmg`, "old dmg");
		expect(() => archiveDesktopCi(root, mac, source)).toThrow(
			"exactly one dmg",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
