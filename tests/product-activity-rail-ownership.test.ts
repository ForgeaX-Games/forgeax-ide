import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("IDE selects its own activity rail over the App Shell activity registry", () => {
	const composition = readFileSync(
		new URL("../src/product/studio-composition.tsx", import.meta.url),
		"utf8",
	);
	expect(composition).toContain(
		'import { IdeActivityRail } from "./activity-rail"',
	);
	expect(composition).toContain("ActivityRail: IdeActivityRail");
	expect(composition).not.toContain("ApplicationActivityRail");
});
