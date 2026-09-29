import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyTemplateExternalDependencies } from "../scripts/desktop-template-dependencies";

const roots: string[] = [];
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "template-tools-"));
	roots.push(root);
	const templates = join(root, "templates");
	const modules = join(root, "node_modules");
	mkdirSync(join(templates, "game"), { recursive: true });
	mkdirSync(join(modules, "typescript"), { recursive: true });
	writeFileSync(join(templates, "game/forge.json"), "{}");
	writeFileSync(
		join(templates, "game/package.json"),
		JSON.stringify({ devDependencies: { typescript: "^6.0.0" } }),
	);
	const manifest = (version: string) =>
		writeFileSync(
			join(modules, "typescript/package.json"),
			JSON.stringify({ name: "typescript", version, bin: { tsc: "bin/tsc" } }),
		);
	return { templates, modules, manifest };
}
afterEach(() =>
	roots.splice(0).forEach((root) => {
		rmSync(root, { recursive: true, force: true });
	}),
);
test("rejects an otherwise identical closure with incompatible template tools", () => {
	const f = fixture();
	f.manifest("5.9.3");
	expect(() =>
		verifyTemplateExternalDependencies(f.templates, f.modules),
	).toThrow("requires ^6.0.0");
});
test("requires installed executables as well as the matching manifest", () => {
	const f = fixture();
	f.manifest("6.0.3");
	expect(() =>
		verifyTemplateExternalDependencies(f.templates, f.modules),
	).toThrow("missing executable");
	mkdirSync(join(f.modules, "typescript/bin"));
	writeFileSync(join(f.modules, "typescript/bin/tsc"), "");
	expect(verifyTemplateExternalDependencies(f.templates, f.modules)).toEqual([
		"typescript",
	]);
});

test("all template ranges must match the same shipped package", () => {
	const f = fixture();
	f.manifest("6.0.3");
	mkdirSync(join(f.modules, "typescript/bin"));
	writeFileSync(join(f.modules, "typescript/bin/tsc"), "");
	mkdirSync(join(f.templates, "other"));
	writeFileSync(join(f.templates, "other/forge.json"), "{}");
	writeFileSync(
		join(f.templates, "other/package.json"),
		JSON.stringify({ devDependencies: { typescript: "^5.9.0" } }),
	);
	expect(() =>
		verifyTemplateExternalDependencies(f.templates, f.modules),
	).toThrow("^5.9.0");
});

test("missing type entry is rejected even when package version matches", () => {
	const f = fixture();
	writeFileSync(
		join(f.modules, "typescript/package.json"),
		JSON.stringify({
			name: "typescript",
			version: "6.0.3",
			types: "index.d.ts",
		}),
	);
	expect(() =>
		verifyTemplateExternalDependencies(f.templates, f.modules),
	).toThrow("missing type entry");
});
