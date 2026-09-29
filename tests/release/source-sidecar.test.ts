import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
	assertSourceHost,
	type SourceSidecarContext,
	sourceTargets,
	validateSourceBinary,
} from "../../scripts/build-source-sidecar";

describe("native source sidecar", () => {
	test("requires the matching native OS and architecture", () => {
		expect(() => assertSourceHost("linux-x64", "linux", "x64")).not.toThrow();
		expect(() => assertSourceHost("windows-x64", "darwin", "arm64")).toThrow(
			"host mismatch",
		);
		expect(() => assertSourceHost("macos-arm64", "darwin", "x64")).toThrow(
			"host mismatch",
		);
	});
	test("rejects corrupted bytes, wrong version, platform and size", () => {
		const bytes = new Uint8Array(1_048_576).fill(17);
		bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
		bytes.set([62, 0], 18);
		const context: SourceSidecarContext = {
			schema: "forgeax-server-source-build/v1",
			platform: "linux-x64",
			targetTriple: sourceTargets["linux-x64"].triple,
			serviceVersion: "0.1.0",
			sourceRevisions: { server: "a".repeat(40) },
			bunVersion: "1.3.14",
			dependencyLockSha256: "b".repeat(64),
			sha256: createHash("sha256").update(bytes).digest("hex"),
			size: bytes.length,
		};
		expect(() =>
			validateSourceBinary(context, bytes, "linux-x64", "0.1.0"),
		).not.toThrow();
		const wrongArch = bytes.slice();
		wrongArch.set([183, 0], 18);
		expect(() =>
			validateSourceBinary(
				{
					...context,
					sha256: createHash("sha256").update(wrongArch).digest("hex"),
				},
				wrongArch,
				"linux-x64",
				"0.1.0",
			),
		).toThrow("architecture mismatch");
		expect(() =>
			validateSourceBinary(context, bytes, "windows-x64", "0.1.0"),
		).toThrow("identity");
		expect(() =>
			validateSourceBinary(context, bytes, "linux-x64", "0.2.0"),
		).toThrow("identity");
		expect(() =>
			validateSourceBinary(
				{ ...context, size: 1 },
				bytes,
				"linux-x64",
				"0.1.0",
			),
		).toThrow("size");
		bytes[0] ^= 1;
		expect(() =>
			validateSourceBinary(context, bytes, "linux-x64", "0.1.0"),
		).toThrow("digest");
	});
});
