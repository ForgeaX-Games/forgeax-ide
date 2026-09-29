import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ArtifactManifest } from "../../scripts/artifact-manifest";
import { replaceDirectoriesTransactionally } from "../../scripts/compose-desktop-resources";
import { DESKTOP_PORT_POLICY } from "../../scripts/desktop-ports";
import {
	createDesktopRuntimeManifest,
	readDesktopRuntimeManifest,
	verifyDesktopRuntimeManifest,
} from "../../scripts/desktop-runtime-manifest";

const roots: string[] = [];

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "desktop-runtime-manifest-"));
	roots.push(value);
	return value;
}

function artifact(artifactId: string, digest: string): ArtifactManifest {
	return { artifactId, digest } as ArtifactManifest;
}

afterEach(() => {
	while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("composed Desktop Runtime manifest", () => {
	test("binds both artifact digests and every final resource byte", () => {
		const resources = root();
		mkdirSync(join(resources, "runtime"), { recursive: true });
		mkdirSync(join(resources, "interface/dist"), { recursive: true });
		writeFileSync(join(resources, "runtime/local-runtime.mjs"), "runtime");
		writeFileSync(join(resources, "interface/dist/index.html"), "web");
		const common = artifact("ide-desktop-runtime-common/v1", "1".repeat(64));
		const target = artifact("ide-desktop-runtime-target/v1", "2".repeat(64));

		const manifest = createDesktopRuntimeManifest(
			resources,
			"macos-arm64",
			common,
			target,
		);
		expect(manifest.schema).toBe("forgeax-ide-desktop-runtime/v2");
		expect(manifest.inputs).toEqual({
			common: { artifactId: common.artifactId, digest: common.digest },
			target: { artifactId: target.artifactId, digest: target.digest },
		});
		expect(manifest.portPolicy).toEqual(DESKTOP_PORT_POLICY);
		expect(manifest.portPolicy).toMatchObject({
			kind: "guarded-paired-offset",
			guardBase: 25273,
		});
		expect(manifest.files.map((file) => file.path)).toEqual([
			"interface/dist/index.html",
			"runtime/local-runtime.mjs",
		]);
		expect(
			verifyDesktopRuntimeManifest(
				resources,
				readDesktopRuntimeManifest(resources),
				"macos-arm64",
			).digest,
		).toBe(manifest.digest);
	});

	test("fails closed when the port policy is tampered", () => {
		const resources = root();
		mkdirSync(join(resources, "runtime"), { recursive: true });
		writeFileSync(join(resources, "runtime/local-runtime.mjs"), "runtime");
		createDesktopRuntimeManifest(
			resources,
			"macos-arm64",
			artifact("ide-desktop-runtime-common/v1", "1".repeat(64)),
			artifact("ide-desktop-runtime-target/v1", "2".repeat(64)),
		);
		const manifestPath = join(
			resources,
			"runtime/desktop-runtime-manifest.json",
		);
		const tampered = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			portPolicy: { maximumOffset: number };
		};
		tampered.portPolicy.maximumOffset = 127;
		writeFileSync(manifestPath, `${JSON.stringify(tampered)}\n`);
		expect(() =>
			verifyDesktopRuntimeManifest(
				resources,
				readDesktopRuntimeManifest(resources),
				"macos-arm64",
			),
		).toThrow("port policy contract mismatch");
	});

	test("fails closed for tampered, missing, and undeclared composed files", () => {
		for (const mutation of ["tampered", "missing", "extra"] as const) {
			const resources = root();
			mkdirSync(join(resources, "runtime"), { recursive: true });
			writeFileSync(join(resources, "runtime/local-runtime.mjs"), "runtime");
			createDesktopRuntimeManifest(
				resources,
				"windows-x64",
				artifact("ide-desktop-runtime-common/v1", "1".repeat(64)),
				artifact("ide-desktop-runtime-target/v1", "2".repeat(64)),
			);
			if (mutation === "tampered")
				writeFileSync(join(resources, "runtime/local-runtime.mjs"), "changed");
			if (mutation === "missing")
				rmSync(join(resources, "runtime/local-runtime.mjs"));
			if (mutation === "extra")
				writeFileSync(join(resources, "stale.txt"), "stale");
			expect(() =>
				verifyDesktopRuntimeManifest(
					resources,
					readDesktopRuntimeManifest(resources),
					"windows-x64",
				),
			).toThrow("do not match manifest");
		}
	});

	test("replaces resources and dist as one transaction", () => {
		const base = root();
		const stagedResources = join(base, "staged-resources");
		const stagedDist = join(base, "staged-dist");
		const resources = join(base, "resources");
		const dist = join(base, "dist");
		for (const [path, value] of [
			[stagedResources, "new-resources"],
			[stagedDist, "new-dist"],
			[resources, "old-resources"],
			[dist, "old-dist"],
		] as const) {
			mkdirSync(path);
			writeFileSync(join(path, "value.txt"), value);
		}
		replaceDirectoriesTransactionally([
			{ source: stagedResources, destination: resources },
			{ source: stagedDist, destination: dist },
		]);
		expect(readFileSync(join(resources, "value.txt"), "utf8")).toBe(
			"new-resources",
		);
		expect(readFileSync(join(dist, "value.txt"), "utf8")).toBe("new-dist");
	});

	test("restores every previous directory when a later install fails", () => {
		const base = root();
		const stagedResources = join(base, "staged-resources");
		const stagedDist = join(stagedResources, "nested-dist");
		const resources = join(base, "resources");
		const dist = join(base, "dist");
		for (const [path, value] of [
			[stagedDist, "new-dist"],
			[resources, "old-resources"],
			[dist, "old-dist"],
		] as const) {
			mkdirSync(path, { recursive: true });
			writeFileSync(join(path, "value.txt"), value);
		}
		writeFileSync(join(stagedResources, "value.txt"), "new-resources");

		expect(() =>
			replaceDirectoriesTransactionally([
				{ source: stagedResources, destination: resources },
				{ source: stagedDist, destination: dist },
			]),
		).toThrow();
		expect(readFileSync(join(resources, "value.txt"), "utf8")).toBe(
			"old-resources",
		);
		expect(readFileSync(join(dist, "value.txt"), "utf8")).toBe("old-dist");
	});
});
