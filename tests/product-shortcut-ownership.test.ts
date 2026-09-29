import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const source = (path: string) =>
	readFileSync(new URL(path, import.meta.url), "utf8");

test("IDE provides product shortcut definitions to both runtime and Settings", () => {
	expect(source("../src/integration/product-shortcuts.ts")).not.toContain(
		"@forgeax/interface/",
	);
	expect(source("../src/product/application-startup.ts")).toContain(
		"createIdeShellShortcutFactory(t)",
	);
	expect(source("../src/product/studio-composition.tsx")).not.toContain(
		"@forgeax/interface/lib/global-shortcuts",
	);
	expect(source("../src/product/studio-composition.tsx")).toContain(
		"buildIdeShortcutDescriptions(host)",
	);
	expect(source("../src/product/application-startup.ts")).toContain(
		"options.createShellShortcuts ?? createIdeShellShortcuts",
	);
	expect(source("../src/types/interface-integration.d.ts")).not.toContain(
		"declare module '@forgeax/interface/lib/global-shortcuts'",
	);
});
