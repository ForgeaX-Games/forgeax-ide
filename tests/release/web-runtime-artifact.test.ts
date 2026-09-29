import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	createWebArtifactFromDirectory,
	materializeWebArtifact,
} from "../../scripts/web-runtime-artifact";

const roots: string[] = [];

afterEach(() => {
	while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("IDE Web runtime artifact", () => {
	test("seals one portable common bundle and materializes it exactly", () => {
		const root = mkdtempSync(join(tmpdir(), "ide-web-artifact-"));
		roots.push(root);
		const source = join(root, "source");
		const artifact = join(root, "artifact");
		const destination = join(root, "dist");
		mkdirSync(join(source, "assets"), { recursive: true });
		writeFileSync(join(source, "index.html"), "<main>ForgeaX</main>\n");
		writeFileSync(join(source, "assets/app.js"), 'console.log("ready")\n');
		chmodSync(join(source, "assets/app.js"), 0o755);

		const manifest = createWebArtifactFromDirectory(source, artifact);
		expect(manifest.artifactId).toBe("ide-web-bundle/v1");
		expect(manifest.scope).toBe("common");
		expect(manifest.target).toBeNull();
		expect(manifest.inputs.toolchains["publishable-shader-inputs"]).toBe(
			process.env.FORGEAX_REQUIRE_PUBLISHABLE_SHADER_INPUTS === "1"
				? "required"
				: "not-required",
		);
		expect(manifest.files.every((file) => file.executable === false)).toBe(
			true,
		);

		materializeWebArtifact(artifact, destination);
		expect(readFileSync(join(destination, "index.html"), "utf8")).toBe(
			"<main>ForgeaX</main>\n",
		);
		expect(readFileSync(join(destination, "assets/app.js"), "utf8")).toBe(
			'console.log("ready")\n',
		);
	});

	test("rejects a changed payload without leaving a partial dist", () => {
		const root = mkdtempSync(join(tmpdir(), "ide-web-artifact-"));
		roots.push(root);
		const source = join(root, "source");
		const artifact = join(root, "artifact");
		const destination = join(root, "dist");
		mkdirSync(source);
		writeFileSync(join(source, "index.html"), "<main>original</main>\n");
		createWebArtifactFromDirectory(source, artifact);
		writeFileSync(
			join(artifact, "payload/index.html"),
			"<main>tampered</main>\n",
		);

		expect(() => materializeWebArtifact(artifact, destination)).toThrow(
			"does not match manifest",
		);
		expect(existsSync(destination)).toBe(false);
	});
});
