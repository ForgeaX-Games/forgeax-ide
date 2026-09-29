import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { materializeEngineWorkspace } from "../../scripts/desktop-engine-workspace";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "desktop workspace "));
	roots.push(root);
	const projects = join(root, "projects");
	const resources = join(root, "App Resources");
	for (const [file, content] of Object.entries({
		"vite.config.mjs": "export default {}",
		"package.json": "{}",
		"src/main.ts": "version A",
		"node_modules/vite/bin/vite.js": "// vite",
	})) {
		const path = join(resources, "engine", file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	for (const dir of ["forgeax-editor-assets", "forgeax-engine-assets"])
		mkdirSync(join(resources, "engine", dir));
	mkdirSync(join(projects, ".engine-runtime"), { recursive: true });
	writeFileSync(
		join(projects, ".engine-runtime", "sentinel"),
		"old running app",
	);
	return { projects, resources };
}

test("two launches isolate sources and cleanup from each other and from legacy running apps", () => {
	const { projects, resources } = fixture();
	const first = materializeEngineWorkspace(resources, projects);
	writeFileSync(join(resources, "engine/src/main.ts"), "version B");
	const second = materializeEngineWorkspace(resources, projects);
	expect(second).not.toBe(first);
	expect(readFileSync(join(first, "src/main.ts"), "utf8")).toBe("version A");
	expect(readFileSync(join(second, "src/main.ts"), "utf8")).toBe("version B");
	expect(readFileSync(join(projects, ".engine-runtime/sentinel"), "utf8")).toBe(
		"old running app",
	);
	rmSync(second, { recursive: true, force: true });
	expect(readFileSync(join(first, "src/main.ts"), "utf8")).toBe("version A");
});

test("a launch missing its Vite input fails before touching another runtime", () => {
	const { projects, resources } = fixture();
	const first = materializeEngineWorkspace(resources, projects);
	rmSync(join(resources, "engine/node_modules/vite/bin/vite.js"));
	expect(() => materializeEngineWorkspace(resources, projects)).toThrow(
		"packaged engine resource is missing",
	);
	expect(readFileSync(join(first, "src/main.ts"), "utf8")).toBe("version A");
	expect(readdirSync(join(projects, ".forgeax/runtime"))).toHaveLength(1);
});
