import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test.skipIf(process.platform !== "darwin" && process.platform !== "win32")(
	"materialization failure publishes a persistent, diagnostic terminal state before spawning services",
	() => {
		const root = mkdtempSync(join(tmpdir(), "forgeax-runtime-failure-"));
		roots.push(root);
		const resources = join(root, "resources");
		const project = join(root, "project");
		const stateFile = join(project, ".forgeax/runtime/desktop-prod-123.json");
		const triple =
			process.platform === "win32"
				? "x86_64-pc-windows-msvc.exe"
				: process.arch === "arm64"
					? "aarch64-apple-darwin"
					: "x86_64-apple-darwin";
		for (const file of [
			`sidecars/forgeax-server-${triple}`,
			`sidecars/runtime-guardian-${triple}`,
			"server-runtime/native-preload.mjs",
			"server-runtime/agent-host.mjs",
			"server-runtime/forgeax-core-serve.mjs",
		]) {
			const path = join(resources, file);
			mkdirSync(resolve(path, ".."), { recursive: true });
			writeFileSync(path, "", { mode: 0o755 });
		}
		const result = spawnSync(
			process.execPath,
			[resolve(import.meta.dir, "../scripts/desktop-runtime.ts")],
			{
				env: {
					...process.env,
					FORGEAX_RESOURCE_ROOT: resources,
					FORGEAX_PROJECT_ROOT: project,
					FORGEAX_RUNTIME_STATE_FILE: stateFile,
				},
				encoding: "utf8",
				timeout: 10000,
			},
		);
		expect(result.status).toBe(1);
		expect(existsSync(stateFile)).toBe(true);
		const state = JSON.parse(readFileSync(stateFile, "utf8"));
		expect(state.status).toBe("failed");
		expect(state.error).toContain("engine/src");
		expect(state.servicePids).toEqual({});
		expect(result.stderr).toContain(state.error);
	},
);
