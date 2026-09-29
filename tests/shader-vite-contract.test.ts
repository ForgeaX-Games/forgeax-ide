import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
	closeHttpServer,
	extractRawShaderDefault,
	listenOnEphemeralLoopback,
} from "../scripts/verify-shader-vite-contract";
import { runIsolatedViteProbe } from "./helpers/isolated-vite-probe";

const ideRoot = resolve(import.meta.dirname, "..");
const integrationRoot = process.env.FORGEAX_INTEGRATION_ROOT
	? resolve(process.env.FORGEAX_INTEGRATION_ROOT)
	: resolve(ideRoot, "../..");
const integratedShaderInputsAvailable = [
	resolve(
		integrationRoot,
		"packages/editor/packages/edit-runtime/src/viewport/shaders/infinite-grid.wgsl",
	),
	resolve(
		integrationRoot,
		"packages/editor/packages/engine/packages/vite-plugin-shader/dist/index.mjs",
	),
	resolve(
		integrationRoot,
		"packages/editor/packages/engine/packages/wgpu-wasm/pkg/wgpu_wasm.js",
	),
	resolve(
		integrationRoot,
		"packages/interface/node_modules/@forgeax/app-shell/dist/window.js",
	),
].every(existsSync);

describe("IDE shader Vite contract", () => {
	test("preserves isolated probe output and nonzero exit diagnostics", async () => {
		expect(
			await runIsolatedViteProbe(
				[
					process.execPath,
					"-e",
					"console.log(`probe complete:${process.env.FORGEAX_VITE_CONTRACT_PROBE}`)",
				],
				2_000,
			),
		).toContain("probe complete:1");
		await expect(
			runIsolatedViteProbe(
				[
					process.execPath,
					"-e",
					'console.error("probe failed"); process.exit(2)',
				],
				2_000,
			),
		).rejects.toThrow("Vite probe exited 2: probe failed");
		await expect(
			runIsolatedViteProbe(["forgeax-test-nonexistent-executable"], 2_000),
		).rejects.toThrow("ENOENT");
	});

	test("reaps workers after an explicit, complete probe result", async () => {
		const output = await runIsolatedViteProbe(
			[
				process.execPath,
				"-e",
				'console.log("PROBE_RESULT:" + process.pid); setInterval(() => {}, 1000)',
			],
			2_000,
			"PROBE_RESULT:",
		);
		const pid = Number(output.trim().slice("PROBE_RESULT:".length));
		expect(Number.isInteger(pid)).toBe(true);
		expect(() => process.kill(pid, 0)).toThrow();
	});

	test("reaps a stalled isolated probe without stopping the parent Vite service", async () => {
		const { transformWithEsbuild } = await import("vite");
		await transformWithEsbuild("export const before: number = 1", "before.ts");
		await expect(
			runIsolatedViteProbe(
				[
					process.execPath,
					"-e",
					'console.log("stalled probe"); setInterval(() => {}, 1000)',
				],
				300,
			),
		).rejects.toThrow("Vite probe exceeded 300ms");
		const result = await transformWithEsbuild(
			"export const after: number = 2",
			"after.ts",
		);
		expect(result.code).toContain("after = 2");
	});

	test.skipIf(process.platform === "win32")(
		"keeps the deadline active while a descendant retains output pipes",
		async () => {
			await expect(
				runIsolatedViteProbe(
					[
						process.execPath,
						"-e",
						'require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }).unref(); process.exit(0)',
					],
					300,
				),
			).rejects.toThrow("Vite probe exceeded 300ms");
		},
	);

	test("accepts a Vite raw-string module and preserves the Engine directive as data", () => {
		const source = "#define_import_path editor::infinite-grid\nfn main() {}\n";

		expect(
			extractRawShaderDefault(
				`export default ${JSON.stringify(source)};`,
				"fixture",
			),
		).toBe(source);
	});

	test("keeps long raw modules filesystem-safe during contract validation", async () => {
		const source = `#define_import_path editor::infinite-grid\n${"fn main() {}\n".repeat(20_000)}`;
		const verifier = await readFile(
			new URL("../scripts/verify-shader-vite-contract.ts", import.meta.url),
			"utf8",
		);

		expect(
			extractRawShaderDefault(
				`export default ${JSON.stringify(source)};`,
				"long-fixture",
			),
		).toBe(source);
		expect(verifier).not.toContain("data:text/javascript");
	});

	test("binds the HTTP probe to an ephemeral loopback port", async () => {
		const httpServer = createHttpServer((_request, response) =>
			response.end("ok"),
		);
		try {
			const baseUrl = await listenOnEphemeralLoopback(httpServer);
			const url = new URL(baseUrl);

			expect(url.hostname).toBe("127.0.0.1");
			expect(Number(url.port)).toBeGreaterThan(0);
			expect(await (await fetch(new URL("/probe", baseUrl))).text()).toBe("ok");
		} finally {
			if (httpServer.listening) await closeHttpServer(httpServer);
		}
	});

	test("rejects WGSL that escaped the JavaScript module wrapper", () => {
		expect(() =>
			extractRawShaderDefault(
				"#define_import_path editor::infinite-grid\n",
				"fixture",
			),
		).toThrow("top-level #define_import_path");
	});

	test("rejects an artifact object or a raw string without the directive", () => {
		expect(() =>
			extractRawShaderDefault('export default { wgsl: "..." };', "fixture"),
		).toThrow("export default string");
		expect(() =>
			extractRawShaderDefault('export default "fn main() {}";', "fixture"),
		).toThrow("lost the shader directive");
	});

	test.skipIf(!integratedShaderInputsAvailable)(
		"verifies the mounted IDE Vite config",
		async () => {
			const output = await runIsolatedViteProbe(
				[
					"node",
					"--experimental-strip-types",
					resolve(ideRoot, "scripts/verify-shader-vite-contract.ts"),
				],
				60_000,
				'{"moduleId":',
			);
			const result = JSON.parse(output.trim().split("\n").at(-1)!);
			const probeUrl = new URL(result.probeUrl);

			expect(result.queries).toEqual(["?raw", "?raw&import", "?import&raw"]);
			expect(probeUrl.hostname).toBe("127.0.0.1");
			expect(Number(probeUrl.port)).toBeGreaterThan(0);
			expect(result.sourceLength).toBeGreaterThan(0);
		},
		70_000,
	);
});
