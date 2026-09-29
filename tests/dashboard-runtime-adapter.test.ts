import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

describe("Dashboard product composition", () => {
	test("injects the Dashboard runtime instead of registering the app directly", () => {
		const source = readFileSync(
			resolve(import.meta.dirname, "../src/product/studio-composition.tsx"),
			"utf8",
		);

		expect(source).toContain("type DashboardRuntime");
		expect(source).toContain("function DashboardInjection()");
		expect(source).toContain("<Dashboard runtime={runtime} />");
		expect(source).toContain("Dashboard: DashboardInjection");
	});
});
