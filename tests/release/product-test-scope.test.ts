import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import idePackage from "../../package.json";
import { BUN_TEST_FILES } from "../../scripts/bun-test-files";

test("runs main Vitest and the explicit Bun suites without discovering product source tests", () => {
	expect(idePackage.scripts.test).toBe(
		"vitest run --project unit && bun run test:bun",
	);
	expect(idePackage.scripts["test:bun"]).toBe("bun scripts/bun-test-files.ts");
	const root = resolve(import.meta.dirname, "../..");
	const config = readFileSync(resolve(root, "vitest.config.ts"), "utf8");
	expect(config).toContain("exclude: [...BUN_TEST_FILES]");
	const actual = [...new Bun.Glob("tests/**/*.test.ts").scanSync({ cwd: root })]
		.filter((path) =>
			readFileSync(resolve(root, path), "utf8").includes("bun:test"),
		)
		.sort();
	expect(actual).toEqual([...BUN_TEST_FILES].sort());
	expect(
		BUN_TEST_FILES.every(
			(path) => path.startsWith("tests/") && !path.includes("product/sources"),
		),
	).toBe(true);
});
