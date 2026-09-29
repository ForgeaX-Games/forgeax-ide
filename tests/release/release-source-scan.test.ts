import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	readReleaseSourceInputs,
	scanReleaseSources,
} from "../../scripts/check-release-sources";
import absolute from "../fixtures/release-source/absolute-path.json";
import local from "../fixtures/release-source/local-sources.json";
import valid from "../fixtures/release-source/registry-only.json";

describe("release source provenance gate", () => {
	it("accepts registry-backed product inputs", () => {
		expect(scanReleaseSources(valid)).toEqual({ valid: true, violations: [] });
	});

	it("rejects workspace, file, and development-link inputs", () => {
		const result = scanReleaseSources(local);
		expect(result.valid).toBe(false);
		expect(result.violations.map((violation) => violation.token)).toEqual(
			expect.arrayContaining([
				"workspace:",
				"file:",
				"source adapter",
				"/Users/",
			]),
		);
	});

	it("rejects absolute paths in final bundle metadata", () => {
		expect(scanReleaseSources(absolute)).toMatchObject({
			valid: false,
			violations: [{ token: "/private/" }],
		});
	});

	it("rejects lockfiles pinned to a non-canonical npm tarball mirror", () => {
		const result = scanReleaseSources({
			...valid,
			lockText: "https://registry.npmjs.org/react/-/react-19.1.1.tgz",
		});

		expect(result).toMatchObject({
			valid: false,
			violations: [{ token: "non-canonical npm tarball", field: "lockText" }],
		});
	});
});

it("scans the registry closure while allowing only declared private application workspaces", () => {
	const root = mkdtempSync(join(tmpdir(), "ide-release-graph-"));
	try {
		mkdirSync(join(root, ".ci"));
		mkdirSync(join(root, "product"));
		const manifest = {
			name: "@forgeax/ide",
			private: true,
			dependencies: {
				"@forgeax/chat": "workspace:*",
				"@forgeax/app-shell": "0.98.0",
			},
		};
		const writeManifest = () =>
			writeFileSync(join(root, "package.json"), JSON.stringify(manifest));
		writeManifest();
		writeFileSync(join(root, "product/forgeax-product.json"), "{}");
		const lock = {
			packages: {
				"@forgeax/chat": ["@forgeax/chat@workspace:../../packages/chat"],
				"@forgeax/app-shell": [
					"@forgeax/app-shell@0.98.0",
					"",
					{},
					"sha512-example",
				],
			},
		};
		const writeLock = () =>
			writeFileSync(
				join(root, ".ci/web-source.bun.lock"),
				JSON.stringify(lock),
			);
		writeLock();
		expect(scanReleaseSources(readReleaseSourceInputs(root)).valid).toBe(true);
		manifest.dependencies["@forgeax/app-shell"] = "workspace:*";
		writeManifest();
		expect(scanReleaseSources(readReleaseSourceInputs(root)).valid).toBe(true);
		Object.assign(manifest.dependencies, {
			"@fixture/undeclared": "workspace:*",
		});
		writeManifest();
		expect(
			scanReleaseSources(readReleaseSourceInputs(root)).violations,
		).toContainEqual({ token: "workspace:", field: "packageText" });
		delete (manifest.dependencies as Record<string, string>)[
			"@fixture/undeclared"
		];
		manifest.dependencies["@forgeax/app-shell"] = "0.98.0";
		writeManifest();
		lock.packages["@forgeax/app-shell"][0] =
			"@forgeax/app-shell@file:../candidate.tgz";
		writeLock();
		expect(
			scanReleaseSources(readReleaseSourceInputs(root)).violations,
		).toContainEqual({ token: "file:", field: "lockText" });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
