import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, test } from "vitest";
import { scripts } from "../package.json";

// These integration tests launch several nested CLI processes on shared CI runners.
const commandTimeoutMs = 15_000;
const testTimeoutMs = 50_000;

const desktopStages = ["prepare", "install", "build", "verify", "archive"];

function invoke(
	script: string,
	args: string[] = [],
	fail = "",
	nativePlatform = "linux-x64",
) {
	const root = mkdtempSync(join(tmpdir(), "ide-command-"));
	try {
		const log = join(root, "calls.jsonl");
		const steps = [
			"prepare:app-shell",
			"check:dependencies",
			"lint:types",
			"lint:biome",
			"typecheck",
			"test",
			"build:web",
			"check:release-sources",
			"diagnostics",
			"tauri",
			"build:desktop",
			"finalize:macos-bundle",
			...desktopStages,
		];
		const fixtures = Object.fromEntries(
			steps.map((step) => [step, `bun fixture.ts ${step}`]),
		);
		writeFileSync(
			join(root, "fixture.ts"),
			`
      import { appendFileSync } from 'node:fs';
      appendFileSync(process.env.COMMAND_LOG!, JSON.stringify(process.argv.slice(2)) + '\\n');
      if (process.argv[2] === 'cargo' && process.env.FORGEAX_BUILD_RUNTIME_GUARDIAN !== '1') process.exit(99);
      if (process.argv[2] === process.env.FAIL_STEP) process.exit(23);
    `,
		);
		mkdirSync(join(root, "scripts"));
		writeFileSync(
			join(root, "scripts/check-web.ts"),
			readFileSync(new URL("../scripts/check-web.ts", import.meta.url)),
		);
		if (script.startsWith("ci:desktop")) {
			for (const file of [
				"ci-desktop.ts",
				"build-source-sidecar.ts",
				"executable-identity.ts",
				"ci-integration-input.ts",
				"release-artifact-identity.ts",
				"artifact-manifest.ts",
				"native-product-receipt.ts",
				"local-build-source.ts",
			]) {
				writeFileSync(
					join(root, "scripts", file),
					readFileSync(new URL(`../scripts/${file}`, import.meta.url)),
				);
			}
			writeFileSync(
				join(root, "scripts/desktop-platforms.ts"),
				`export const platformTargets = { '${nativePlatform}': { os: process.platform, arch: process.arch, triple: '${nativePlatform === "macos-arm64" ? "aarch64-apple-darwin" : "x86_64-unknown-linux-gnu"}', extension: '' } };`,
			);
			mkdirSync(join(root, ".ci"));
			writeFileSync(join(root, ".ci/wasm-toolchain.sh"), "");
		}
		writeFileSync(
			join(root, "cargo"),
			'#!/usr/bin/env bun\nprocess.argv.splice(2, 0, "cargo"); await import("./fixture.ts");\n',
			{ mode: 0o755 },
		);
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				scripts: {
					...fixtures,
					...Object.fromEntries(
						desktopStages.map((stage) => [
							`ci:desktop:${stage}`,
							fixtures[stage],
						]),
					),
					[script]: (scripts as Record<string, string>)[script],
				},
			}),
		);
		const result = spawnSync("bun", ["run", script, ...args], {
			cwd: root,
			timeout: commandTimeoutMs,
			killSignal: "SIGKILL",
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${root}${delimiter}${process.env.PATH}`,
				COMMAND_LOG: log,
				FAIL_STEP: fail,
			},
		});
		if (result.error) throw result.error;
		let calls: string[][] = [];
		try {
			calls = readFileSync(log, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
		} catch {}
		return { status: result.status, calls, stderr: result.stderr };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test(
	"desktop public entry preserves Tauri target, release config and Cargo arguments",
	() => {
		const args = [
			"--config",
			"src-tauri/tauri.release.conf.json",
			"--target",
			"aarch64-apple-darwin",
			"--no-bundle",
			"--",
			"--timings",
		];
		const result = invoke("build:desktop", args);
		expect(result.status).toBe(0);
		expect(result.calls).toEqual([["tauri", "build", ...args]]);
		expect(invoke("build:desktop", [], "tauri").status).toBe(23);
	},
	testTimeoutMs,
);

test(
	"desktop development delegates flags and errors directly to Tauri",
	() => {
		const args = ["--no-watch", "--target", "x86_64-pc-windows-msvc"];
		const result = invoke("dev:desktop", args);
		expect(result.status).toBe(0);
		expect(result.calls).toEqual([
			["prepare:app-shell"],
			["tauri", "dev", "--config", "src-tauri/tauri.dev.conf.json", ...args],
		]);
		expect(invoke("dev:desktop", [], "tauri").status).toBe(23);
	},
	testTimeoutMs,
);

for (const nativePlatform of ["linux-x64", "macos-arm64"]) {
	test(
		`desktop CI forwards ${nativePlatform} to each public stage in a fresh process`,
		() => {
			for (const args of [[], [nativePlatform]]) {
				const result = invoke("ci:desktop", args, "", nativePlatform);
				expect(result.status, result.stderr).toBe(0);
				expect(result.calls).toEqual(
					desktopStages.map((stage) => [stage, nativePlatform]),
				);
			}
		},
		testTimeoutMs,
	);

	for (const [index, stage] of desktopStages.entries()) {
		test(
			`desktop CI on ${nativePlatform} preserves the ${stage} stage failure and never starts later stages`,
			() => {
				const result = invoke("ci:desktop", [], stage, nativePlatform);
				expect(result.status, result.stderr).toBe(23);
				expect(result.calls).toEqual(
					desktopStages
						.slice(0, index + 1)
						.map((step) => [step, nativePlatform]),
				);
			},
			testTimeoutMs,
		);
	}

	test(
		`desktop CI on ${nativePlatform} rejects invalid, cross-host and extra arguments before running stages`,
		() => {
			const foreignPlatform =
				nativePlatform === "linux-x64" ? "macos-arm64" : "linux-x64";
			for (const args of [
				["unknown"],
				[foreignPlatform],
				[nativePlatform, "extra"],
			]) {
				const result = invoke("ci:desktop", args, "", nativePlatform);
				expect(result.status).not.toBe(0);
				expect(result.calls).toEqual([]);
			}
		},
		testTimeoutMs,
	);
}

test.skipIf(process.platform === "win32")(
	"desktop CI retains the Mac app for finalization while producing its installer",
	() => {
		for (const [platform, triple, bundles] of [
			["linux-x64", "x86_64-unknown-linux-gnu", "deb"],
			["macos-arm64", "aarch64-apple-darwin", "app,dmg"],
		]) {
			const result = invoke("ci:desktop:build", [], "", platform);
			expect(result.status, result.stderr).toBe(0);
			expect(
				result.calls.filter((call) => call[0] === "build:desktop"),
			).toEqual([
				["build:desktop", "--ci", "--target", triple, "--bundles", bundles],
			]);
		}
	},
	testTimeoutMs,
);

const guardianCalls =
	process.platform === "win32"
		? []
		: [
				[
					"cargo",
					"build",
					"--manifest-path",
					"src-tauri/Cargo.toml",
					"--bin",
					"runtime-guardian",
				],
			];

test(
	"Web gate prepares its test runtime, lints once and runs every product check in order",
	() => {
		const result = invoke("check:web");
		expect(result.status).toBe(0);
		expect(result.calls).toEqual([
			...guardianCalls,
			["prepare:app-shell"],
			["check:dependencies"],
			["lint:types"],
			["lint:biome"],
			["test"],
			["build:web"],
			["check:release-sources"],
			["diagnostics", "--json"],
		]);
	},
	testTimeoutMs,
);

test(
	"Web gate stops on failure instead of building or reporting later checks",
	() => {
		const result = invoke("check:web", [], "test");
		expect(result.status).toBe(23);
		expect(result.calls).toEqual([
			...guardianCalls,
			["prepare:app-shell"],
			["check:dependencies"],
			["lint:types"],
			["lint:biome"],
			["test"],
		]);
	},
	testTimeoutMs,
);

test(
	"Web gate rejects Biome errors before running tests or building",
	() => {
		const result = invoke("check:web", [], "lint:biome");
		expect(result.status).toBe(23);
		expect(result.calls).toEqual([
			...guardianCalls,
			["prepare:app-shell"],
			["check:dependencies"],
			["lint:types"],
			["lint:biome"],
		]);
	},
	testTimeoutMs,
);

test.skipIf(process.platform === "win32")(
	"Web gate stops before checks if guardian compilation fails",
	() => {
		const result = invoke("check:web", [], "cargo");
		expect(result.status).toBe(23);
		expect(result.calls).toEqual(guardianCalls);
	},
	testTimeoutMs,
);

test(
	"Web gate stops before dependency validation if AppShell preparation fails",
	() => {
		const result = invoke("check:web", [], "prepare:app-shell");
		expect(result.status).toBe(23);
		expect(result.calls).toEqual([...guardianCalls, ["prepare:app-shell"]]);
	},
	testTimeoutMs,
);
