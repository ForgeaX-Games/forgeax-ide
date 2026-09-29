import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("IDE consumes the shared dialog service without an Interface dialog import or type shim", () => {
	for (const path of [
		"src/product/chat-runtime-adapter.tsx",
		"src/product/studio-composition.tsx",
	]) {
		const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
		expect(source).not.toContain("@forgeax/interface/lib/dialog");
		expect(source).toMatch(
			/import\s*\{[^}]*alertDialog[^}]*\}\s*from\s*['"]@forgeax\/app-shell\/application['"]/,
		);
	}
	const types = readFileSync(
		new URL("../src/types/interface-integration.d.ts", import.meta.url),
		"utf8",
	);
	expect(types).not.toContain("declare module '@forgeax/interface/lib/dialog'");
});
