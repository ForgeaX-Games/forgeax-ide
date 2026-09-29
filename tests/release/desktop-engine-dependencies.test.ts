import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	stageDesktopEngineDependencies,
	verifyDesktopEngineDependencies,
} from "../../scripts/desktop-engine-dependencies";
import { validateDesktopResources } from "../../scripts/validate-desktop-resources";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "desktop-engine-dependencies-"));
	roots.push(root);
	const resources = join(root, "src-tauri/resources");
	const template = join(resources, "editor/packages/engine/templates/game-3d");
	const source = join(resources, "engine/node_modules");
	const target = join(resources, "editor/packages/engine/node_modules");
	mkdirSync(template, { recursive: true });
	mkdirSync(join(source, "@forgeax/engine"), { recursive: true });
	mkdirSync(join(source, "dependency"), { recursive: true });
	writeFileSync(join(template, "forge.json"), "{}");
	writeFileSync(
		join(template, "package.json"),
		JSON.stringify({ dependencies: { "@forgeax/engine": "workspace:*" } }),
	);
	writeFileSync(
		join(source, "@forgeax/engine/package.json"),
		JSON.stringify({ name: "@forgeax/engine" }),
	);
	writeFileSync(join(source, "dependency/index.js"), "export const value = 1;");
	return { root, resources, source, target };
}

test("a Play-only dependency closure is rejected before packaging", () => {
	const f = fixture();
	expect(() => verifyDesktopEngineDependencies(f.resources)).toThrow();
});

test("assembly preserves the full closure including third-party dependencies and is idempotent", () => {
	const f = fixture();
	const required = stageDesktopEngineDependencies(f.resources);
	expect(required).toEqual([
		"editor/packages/engine/node_modules/@forgeax/engine/package.json",
	]);
	expect(readFileSync(join(f.target, "dependency/index.js"), "utf8")).toBe(
		"export const value = 1;",
	);
	expect(stageDesktopEngineDependencies(f.resources)).toEqual(required);
	expect(verifyDesktopEngineDependencies(f.resources)).toEqual(required);
});

test("missing and wrong-identity template dependencies are rejected", () => {
	const f = fixture();
	const manifest = join(f.source, "@forgeax/engine/package.json");
	writeFileSync(manifest, '{"name":"wrong"}');
	expect(() => stageDesktopEngineDependencies(f.resources)).toThrow(
		"identity mismatch",
	);
	rmSync(manifest);
	expect(() => stageDesktopEngineDependencies(f.resources)).toThrow();
});

test("a modified destination is rejected and never overwritten", () => {
	const f = fixture();
	stageDesktopEngineDependencies(f.resources);
	const file = join(f.target, "dependency/index.js");
	writeFileSync(file, "preserve me");
	expect(() => stageDesktopEngineDependencies(f.resources)).toThrow("differ");
	expect(readFileSync(file, "utf8")).toBe("preserve me");
});

test("stale extra files and source drift are rejected", () => {
	const f = fixture();
	stageDesktopEngineDependencies(f.resources);
	writeFileSync(join(f.target, "stale.js"), "stale");
	expect(() => verifyDesktopEngineDependencies(f.resources)).toThrow("differ");
	rmSync(join(f.target, "stale.js"));
	writeFileSync(join(f.source, "dependency/index.js"), "new source");
	expect(() => verifyDesktopEngineDependencies(f.resources)).toThrow("differ");
});

test("source symlinks cannot escape the staged resource closure", () => {
	const f = fixture();
	symlinkSync(f.root, join(f.source, "escape"), "dir");
	expect(() => stageDesktopEngineDependencies(f.resources)).toThrow(
		"self-contained",
	);
});

test("a dangling destination symlink is rejected rather than replaced", () => {
	const f = fixture();
	symlinkSync(join(f.root, "missing"), f.target, "dir");
	expect(() => stageDesktopEngineDependencies(f.resources)).toThrow();
});

test("the release resource validator reports a missing project dependency closure", () => {
	const f = fixture();
	writeFileSync(join(f.root, "src-tauri/tauri.conf.json"), "{}");
	mkdirSync(join(f.root, "src-tauri/src"));
	writeFileSync(join(f.root, "src-tauri/src/lib.rs"), "");
	expect(
		validateDesktopResources(f.root, "macos-arm64").map((error) => error.code),
	).toContain("engine-project-dependencies-invalid");
	stageDesktopEngineDependencies(f.resources);
	expect(
		validateDesktopResources(f.root, "macos-arm64").map((error) => error.code),
	).not.toContain("engine-project-dependencies-invalid");
});

test("assembly and final macOS verification invoke the same contract", () => {
	const scripts = join(import.meta.dir, "../../scripts");
	expect(
		readFileSync(join(scripts, "compose-desktop-resources.ts"), "utf8"),
	).toContain("stageDesktopEngineDependencies(stagedResources)");
	expect(
		readFileSync(join(scripts, "verify-macos-bundle.ts"), "utf8"),
	).toContain(
		'verifyDesktopEngineDependencies(join(app, "Contents/Resources/resources"))',
	);
});
