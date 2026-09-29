import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../src-tauri/tauri.conf.json";

describe("Tauri shell resource boundary", () => {
	it("packages the actual frontend and desktop runtime resources", () => {
		expect(config.build.frontendDist).toBe("../dist");
		expect(config.bundle.resources).toContain("resources");
		expect(config.bundle.externalBin).toContain("resources/sidecars/bun");
		expect(config.app.windows.some((window) => window.label === "main")).toBe(
			true,
		);
	});
	it("uses the cross-platform graceful shutdown protocol before force-kill", () => {
		const shell = readFileSync(
			join(import.meta.dirname, "../src-tauri/src/lib.rs"),
			"utf8",
		);
		const launcher = readFileSync(
			join(import.meta.dirname, "../scripts/desktop-runtime.ts"),
			"utf8",
		);
		expect(shell).toContain('child.write(b"shutdown\\n")');
		expect(shell).toContain("shutting_down.swap(true, Ordering::SeqCst)");
		expect(shell).not.toContain('Command::new("/bin/kill")');
		expect(launcher).toMatch(/lines\.includes\(["']shutdown["']\)/);
	});

	it("gives the Rust launcher supervisor a bounded poll budget beyond JS teardown", () => {
		const shell = readFileSync(
			join(import.meta.dirname, "../src-tauri/src/lib.rs"),
			"utf8",
		);
		const outerGraceSeconds = Number(
			shell.match(
				/LAUNCHER_SHUTDOWN_GRACE:\s*Duration\s*=\s*Duration::from_secs\((\d+)\)/,
			)?.[1],
		);
		expect(Number.isFinite(outerGraceSeconds)).toBe(true);
		expect(outerGraceSeconds).toBeGreaterThan(6);
		expect(shell).toContain("LAUNCHER_SHUTDOWN_POLL");
		expect(shell).toContain("while self.runtime.pid().is_some()");
		expect(shell).toContain("started.elapsed() < LAUNCHER_SHUTDOWN_GRACE");
		expect(shell).toContain("if self.runtime.pid().is_some()");
		expect(shell).not.toContain("std::thread::sleep(KILL_GRACE)");
	});
});
