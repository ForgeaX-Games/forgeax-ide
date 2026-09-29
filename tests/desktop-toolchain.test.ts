import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
	desktopToolchainSources,
	verifyDesktopToolchain,
} from "../scripts/desktop-toolchain";
import {
	assertTargetExecutable,
	executableIdentity,
} from "../scripts/executable-identity";

describe("desktop toolchain source contract", () => {
	test("derives exact versions from their owning repositories", () => {
		const sources = desktopToolchainSources();
		expect(sources).toMatchObject({
			bun: "1.4.2",
			node: "22.22.3",
			rust: "1.93.1",
			wasmPack: "0.14.0",
			pnpm: "11.7.0",
			server: "0.1.0",
		});
		expect(sources.engine).toBe(
			resolve(import.meta.dirname, "../../editor/packages/engine"),
		);
		const fromBootstrap = JSON.parse(
			execFileSync(
				"node",
				[resolve(import.meta.dirname, "../.ci/toolchain-versions.cjs"), "json"],
				{ encoding: "utf8" },
			),
		);
		expect(fromBootstrap).toEqual(sources);
	});

	test("runs pnpm in Engine and refuses wrong versions", () => {
		const sources = desktopToolchainSources();
		const calls: Array<[string, string]> = [];
		const versions: Record<string, string> = {
			bun: sources.bun,
			node: `v${sources.node}`,
			rustc: `rustc ${sources.rust} (fixture)`,
			"wasm-pack": `wasm-pack ${sources.wasmPack}`,
			pnpm: sources.pnpm,
		};
		verifyDesktopToolchain(sources, (command, cwd) => {
			calls.push([command, cwd]);
			return versions[command] ?? "missing";
		});
		expect(calls).toContainEqual(["pnpm", sources.engine]);
		expect(calls).toContainEqual(["bun", resolve(import.meta.dirname, "..")]);
		expect(() =>
			verifyDesktopToolchain(sources, (command) =>
				command === "pnpm" ? "9.0.0" : (versions[command] ?? "missing"),
			),
		).toThrow("pnpm version mismatch");
		const releaseCalls: string[] = [];
		const releaseVerified = verifyDesktopToolchain(
			sources,
			(command) => {
				releaseCalls.push(command);
				return versions[command] ?? "missing";
			},
			undefined,
			"release-target",
		);
		expect(releaseCalls).toEqual(["bun", "node", "rustc", "pnpm"]);
		expect(releaseVerified).not.toHaveProperty("wasm-pack");
		expect(() =>
			verifyDesktopToolchain(
				sources,
				(command) =>
					command === "rustc"
						? "rustc 1.92.0 (fixture)"
						: (versions[command] ?? "missing"),
				undefined,
				"release-target",
			),
		).toThrow("rustc version mismatch");
	});
});

describe("bundled executable identity", () => {
	test("recognizes target-specific Mach-O, ELF and PE headers", () => {
		const mac = Buffer.alloc(128);
		mac.set([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 0x01]);
		expect(assertTargetExecutable(mac, "macos-arm64")).toEqual({
			format: "mach-o",
			architectures: ["arm64"],
		});
		expect(() => assertTargetExecutable(mac, "macos-x64")).toThrow(
			"architecture mismatch",
		);
		const linux = Buffer.alloc(128);
		linux.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
		linux.writeUInt16LE(62, 18);
		expect(assertTargetExecutable(linux, "linux-x64").architectures).toEqual([
			"x64",
		]);
		const windows = Buffer.alloc(128);
		windows.writeUInt16LE(0x5a4d, 0);
		windows.writeUInt32LE(64, 0x3c);
		windows.write("PE\0\0", 64, "ascii");
		windows.writeUInt16LE(0x8664, 68);
		expect(assertTargetExecutable(windows, "windows-x64").format).toBe("pe");
	});

	test("rejects unknown, truncated and multi-architecture binaries", () => {
		expect(() => executableIdentity(Buffer.alloc(8))).toThrow("truncated");
		expect(() => executableIdentity(Buffer.alloc(128))).toThrow("unknown");
		const universal = Buffer.alloc(128);
		universal.writeUInt32BE(0xcafebabe, 0);
		universal.writeUInt32BE(2, 4);
		universal.writeUInt32BE(0x0100000c, 8);
		universal.writeUInt32BE(0x01000007, 28);
		expect(executableIdentity(universal).architectures).toEqual([
			"arm64",
			"x64",
		]);
		expect(() => assertTargetExecutable(universal, "macos-arm64")).toThrow(
			"architecture mismatch",
		);
	});
});
