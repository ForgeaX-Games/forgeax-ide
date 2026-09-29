import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checkInstalledOptionalDependencies } from "../scripts/check-direct-dependencies";

test("detects a stale installed optional release without requiring absent optional packages", () => {
	const root = mkdtempSync(join(tmpdir(), "ide-optional-dependencies-"));
	try {
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				optionalDependencies: {
					"@fixture/extension": "0.6.4",
					"@fixture/absent": "1.0.0",
				},
			}),
		);
		const dependency = join(root, "node_modules/@fixture/extension");
		mkdirSync(dependency, { recursive: true });
		const metadata = join(dependency, "package.json");
		writeFileSync(
			metadata,
			JSON.stringify({ name: "@fixture/extension", version: "0.6.0" }),
		);
		expect(checkInstalledOptionalDependencies(root)).toEqual([
			"@fixture/extension: expected 0.6.4, installed @fixture/extension@0.6.0",
		]);
		writeFileSync(
			metadata,
			JSON.stringify({ name: "@fixture/extension", version: "0.6.4" }),
		);
		expect(checkInstalledOptionalDependencies(root)).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
