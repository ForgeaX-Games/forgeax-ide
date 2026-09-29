import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { startDesktopServices } from "../../scripts/desktop-engine";
import { expectCodeContains } from "../helpers/code-token-assertions";

function readSource(url: URL): string {
	return readFileSync(url, "utf8");
}

describe("packaged desktop runtime logging", () => {
	test("requires structured runtime and POSIX service readiness before accepting the smoke", () => {
		const source = readSource(
			new URL(
				"../../scripts/smoke-assembled-desktop-runtime.ts",
				import.meta.url,
			),
		);
		expectCodeContains(source, 'if (parsed.status === "failed")');
		expectCodeContains(
			source,
			'parsed.status === "ready" && parsed.readiness?.ready && parsed.publicOrigin',
		);
		expectCodeContains(
			source,
			'!services.agentHost?.ready || !parsed.servicePids?.["agent-host"] || !parsed.servicePids.server || !parsed.servicePids.engine',
		);
		expectCodeContains(source, "while (deadlineRemaining(smokeDeadline) > 0)");
	});
	test("inherits guarded service output into the launcher pipes consumed by Tauri", () => {
		const source = readSource(
			new URL("../../scripts/desktop-runtime.ts", import.meta.url),
		);
		expectCodeContains(source, 'stdio: ["pipe", "inherit", "inherit", "pipe"]');
		expectCodeContains(
			source,
			'stdout: "inherit" as const, stderr: "inherit" as const',
		);
		expectCodeContains(
			source,
			"Bun.spawn(guardedCommand, { cwd, env: targetEnv ? sanitizedGuardianEnvironment(env) : env, ...streams,",
		);
		const supervisor = readSource(
			new URL("../../src-tauri/src/lib.rs", import.meta.url),
		);
		expect(supervisor).toContain("CommandEvent::Stdout");
		expect(supervisor).toContain("CommandEvent::Stderr");
		expect(supervisor).toContain("append_log_bytes(&log_dir, name, &b)");
	});
	test("does not spawn Server when Engine readiness fails", async () => {
		const calls: string[] = [];
		await expect(
			startDesktopServices({
				startEngine: async () => {
					calls.push("engine");
					return "engine";
				},
				waitForEngine: async () => {
					calls.push("readiness");
					throw new Error("Engine unavailable");
				},
				startServer: async () => {
					calls.push("server");
					return "server";
				},
			}),
		).rejects.toThrow("Engine unavailable");
		expect(calls).toEqual(["engine", "readiness"]);
	});
	test("bounds Engine readiness and delegates restart to the bounded Tauri supervisor", () => {
		const source = readSource(
			new URL("../../scripts/desktop-runtime.ts", import.meta.url),
		);
		const readiness = source.slice(
			source.indexOf("async function waitForEngineReadiness"),
			source.indexOf("async function waitForReadiness"),
		);
		expectCodeContains(source, "const STARTUP_TIMEOUT_MS = 120_000");
		expectCodeContains(
			source,
			"const startupDeadline = Date.now() + STARTUP_TIMEOUT_MS",
		);
		expectCodeContains(
			source,
			"waitForEngine: () => waitForEngineReadiness(startupDeadline)",
		);
		expectCodeContains(readiness, "while (Date.now() < deadline)");
		expect(readiness).toContain("packaged Engine did not become ready within");
		expectCodeContains(source, "await stop(1, false)");
		const supervisor = readSource(
			new URL("../../src-tauri/src/lib.rs", import.meta.url),
		);
		expect(supervisor).toContain("const MAX_RESTARTS: u32 = 5");
		expect(supervisor).toContain("if restarts >= MAX_RESTARTS");
		expect(supervisor).toContain('"restartExhausted": true');
	});

	test("appends sidecar chunks byte-for-byte and adds separators only to supervisor lines", async () => {
		const source = readSource(
			new URL("../../src-tauri/src/lib.rs", import.meta.url),
		);
		const rawAppender = source.slice(
			source.indexOf("fn append_log_bytes"),
			source.indexOf("fn log_line_to_disk"),
		);
		expect(rawAppender).toContain("f.write_all(bytes)");
		expect(rawAppender).not.toContain('f.write_all(b"\\n")');
		expect(source).toContain("append_log_bytes(&log_dir, name, &b)");
		expect(source).toContain("bytes.push(b'\\n')");
	});

	test("does not erase the original runtime failure while automatic restart is in progress", async () => {
		const source = readSource(
			new URL("../../src-tauri/src/lib.rs", import.meta.url),
		);
		expect(source).toContain("error.clone().filter(|value| !value.is_null())");
		expect(source).toContain('update.remove("error")');
		expect(source).toContain('"restartExhausted": true');
	});
});
