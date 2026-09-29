import { execFileSync } from "node:child_process";
import {
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
	createArtifactManifest,
	sha256,
} from "../../scripts/artifact-manifest";
import {
	assertTargetHost,
	editorDescriptor,
	pruneIncompatibleTargetPackages,
	trackedIdentityFile,
} from "../../scripts/engine-runtime-artifacts";
import { expectCodeContains } from "../helpers/code-token-assertions";

const roots: string[] = [];

afterEach(() => {
	while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("Engine runtime artifact orchestration", () => {
	test("GNU payload excludes installed musl and foreign native variants before packaging", () => {
		const root = mkdtempSync(join(tmpdir(), "engine-native-admission-"));
		roots.push(root);
		const packages = {
			"lightningcss-linux-x64-gnu": {
				os: ["linux"],
				cpu: ["x64"],
				libc: ["glibc"],
			},
			"lightningcss-linux-x64-musl": {
				os: ["linux"],
				cpu: ["x64"],
				libc: ["musl"],
			},
			"@rolldown/binding-linux-x64-gnu": {
				os: ["linux"],
				cpu: ["x64"],
				libc: ["glibc"],
			},
			"@rolldown/binding-linux-x64-musl": {
				os: ["linux"],
				cpu: ["x64"],
				libc: ["musl"],
			},
			"@rolldown/binding-darwin-arm64": { os: ["darwin"], cpu: ["arm64"] },
			"@rolldown/binding-linux-arm64-gnu": {
				os: ["linux"],
				cpu: ["arm64"],
				libc: ["glibc"],
			},
			"native-wrapper": {},
			"negative-compatible": {
				os: ["!win32"],
				cpu: ["!arm64"],
				libc: ["!musl"],
			},
			"negative-incompatible": { libc: ["!glibc"] },
		};
		for (const [name, constraints] of Object.entries(packages)) {
			const directory = join(root, "engine/node_modules", name);
			mkdirSync(directory, { recursive: true });
			writeFileSync(
				join(directory, "package.json"),
				JSON.stringify({ name, ...constraints }),
			);
			writeFileSync(join(directory, "binding.node"), `native payload: ${name}`);
		}
		pruneIncompatibleTargetPackages(root, "linux-x64");
		const retained = new Set([
			"lightningcss-linux-x64-gnu",
			"@rolldown/binding-linux-x64-gnu",
			"native-wrapper",
			"negative-compatible",
		]);
		for (const name of Object.keys(packages)) {
			const file = join(root, "engine/node_modules", name, "binding.node");
			expect(existsSync(file)).toBe(retained.has(name));
			if (retained.has(name))
				expect(readFileSync(file, "utf8")).toBe(`native payload: ${name}`);
		}
		expect(() =>
			createArtifactManifest(root, editorDescriptor("target", "linux-x64")),
		).not.toThrow();
	});

	test("binds every logical target to its native build host", () => {
		expect(() =>
			assertTargetHost("macos-arm64", "darwin", "arm64"),
		).not.toThrow();
		expect(() => assertTargetHost("macos-x64", "darwin", "x64")).not.toThrow();
		expect(() => assertTargetHost("windows-x64", "win32", "x64")).not.toThrow();
		expect(() => assertTargetHost("macos-x64", "darwin", "arm64")).toThrow(
			"must be staged on darwin/x64",
		);
		expect(() => assertTargetHost("windows-x64", "darwin", "x64")).toThrow(
			"must be staged on win32/x64",
		);
	});

	test("binds cross-job artifacts to IDE and Studio integration revisions", () => {
		const source = readFileSync(
			join(import.meta.dirname, "../../scripts/engine-runtime-artifacts.ts"),
			"utf8",
		);
		expectCodeContains(
			source,
			"'ide-revision': gitValue(IDE_ROOT, 'rev-parse', 'HEAD')",
		);
		expectCodeContains(
			source,
			"'integration-revision': gitValue(INTEGRATION_ROOT, 'rev-parse', 'HEAD')",
		);
	});

	test("binds tracked inputs to Git blob bytes instead of checkout line endings", () => {
		const root = mkdtempSync(join(tmpdir(), "engine-artifact-identity-"));
		roots.push(root);
		execFileSync("git", ["init"], { cwd: root });
		execFileSync("git", ["config", "user.email", "ci@example.invalid"], {
			cwd: root,
		});
		execFileSync("git", ["config", "user.name", "CI"], { cwd: root });
		writeFileSync(join(root, "bun.lock"), "line-one\nline-two\n");
		execFileSync("git", ["add", "bun.lock"], { cwd: root });
		execFileSync(
			"git",
			["-c", "core.hooksPath=.git/disabled-hooks", "commit", "-m", "fixture"],
			{ cwd: root },
		);

		writeFileSync(join(root, "bun.lock"), "line-one\r\nline-two\r\n");
		expect(sha256(readFileSync(join(root, "bun.lock")))).not.toBe(
			sha256("line-one\nline-two\n"),
		);

		expect(trackedIdentityFile(root, "bun.lock")).toEqual({
			path: "bun.lock",
			sha256: sha256("line-one\nline-two\n"),
		});
	});
});
