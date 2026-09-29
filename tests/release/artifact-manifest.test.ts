import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
	type ArtifactDescriptor,
	type ArtifactManifest,
	composeArtifacts,
	createArtifactManifest,
	manifestDigest,
	normalizePortableArtifactFiles,
	sha256,
	verifyArtifactManifest,
} from "../../scripts/artifact-manifest";

const roots: string[] = [];
const revision = "1".repeat(40);
const tree = "2".repeat(40);
const descriptor: ArtifactDescriptor = {
	artifactId: "ide-test-bundle/v1",
	producer: { repository: "ForgeaX-Games/forgeax-ide", revision, tree },
	inputs: {
		lockfiles: [{ path: "bun.lock", sha256: "3".repeat(64) }],
		buildScripts: [{ path: "scripts/build.ts", sha256: "4".repeat(64) }],
		toolchains: { bun: "1.3.14" },
	},
	scope: "common",
	target: null,
};

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "artifact-manifest-"));
	roots.push(value);
	return value;
}

function fixture(name = "index.html"): {
	root: string;
	manifest: ArtifactManifest;
} {
	const artifactRoot = root();
	mkdirSync(join(artifactRoot, "dist"), { recursive: true });
	writeFileSync(join(artifactRoot, "dist", name), "payload");
	return {
		root: artifactRoot,
		manifest: createArtifactManifest(artifactRoot, structuredClone(descriptor)),
	};
}

function reseal(manifest: ArtifactManifest): ArtifactManifest {
	const { digest: _digest, ...unsigned } = manifest;
	return { ...unsigned, digest: manifestDigest(unsigned) };
}

afterEach(() => {
	while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("content-addressed runtime artifact manifest", () => {
	test("normalizes portable payload modes before sealing them", () => {
		const artifactRoot = root();
		mkdirSync(join(artifactRoot, "runtime"));
		const path = join(artifactRoot, "runtime/local-runtime.mjs");
		writeFileSync(path, "runtime");
		chmodSync(path, 0o755);

		normalizePortableArtifactFiles(artifactRoot);

		expect((statSync(path).mode & 0o111) !== 0).toBe(false);
		expect(readFileSync(path, "utf8")).toBe("runtime");
	});

	test("creates sorted file records and verifies every byte and executable bit", () => {
		const artifactRoot = root();
		mkdirSync(join(artifactRoot, "z"), { recursive: true });
		writeFileSync(join(artifactRoot, "z/run.mjs"), "run");
		chmodSync(join(artifactRoot, "z/run.mjs"), 0o755);
		writeFileSync(join(artifactRoot, "a.txt"), "a");
		const manifest = createArtifactManifest(artifactRoot, descriptor);
		expect(manifest.files.map((file) => file.path)).toEqual([
			"a.txt",
			"z/run.mjs",
		]);
		expect(manifest.files[1]).toMatchObject({
			sha256: sha256("run"),
			size: 3,
			executable: true,
		});
		expect(
			verifyArtifactManifest(artifactRoot, manifest, descriptor).digest,
		).toBe(manifest.digest);
	});

	test("sorts directory descendants against same-prefix sibling files globally", () => {
		const artifactRoot = root();
		mkdirSync(join(artifactRoot, "payload/foo"), { recursive: true });
		writeFileSync(join(artifactRoot, "payload/foo/inside.txt"), "inside");
		writeFileSync(join(artifactRoot, "payload/foo.txt"), "sibling");
		const manifest = createArtifactManifest(
			join(artifactRoot, "payload"),
			structuredClone(descriptor),
		);
		expect(manifest.files.map((file) => file.path)).toEqual([
			"foo.txt",
			"foo/inside.txt",
		]);
		expect(
			verifyArtifactManifest(join(artifactRoot, "payload"), manifest).digest,
		).toBe(manifest.digest);
	});

	test("fails closed for missing, tampered, and stale files", () => {
		const missing = fixture();
		rmSync(join(missing.root, "dist/index.html"));
		expect(() =>
			verifyArtifactManifest(missing.root, missing.manifest),
		).toThrow("missing artifact file");

		const tampered = fixture();
		writeFileSync(join(tampered.root, "dist/index.html"), "changed");
		expect(() =>
			verifyArtifactManifest(tampered.root, tampered.manifest),
		).toThrow("does not match manifest");

		const stale = fixture();
		writeFileSync(join(stale.root, "stale.txt"), "stale");
		expect(() => verifyArtifactManifest(stale.root, stale.manifest)).toThrow(
			"stale or undeclared",
		);
	});

	test("binds producer revision, lockfiles, build scripts, and toolchains", () => {
		const artifact = fixture();
		const changedRevision = structuredClone(descriptor);
		changedRevision.producer.revision = "5".repeat(40);
		expect(() =>
			verifyArtifactManifest(artifact.root, artifact.manifest, changedRevision),
		).toThrow("producer identity mismatch");
		const changedLockfile = structuredClone(descriptor);
		changedLockfile.inputs.lockfiles[0].sha256 = "6".repeat(64);
		expect(() =>
			verifyArtifactManifest(artifact.root, artifact.manifest, changedLockfile),
		).toThrow("inputs identity mismatch");
	});

	test("rejects traversal, symlinks, duplicate paths, and native pollution in common artifacts", () => {
		for (const unsafe of [
			"../escape",
			"/absolute",
			"C:/windows",
			"\\\\server\\share",
			"dist\\file",
			"dist//file",
			"dist/./file",
			"dist/../file",
			`dist/zero\0file`,
		]) {
			const traversal = fixture();
			traversal.manifest.files[0].path = unsafe;
			expect(() =>
				verifyArtifactManifest(traversal.root, reseal(traversal.manifest)),
			).toThrow("unsafe artifact path");
		}

		const symlinkRoot = root();
		const outside = join(root(), "outside.txt");
		writeFileSync(outside, "outside");
		symlinkSync(outside, join(symlinkRoot, "escape"));
		expect(() => createArtifactManifest(symlinkRoot, descriptor)).toThrow(
			"symlinks are forbidden",
		);

		const symlinkEscape = fixture();
		const replacement = root();
		writeFileSync(join(replacement, "index.html"), "payload");
		rmSync(join(symlinkEscape.root, "dist"), { recursive: true });
		symlinkSync(replacement, join(symlinkEscape.root, "dist"));
		expect(() =>
			verifyArtifactManifest(symlinkEscape.root, symlinkEscape.manifest),
		).toThrow("symlinks are forbidden");

		const duplicate = fixture();
		duplicate.manifest.files.push(structuredClone(duplicate.manifest.files[0]));
		expect(() =>
			verifyArtifactManifest(duplicate.root, reseal(duplicate.manifest)),
		).toThrow("path collision");

		const portableCollision = fixture();
		portableCollision.manifest.files = [
			{ ...portableCollision.manifest.files[0], path: "dist/INDEX.html" },
			portableCollision.manifest.files[0],
		];
		expect(() =>
			verifyArtifactManifest(
				portableCollision.root,
				reseal(portableCollision.manifest),
			),
		).toThrow("path collision");

		const nativeRoot = root();
		mkdirSync(join(nativeRoot, "node_modules/@esbuild/darwin-arm64"), {
			recursive: true,
		});
		writeFileSync(
			join(nativeRoot, "node_modules/@esbuild/darwin-arm64/esbuild"),
			"native",
		);
		expect(() => createArtifactManifest(nativeRoot, descriptor)).toThrow(
			"target-native path",
		);
	});

	test("rejects malformed schemas and unknown fields before trusting contents", () => {
		const artifact = fixture();
		expect(() =>
			verifyArtifactManifest(artifact.root, {
				...artifact.manifest,
				extra: true,
			}),
		).toThrow("unknown or missing");
		expect(() =>
			verifyArtifactManifest(artifact.root, {
				...artifact.manifest,
				schema: "forgeax-runtime-artifact/v2",
			}),
		).toThrow("unknown manifest schema");
		expect(() =>
			verifyArtifactManifest(artifact.root, {
				...artifact.manifest,
				files: "invalid",
			}),
		).toThrow("invalid manifest files");
	});

	test("composes only verified artifacts and rejects duplicate destination paths", () => {
		const first = fixture("first.html");
		const second = fixture("second.html");
		const destination = join(root(), "composed");
		expect(
			composeArtifacts(destination, [
				{ ...first, expected: descriptor },
				{ ...second, expected: descriptor },
			]).map((file) => file.path),
		).toEqual(["dist/first.html", "dist/second.html"]);

		const duplicateDestination = join(root(), "duplicate");
		expect(() =>
			composeArtifacts(duplicateDestination, [
				{ ...first, expected: descriptor },
				{ ...first, expected: descriptor },
			]),
		).toThrow("duplicate composed path");
		expect(existsSync(duplicateDestination)).toBe(false);
	});
});
