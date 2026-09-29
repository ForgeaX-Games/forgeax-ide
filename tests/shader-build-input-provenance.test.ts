import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import {
	type EngineSourceIdentity,
	inspectShaderBuildProvenance,
	sha256File,
	shaderBuildInputPaths,
	writeShaderBuildProvenance,
} from "../scripts/shader-build-input-provenance";

const testRoot = mkdtempSync(join(tmpdir(), "forgeax-shader-provenance-"));
const engineRoot = join(testRoot, "engine");
const paths = shaderBuildInputPaths(engineRoot);
const cleanIdentity: EngineSourceIdentity = {
	revision: "a".repeat(40),
	tree: "b".repeat(40),
	dirty: false,
};

function prepareArtifact(): void {
	mkdirSync(join(engineRoot, "packages/vite-plugin-shader/dist"), {
		recursive: true,
	});
	mkdirSync(join(engineRoot, "packages/wgpu-wasm/pkg"), { recursive: true });
	writeFileSync(
		paths.shaderPluginEntry,
		'export default { hash: "test", wgsl: "" };\n',
	);
	writeFileSync(paths.wgpuWasmGlue, "export {};\n");
	rmSync(paths.provenancePath, { force: true });
}

beforeEach(prepareArtifact);
afterAll(() => rmSync(testRoot, { recursive: true, force: true }));

describe("shader build input provenance", () => {
	test("reuses a matching clean artifact", () => {
		writeShaderBuildProvenance(paths, cleanIdentity);

		const result = inspectShaderBuildProvenance(paths, cleanIdentity);

		expect(result).toMatchObject({
			valid: true,
			reusable: true,
			publishable: true,
		});
		expect(result.reasons).toEqual([]);
	});

	test("rejects a missing or malformed sidecar", () => {
		expect(inspectShaderBuildProvenance(paths, cleanIdentity).valid).toBe(
			false,
		);

		writeFileSync(paths.provenancePath, '{"schemaVersion": 1}\n');
		const result = inspectShaderBuildProvenance(paths, cleanIdentity);

		expect(result.valid).toBe(false);
		expect(result.reasons).toContain(
			`missing or invalid provenance: ${paths.provenancePath}`,
		);
	});

	test("rejects a sidecar from a different Engine revision or artifact", () => {
		writeShaderBuildProvenance(paths, cleanIdentity);
		const differentIdentity = { ...cleanIdentity, revision: "c".repeat(40) };
		const revisionResult = inspectShaderBuildProvenance(
			paths,
			differentIdentity,
		);
		expect(revisionResult.valid).toBe(false);
		expect(revisionResult.reasons).toContain(
			"provenance Engine revision does not match the checkout",
		);

		writeFileSync(
			paths.shaderPluginEntry,
			'export default { hash: "changed", wgsl: "" };\n',
		);
		const hashResult = inspectShaderBuildProvenance(paths, cleanIdentity);
		expect(hashResult.valid).toBe(false);
		expect(hashResult.reasons).toContain(
			"shader plugin dist/index.mjs hash does not match provenance",
		);
	});

	test("allows a dirty checkout only after rebuilding and never marks it reusable", () => {
		writeShaderBuildProvenance(paths, cleanIdentity);
		const dirtyIdentity = { ...cleanIdentity, dirty: true };
		expect(inspectShaderBuildProvenance(paths, dirtyIdentity).valid).toBe(
			false,
		);

		rmSync(paths.provenancePath, { force: true });
		writeShaderBuildProvenance(paths, dirtyIdentity);
		const result = inspectShaderBuildProvenance(paths, dirtyIdentity);

		expect(result).toMatchObject({
			valid: true,
			reusable: false,
			publishable: false,
		});
	});

	test("replaces an existing sidecar without leaving a temporary file", () => {
		writeShaderBuildProvenance(paths, cleanIdentity);
		writeFileSync(
			paths.shaderPluginEntry,
			'export default { hash: "replaced", wgsl: "" };\n',
		);
		const replaced = writeShaderBuildProvenance(paths, cleanIdentity);

		expect(replaced.outputs["index.mjs"].sha256).toBe(
			sha256File(paths.shaderPluginEntry),
		);
		expect(JSON.parse(readFileSync(paths.provenancePath, "utf8"))).toEqual(
			replaced,
		);
		expect(
			readdirSync(dirname(paths.provenancePath)).filter((name) =>
				name.endsWith(".tmp"),
			),
		).toEqual([]);
	});

	test("does not persist absolute paths or timestamps", () => {
		writeShaderBuildProvenance(paths, cleanIdentity);
		const sidecar = readFileSync(paths.provenancePath, "utf8");

		expect(sidecar).not.toContain(engineRoot);
		expect(sidecar).not.toContain("builtAt");
		expect(sidecar).not.toContain("timestamp");
	});
});
