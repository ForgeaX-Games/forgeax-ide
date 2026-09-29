import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
	expectCodeContains,
	expectCodeNotContains,
} from "./helpers/code-token-assertions";

describe("IDE source integration boundaries", () => {
	test("keeps the public preset runtime import separate from the source-only type graph", async () => {
		const packageJson = JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf8"),
		);
		const tsconfig = JSON.parse(
			await readFile(new URL("../tsconfig.lint.json", import.meta.url), "utf8"),
		);

		expect(packageJson.scripts.lint).toBe(
			"bun run lint:types && bun run lint:biome",
		);
		expect(packageJson.scripts.typecheck).toContain("tsconfig.lint.json");
		expect(tsconfig.compilerOptions.paths["@forgeax/editor/*"]).toEqual([
			"src/types/interface-integration.d.ts",
		]);
	});

	test("loads the public Editor preset through Vite runner semantics in development", async () => {
		const packageJson = JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf8"),
		);

		expect(packageJson.scripts.dev).toContain("--configLoader runner");
		expect(packageJson.scripts["dev:web"]).toContain("--configLoader runner");
	});

	test("resolves only the staged Chat runtime contract from source", async () => {
		const config = JSON.parse(
			await readFile(new URL("../tsconfig.json", import.meta.url), "utf8"),
		);
		const paths = config.compilerOptions.paths;

		expect(paths["@forgeax/chat/runtime"]).toBeUndefined();
		expect(paths["@forgeax/chat/*"]).toBeUndefined();
	});

	test("uses provider declarations without obsolete Interface forwarding stubs", async () => {
		expect(
			existsSync(
				new URL("../src/integration/interface-store.ts", import.meta.url),
			),
		).toBe(false);
		const declarations = await readFile(
			new URL("../src/types/interface-integration.d.ts", import.meta.url),
			"utf8",
		);
		expectCodeNotContains(
			declarations,
			"declare module '@forgeax/interface/store'",
		);
		expectCodeNotContains(
			declarations,
			"@forgeax/ide-integration/interface-store-source",
		);
		expectCodeNotContains(declarations, "@forgeax/interface/lib/lucide-icon");
	});

	test("proxies every server-owned Extension surface instead of SPA-falling back to the IDE", async () => {
		const source = await readFile(
			new URL("../vite.config.ts", import.meta.url),
			"utf8",
		);
		expectCodeContains(
			source,
			"runtimePort(process.env.FORGEAX_SERVER_PORT, 18900, 'FORGEAX_SERVER_PORT')",
		);
		expectCodeContains(source, "`http://127.0.0.1:${studioServerPort}`");
		expectCodeContains(source, "`ws://127.0.0.1:${studioServerPort}`");
		expectCodeContains(source, "'/extensions': { target: studioServerTarget");
		expectCodeContains(
			source,
			"'/__extensions__': { target: studioServerTarget",
		);
		expectCodeContains(source, "'/__ce-api__': { target: studioServerTarget");
	});

	test("proxies unprefixed engine shader resources to Play Runtime preview assets", async () => {
		const source = await readFile(
			new URL("../vite.config.ts", import.meta.url),
			"utf8",
		);
		expectCodeContains(
			source,
			"runtimePort(process.env.FORGEAX_ENGINE_PORT, 15173, 'FORGEAX_ENGINE_PORT')",
		);
		expectCodeContains(source, "`http://127.0.0.1:${playRuntimePort}`");
		expectCodeContains(source, "'/shaders': {");
		expectCodeContains(source, "rewrite: (path) => `/preview${path}`");
		expect(source).toContain("ShaderError: manifest-malformed");
	});
});
