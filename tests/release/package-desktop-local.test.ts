import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	localPackagePlan,
	runLocalPackageSteps,
} from "../../scripts/package-desktop-local";

test("local packaging builds current source before assembly and verifies final bundle", () => {
	const plan = localPackagePlan(
		"/studio",
		"/studio/packages/ide",
		"aarch64-apple-darwin",
		"macos-arm64",
		"/out/bundle",
	);
	expect(plan.map((x) => x.name)).toEqual([
		"prepare",
		"resources",
		"tauri",
		"finalize",
		"verify",
	]);
	expect(plan.find((x) => x.name === "prepare")!.args).toEqual([
		"run",
		"prepare:desktop",
	]);
	expect(plan.find((x) => x.name === "tauri")!.args).toContain("--bundles");
	expect(plan.find((x) => x.name === "tauri")!.args).toContain(
		'{"build":{"beforeBuildCommand":null}}',
	);
	expect(plan.find((x) => x.name === "verify")!.args).toContain(
		"/out/bundle/macos/ForgeaX Studio.app",
	);
	expect(plan.flatMap((x) => x.args).join(" ")).not.toContain(
		"stage:release-sidecar",
	);
});

test("a failed real stage retains both output streams and prevents later stages", () => {
	const output = mkdtempSync(join(tmpdir(), "local-package-stage-test-"));
	try {
		const steps = [
			{
				name: "first",
				cwd: output,
				args: [
					"-e",
					'console.log("before failure"); console.error("diagnostic"); process.exit(7)',
				],
			},
			{
				name: "must-not-run",
				cwd: output,
				args: ["-e", 'throw new Error("must not run")'],
			},
		];
		expect(() =>
			runLocalPackageSteps(steps, output, process.env, {
				candidate: "fixture",
			}),
		).toThrow("first failed");
		expect(readFileSync(join(output, "first.log"), "utf8")).toContain(
			"before failure",
		);
		expect(readFileSync(join(output, "first.log"), "utf8")).toContain(
			"diagnostic",
		);
		const receipt = JSON.parse(
			readFileSync(join(output, "steps.json"), "utf8"),
		);
		expect(receipt.candidate).toBe("fixture");
		expect(receipt.results).toHaveLength(1);
		expect(receipt.results[0].status).toBe(7);
		expect(existsSync(join(output, "must-not-run.log"))).toBe(false);
	} finally {
		rmSync(output, { recursive: true, force: true });
	}
});

test("compiled server resolves a dynamic extension dependency through package metadata", () => {
	const root = mkdtempSync(join(tmpdir(), "desktop-external-package-"));
	try {
		const entry = join(root, "server.ts");
		const executable = join(
			root,
			process.platform === "win32" ? "server.exe" : "server",
		);
		writeFileSync(entry, "await import(process.argv[2]); process.exit(0);");
		// The current source-sidecar builder owns these compiler options.
		const builder = readFileSync(
			join(import.meta.dir, "../../scripts/build-source-sidecar.ts"),
			"utf8",
		);
		expect(builder).toContain("autoloadPackageJson: true");
		const args = [
			"build",
			"--compile",
			"--compile-autoload-package-json",
			entry,
			"--outfile",
			executable,
		];
		const compiled = spawnSync(process.execPath, args, {
			cwd: root,
			encoding: "utf8",
		});
		if (compiled.status !== 0) throw new Error(compiled.stderr);
		// Create resources only after compilation, so the executable cannot bundle them.
		const dependency = join(root, "product/node_modules/fixture-dependency");
		mkdirSync(join(dependency, "lib"), { recursive: true });
		writeFileSync(
			join(dependency, "package.json"),
			JSON.stringify({ name: "fixture-dependency", main: "./lib/entry.js" }),
		);
		writeFileSync(
			join(dependency, "lib/entry.js"),
			'module.exports = "external-dependency-loaded";',
		);
		const extension = join(root, "product/extension.mjs");
		writeFileSync(
			extension,
			"import value from 'fixture-dependency'; console.log(value);",
		);
		const result = spawnSync(executable, [extension], {
			cwd: root,
			encoding: "utf8",
			timeout: 10000,
		});
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("external-dependency-loaded");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
