import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("IDE owns the project-directory modal while sharing product state and client", () => {
	const composition = readFileSync(
		new URL("../src/product/studio-composition.tsx", import.meta.url),
		"utf8",
	);
	const modal = readFileSync(
		new URL("../src/product/project-directory-modal.tsx", import.meta.url),
		"utf8",
	);
	expect(composition).toContain(
		'import { IdeProjectDirectoryModalHost } from "./project-directory-modal"',
	);
	expect(composition).toContain(
		"GameDirectoryModalHost: IdeProjectDirectoryModalHost",
	);
	expect(composition).not.toContain("ApplicationProjectModalHost");
	expect(modal).toContain("useShellStore");
	expect(modal).toContain("studioDomainClientRuntime.read()");
});
