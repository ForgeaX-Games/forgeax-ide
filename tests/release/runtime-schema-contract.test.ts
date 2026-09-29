import { describe, expect, test } from "vitest";
import desktopSchema from "../../release/desktop-runtime-manifest.v2.schema.json";
import schema from "../../release/runtime-artifact-manifest.v1.schema.json";

describe("versioned runtime manifest schemas", () => {
	test("publishes a recursively closed manifest shape contract", () => {
		expect(schema.$id).toContain("runtime-artifact-manifest.v1.schema.json");
		expect(schema.additionalProperties).toBe(false);
		expect(schema.properties.producer.additionalProperties).toBe(false);
		expect(schema.properties.inputs.additionalProperties).toBe(false);
		expect(schema.properties.files.items.additionalProperties).toBe(false);
		expect(schema.$defs.identityFiles.items.additionalProperties).toBe(false);
		expect(schema.required).toContain("digest");
		expect(schema.properties.algorithm.const).toBe("sha256");
		expect(desktopSchema.$id).toContain(
			"desktop-runtime-manifest.v2.schema.json",
		);
		expect(desktopSchema.additionalProperties).toBe(false);
		expect(desktopSchema.properties.inputs.additionalProperties).toBe(false);
		expect(desktopSchema.$defs.file.additionalProperties).toBe(false);
		expect(desktopSchema.properties.schema.const).toBe(
			"forgeax-ide-desktop-runtime/v2",
		);
	});
});
