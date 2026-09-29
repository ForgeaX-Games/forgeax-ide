import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fixtures: string[] = [];

afterEach(() => {
	for (const fixture of fixtures.splice(0))
		rmSync(fixture, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		});
});

describe("server native preload", () => {
	test("redirects named fs imports from the compiled virtual root", async () => {
		const root = mkdtempSync(join(tmpdir(), "forgeax-native-preload-"));
		fixtures.push(root);
		const assets = join(root, "server-runtime", "assets");
		mkdirSync(assets, { recursive: true });
		writeFileSync(join(assets, "game-charter.md"), "redirected");
		const entry = join(root, "entry.mjs");
		writeFileSync(
			entry,
			`import { readFileSync } from 'node:fs';\nconsole.log(readFileSync(new URL('./game-charter.md', import.meta.url), 'utf8'));\n`,
		);
		const preloadSource = resolve(
			import.meta.dir,
			"../scripts/server-native-preload.ts",
		);
		const preload = join(root, "preload.mjs");
		const executable = join(
			root,
			process.platform === "win32" ? "fixture.exe" : "fixture",
		);
		const preloadBuild = spawnSync(
			process.execPath,
			["build", preloadSource, "--target=bun", "--outfile", preload],
			{ encoding: "utf8" },
		);
		if (preloadBuild.status !== 0)
			throw new Error(
				preloadBuild.stderr || `preload build exited ${preloadBuild.status}`,
			);
		const executableBuild = spawnSync(
			process.execPath,
			["build", "--compile", entry, "--outfile", executable],
			{ encoding: "utf8" },
		);
		if (executableBuild.status !== 0)
			throw new Error(
				executableBuild.stderr ||
					`fixture build exited ${executableBuild.status}`,
			);

		const result = spawnSync(executable, [], {
			cwd: root,
			encoding: "utf8",
			env: {
				...process.env,
				BUN_OPTIONS: `--preload=${preload}`,
				FORGEAX_RESOURCE_ROOT: root,
				FORGEAX_PRODUCT_ROOT: join(root, "product"),
				FORGEAX_BUN_EXECUTABLE: executable,
			},
		});

		if (result.status !== 0)
			throw new Error(
				result.stderr || `preload fixture exited ${result.status}`,
			);
		expect(result.stdout.trim()).toBe("redirected");
		expect(result.stderr).toBe("");
		await Bun.sleep(1_000);
	}, 15_000);

	test("resolves packaged product extension manifests from FORGEAX_PRODUCT_ROOT", async () => {
		const root = mkdtempSync(join(tmpdir(), "forgeax-native-preload-product-"));
		fixtures.push(root);
		const productRoot = join(root, "product");
		const extensionRoot = join(
			productRoot,
			"node_modules",
			"@forgeax-extension",
			"video-game",
		);
		mkdirSync(extensionRoot, { recursive: true });
		writeFileSync(
			join(productRoot, "package.json"),
			'{"name":"forgeax-desktop-product","private":true}',
		);
		writeFileSync(
			join(extensionRoot, "package.json"),
			'{"name":"@forgeax-extension/video-game","version":"0.20.3"}',
		);
		const entry = join(root, "entry.mjs");
		writeFileSync(
			entry,
			[
				"import { readFileSync } from 'node:fs';",
				"import { createRequire } from 'node:module';",
				"import { join } from 'node:path';",
				"const requireFromProduct = createRequire(join(process.env.FORGEAX_PRODUCT_ROOT, 'package.json'));",
				"const manifestPath = requireFromProduct.resolve('@forgeax-extension/video-game/package.json');",
				"console.log(JSON.parse(readFileSync(manifestPath, 'utf8')).name);",
			].join("\n"),
		);
		const preloadSource = resolve(
			import.meta.dir,
			"../scripts/server-native-preload.ts",
		);
		const preload = join(root, "preload.mjs");
		const executable = join(
			root,
			process.platform === "win32" ? "fixture.exe" : "fixture",
		);
		const preloadBuild = spawnSync(
			process.execPath,
			["build", preloadSource, "--target=bun", "--outfile", preload],
			{ encoding: "utf8" },
		);
		if (preloadBuild.status !== 0)
			throw new Error(
				preloadBuild.stderr || `preload build exited ${preloadBuild.status}`,
			);
		const executableBuild = spawnSync(
			process.execPath,
			["build", "--compile", entry, "--outfile", executable],
			{ encoding: "utf8" },
		);
		if (executableBuild.status !== 0)
			throw new Error(
				executableBuild.stderr ||
					`fixture build exited ${executableBuild.status}`,
			);

		const result = spawnSync(executable, [], {
			cwd: root,
			encoding: "utf8",
			env: {
				...process.env,
				BUN_OPTIONS: `--preload=${preload}`,
				FORGEAX_RESOURCE_ROOT: root,
				FORGEAX_PRODUCT_ROOT: productRoot,
				FORGEAX_BUN_EXECUTABLE: executable,
			},
		});

		if (result.status !== 0)
			throw new Error(
				result.stderr || `preload fixture exited ${result.status}`,
			);
		expect(result.stdout.trim()).toBe("@forgeax-extension/video-game");
		expect(result.stderr).toBe("");
		await Bun.sleep(1_000);
	}, 15_000);
});
