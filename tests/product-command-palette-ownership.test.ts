import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("IDE shortcut and view use one product command palette store", () => {
	const main = readFileSync(
		new URL("../src/main.tsx", import.meta.url),
		"utf8",
	);
	const composition = readFileSync(
		new URL("../src/product/studio-composition.tsx", import.meta.url),
		"utf8",
	);
	expect(main).toContain(
		'import { toggleIdeCommandPalette } from "./product/command-palette-store"',
	);
	expect(main).toContain("toggleCommandPalette: toggleIdeCommandPalette");
	expect(composition).toContain(
		'import { IdeCommandPalette } from "./command-palette"',
	);
	expect(composition).toContain("CommandPalette: IdeCommandPalette");
	expect(composition).not.toContain("ApplicationCommandPalette");
});
