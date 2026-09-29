import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureWorkspaceEntries,
	missingWorkspaceEntries,
	workspaceTypeScriptBuildArgs,
} from "./workspace-build-entries";

test("existing JS with missing declared types rebuilds once and checks the result", () => {
	const root = mkdtempSync(join(tmpdir(), "Engine types 空格 "));
	try {
		mkdirSync(join(root, "dist"));
		writeFileSync(join(root, "dist/index.mjs"), "export {};");
		const manifest = {
			name: "@forgeax/engine-ecs",
			main: "./dist/index.mjs",
			types: "./dist/index.d.ts",
			exports: { ".": { types: "./dist/index.d.ts" } },
		};
		expect(missingWorkspaceEntries(root, manifest)).toEqual([
			"./dist/index.d.ts",
		]);
		expect(() => ensureWorkspaceEntries(root, manifest, () => {})).toThrow(
			"index.d.ts",
		);
		let builds = 0;
		const build = () => {
			builds++;
			writeFileSync(join(root, "dist/index.d.ts"), "export {};");
		};
		ensureWorkspaceEntries(root, manifest, build);
		ensureWorkspaceEntries(root, manifest, build);
		expect(builds).toBe(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("every runtime facade requires its corresponding wildcard declaration", () => {
	const root = mkdtempSync(join(tmpdir(), "engine-facades-"));
	try {
		mkdirSync(join(root, "dist/facades"), { recursive: true });
		for (const file of ["app.mjs", "app.d.ts", "render.mjs"])
			writeFileSync(join(root, "dist/facades", file), "export {};");
		const manifest = {
			exports: {
				"./*": {
					types: "./dist/facades/*.d.ts",
					import: "./dist/facades/*.mjs",
				},
			},
		};
		expect(missingWorkspaceEntries(root, manifest)).toEqual([
			"./dist/facades/render.d.ts",
		]);
		writeFileSync(join(root, "dist/facades/render.d.ts"), "export {};");
		expect(missingWorkspaceEntries(root, manifest)).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("declaration emit uses the workspace compiler across an unrelated consumer cwd", () => {
	const root = mkdtempSync(join(tmpdir(), "engine compiler spaces "));
	try {
		const engine = join(root, "engine");
		const consumer = join(root, "consumer");
		for (const location of [engine, consumer]) {
			const bin = join(location, "node_modules/typescript/bin");
			mkdirSync(bin, { recursive: true });
			writeFileSync(
				join(bin, "tsc"),
				location === engine
					? "process.stdout.write('engine:' + process.argv.slice(2).join(','))"
					: "throw new Error('wrong consumer compiler')",
			);
		}
		const result = spawnSync(
			process.execPath,
			workspaceTypeScriptBuildArgs(engine, [
				"-p",
				"tsconfig.json",
				"--emitDeclarationOnly",
			]),
			{
				cwd: consumer,
				encoding: "utf8",
			},
		);
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("engine:-p,tsconfig.json,--emitDeclarationOnly");
		expect(() =>
			workspaceTypeScriptBuildArgs(join(root, "missing"), []),
		).toThrow("compiler is missing");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
