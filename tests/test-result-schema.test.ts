import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const schema = JSON.parse(
	readFileSync(
		join(import.meta.dirname, "../release/schemas/test-result.v1.schema.json"),
		"utf8",
	),
) as {
	required: string[];
	properties: {
		schema: { const: string };
		outcome: { properties: { status: { enum: string[] } } };
		product: { properties: { installer: { oneOf: unknown[] } } };
		execution: { required: string[] };
	};
	allOf: unknown[];
	$defs: Record<string, unknown>;
};

describe("test result evidence schema", () => {
	test("requires expected/actual cases, outcome, product identity and execution evidence", () => {
		expect(schema.properties.schema.const).toBe("forgeax-ide-test-result/v1");
		expect(schema.required).toEqual([
			"schema",
			"case",
			"outcome",
			"product",
			"environment",
			"execution",
			"evidence",
			"metrics",
		]);
		expect(schema.properties.outcome.properties.status.enum).toEqual([
			"pass",
			"fail",
			"skip",
		]);
		expect(schema.properties.product.properties.installer.oneOf).toHaveLength(
			2,
		);
		expect(schema.properties.execution.required).toContain("exitCode");
		expect(schema.allOf).toHaveLength(4);
	});

	test("uses only resolvable local definitions", () => {
		const references = JSON.stringify(schema).matchAll(
			/"\$ref":"#\/\$defs\/([^"/]+)"/g,
		);
		for (const [, name] of references)
			expect(schema.$defs[name ?? ""], `missing $defs/${name}`).toBeDefined();
	});
});
