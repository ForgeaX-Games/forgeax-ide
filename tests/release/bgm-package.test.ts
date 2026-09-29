import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import idePackage from "../../package.json";

// BGM 0.6.3 predates the Host adapter repair. Verify the installed backend
// so version equality alone cannot pass this gate.
test("ships the selected BGM package with every declared Host tool", async () => {
	const id = "@forgeax-extension/bgm";
	const _ideRoot = resolve(import.meta.dir, "../..");
	const requireFromIde = createRequire(
		new URL("../../package.json", import.meta.url),
	);
	const root = dirname(requireFromIde.resolve(`${id}/package.json`));
	const manifest = JSON.parse(
		readFileSync(resolve(root, "forgeax-extension.json"), "utf8"),
	);
	expect(manifest.version).toBe(idePackage.optionalDependencies[id]);
	const backend = await import(
		pathToFileURL(resolve(root, manifest.entry.backend)).href
	);
	expect(manifest.contributes.tools.length).toBeGreaterThan(0);
	for (const tool of manifest.contributes.tools) {
		expect(
			typeof backend.default.tools[tool.id],
			`missing BGM Host handler: ${tool.id}`,
		).toBe("function");
	}
});
