import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ide = resolve(import.meta.dirname, "..");

for (const [entry, args] of [
	["check-web.ts", []],
	["ci-desktop.ts", []],
	["ci-desktop.ts", ["install"]],
] as const) {
	test(`${entry} ${args.join(" ")} propagates the harness opt-out to dependency installation`, () => {
		const root = mkdtempSync(join(tmpdir(), "ide-ci-harness-"));
		try {
			writeFileSync(
				join(root, "package.json"),
				JSON.stringify({
					name: "engine-install-probe",
					scripts: { postinstall: "bun postinstall.cjs" },
				}),
			);
			writeFileSync(
				join(root, "postinstall.cjs"),
				`const fs = require("node:fs");
if (process.env.FORGEAX_SKIP_HARNESS_SYNC !== "1") throw new Error("harness opt-out was not inherited");
fs.writeFileSync("installed.json", JSON.stringify({ skipHarnessSync: process.env.FORGEAX_SKIP_HARNESS_SYNC }));`,
			);
			const preload = join(root, "probe.ts");
			// Run the real CI entry and a real Bun lifecycle child. Replace native
			// builds and checkout-specific preparation with this tiny installation.
			writeFileSync(
				preload,
				`import { mock } from "bun:test";
import * as childProcess from "node:child_process";
const realSpawnSync = childProcess.spawnSync;
Object.defineProperty(process, "platform", { value: "linux" });
Object.defineProperty(process, "arch", { value: "x64" });
mock.module(${JSON.stringify(join(ide, "scripts/desktop-toolchain.ts"))}, () => ({
  desktopToolchainSources: () => ({ pnpm: "11.7.0" })
}));
mock.module("node:child_process", () => ({
  ...childProcess,
  spawnSync(command, args, options = {}) {
    if (args?.[0] === "run" && args[1] === "ci:desktop:install") {
      return realSpawnSync(process.execPath, ["--preload", ${JSON.stringify(preload)}, ${JSON.stringify(join(ide, "scripts/ci-desktop.ts"))}, "install"], options);
    }
    if (args?.includes("scripts/install-desktop-source-workspace.ts") || args?.includes("lint:types")) {
      return realSpawnSync(process.execPath, ["install"], { ...options, cwd: ${JSON.stringify(root)} });
    }
    return { status: 0, stdout: "", stderr: "" };
  }
}));`,
			);
			const result = spawnSync(
				"bun",
				["--preload", preload, join(ide, "scripts", entry), ...args],
				{
					cwd: root,
					env: { ...process.env, FORGEAX_SKIP_HARNESS_SYNC: "" },
					encoding: "utf8",
					timeout: 15_000,
				},
			);
			expect(result.status, result.stdout + result.stderr).toBe(0);
			expect(
				JSON.parse(readFileSync(join(root, "installed.json"), "utf8")),
			).toEqual({
				skipHarnessSync: "1",
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
