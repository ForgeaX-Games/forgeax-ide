import { describe, expect, test } from "vitest";
import {
	initialSessionCatalogModel,
	preferredCatalogModel,
} from "../src/integration/model-selection";

const catalog = [
	{ id: "hidden-default", hidden: true },
	{ id: "visible-default" },
	{ id: "remembered-model" },
];

describe("IDE Chat model selection integration", () => {
	test("preserves a visible remembered model and rejects absent or hidden memory", () => {
		expect(preferredCatalogModel(catalog, "remembered-model")).toBe(
			"remembered-model",
		);
		expect(preferredCatalogModel(catalog, "missing-model")).toBe(
			"visible-default",
		);
		expect(preferredCatalogModel(catalog, "hidden-default")).toBe(
			"visible-default",
		);
	});

	test("seeds CLI sessions but leaves the native scaffold default unchanged", () => {
		expect(
			initialSessionCatalogModel(catalog, "codex", "remembered-model"),
		).toBe("remembered-model");
		expect(initialSessionCatalogModel(catalog, "codex", null)).toBe(
			"visible-default",
		);
		expect(initialSessionCatalogModel(catalog, null, null)).toBeUndefined();
	});
});
