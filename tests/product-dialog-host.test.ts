import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("IDE mounts its own renderer for the App Shell dialog queue", () => {
	const composition = readFileSync(
		new URL("../src/product/studio-composition.tsx", import.meta.url),
		"utf8",
	);
	expect(composition).toContain(
		'import { IdeDialogHost } from "./dialog-host"',
	);
	expect(composition).toContain("DialogHost: IdeDialogHost");
	expect(composition).not.toContain("ApplicationDialogHost");
});
