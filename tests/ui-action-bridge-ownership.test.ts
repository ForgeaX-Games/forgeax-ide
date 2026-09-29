import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("IDE owns UI lease and query policy without another Interface leaf consumer", () => {
	const source = readFileSync(
		new URL("../src/product/ui-action-bridge.ts", import.meta.url),
		"utf8",
	);
	for (const policy of [
		"/ui-lease",
		"/ui-manifest",
		"/perception-reply",
		"ui_snapshot",
		"ui_invoke",
		"ui_screenshot",
	])
		expect(source).toContain(policy);
	expect(source).toContain("@forgeax/app-shell/application");
	expect(source).not.toContain("@forgeax/interface");
	const composition = readFileSync(
		new URL("../src/product/studio-composition.tsx", import.meta.url),
		"utf8",
	);
	expect(composition).not.toContain("@forgeax/interface/lib/ui-bridge");
	expect(composition).toContain("bootApplicationUiActionBridge");
	const entry = readFileSync(
		new URL("../src/main.tsx", import.meta.url),
		"utf8",
	);
	expect(entry).toContain(
		"configureApplicationUiActionBridge(bootIdeUiActionBridge)",
	);
	expect(
		entry.indexOf("configureApplicationUiActionBridge(bootIdeUiActionBridge)"),
	).toBeLessThan(entry.indexOf("await bootIdeProductComposition()"));
});
