import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import idePackage from "../../package.json";
import productManifest from "../../product/forgeax-product.json";

// Formal desktop assembly requires every product extension to be installed,
// including those that may be unavailable in an interactive development host.
// Resolve the actual npm package or exact-version source workspace, as assembly does.
test("ships the video-game release with a declared content iframe", () => {
	const id = "@forgeax-extension/game-video";
	const requireFromIde = createRequire(
		new URL("../../package.json", import.meta.url),
	);
	const packagePath = requireFromIde.resolve(`${id}/package.json`);
	const root = dirname(packagePath);
	const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
	const manifest = JSON.parse(
		readFileSync(resolve(root, "forgeax-extension.json"), "utf8"),
	);

	expect(productManifest.extensions).toContainEqual({ id, required: false });
	expect(pkg.name).toBe(id);
	expect(pkg.version).toBe(idePackage.optionalDependencies[id]);
	expect(manifest.id).toBe(id);
	expect(manifest.version).toBe(pkg.version);
	const panelTypes = new Map<
		string,
		{ id: string; runtime: string; entry: string }
	>(
		manifest.contributes.panelTypes.map((panel: { id: string }) => [
			panel.id,
			panel,
		]),
	);
	expect(panelTypes.get("game-video.content")).toEqual({
		id: "game-video.content",
		runtime: "iframe",
		entry: "./dist/index.html",
	});
	const references = manifest.contributes.pages.flatMap(
		(page: {
			panels: Array<{ panelType: { extension: string; id: string } }>;
		}) =>
			page.panels
				.filter(({ panelType }) => panelType.extension === "self")
				.map(({ panelType }) => panelType.id),
	);
	expect(references.length).toBeGreaterThan(0);
	for (const reference of references) {
		const panel = panelTypes.get(reference);
		expect(panel, `undeclared self panel: ${reference}`).toBeDefined();
		expect(
			existsSync(resolve(root, panel!.entry)),
			`missing panel entry: ${reference}`,
		).toBe(true);
	}
});

// npm host declarations resolve types from their installed package location;
// iframe workspaces must not change that location to React 18 development types.
test("keeps published host declarations on the IDE React type contract", () => {
	const requireFromIde = createRequire(
		new URL("../../package.json", import.meta.url),
	);
	const requireFromAgents = createRequire(
		requireFromIde.resolve("@forgeax/agents/package.json"),
	);
	const hostTypes = requireFromIde.resolve("@types/react/package.json");
	expect(requireFromAgents.resolve("@types/react/package.json")).toBe(
		hostTypes,
	);
	expect(JSON.parse(readFileSync(hostTypes, "utf8")).version).toBe(
		idePackage.devDependencies["@types/react"],
	);
});
