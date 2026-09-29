import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
	expectCodeContains,
	expectCodeNotContains,
} from "./helpers/code-token-assertions";
import { runIsolatedViteProbe } from "./helpers/isolated-vite-probe";

describe("@forgeax/files package boundary", () => {
	test("owns file contracts, canonical topics, state and page contribution", async () => {
		const manifest = JSON.parse(
			await readFile(
				new URL("../packages/files/package.json", import.meta.url),
				"utf8",
			),
		);
		const productManifest = JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf8"),
		);
		const source = await readFile(
			new URL("../packages/files/src/index.tsx", import.meta.url),
			"utf8",
		);

		expect(manifest.name).toBe("@forgeax/files");
		expect(manifest.dependencies?.["@forgeax/interface"]).toBeUndefined();
		expect(manifest.peerDependencies?.["@forgeax/app-shell"]).toBe("^0.83.0");
		expect(manifest.peerDependencies?.["@forgeax/interface"]).toBeUndefined();
		expect(
			manifest.peerDependenciesMeta?.["@forgeax/interface"],
		).toBeUndefined();
		expect(productManifest.workspaces).toEqual(["packages/*"]);
		expectCodeNotContains(source, "@forgeax/interface");
		expectCodeContains(
			source,
			"RESOURCE_FILES_TOPIC = 'resource-editor:files'",
		);
		expectCodeContains(
			source,
			"RESOURCE_OPEN_FILE_TOPIC = 'resource-editor:open-file'",
		);
		expectCodeContains(source, "export interface FilesRuntime");
		expectCodeContains(source, "configureFilesRuntime");
		expectCodeNotContains(source, "configureFilesClient");
		expectCodeContains(source, "createFilesContribution");
		expectCodeContains(source, "id: '@forgeax/files#page/explorer'");
		expectCodeContains(source, "id: '@forgeax/files#page/preview'");
		expectCodeContains(source, "id: '@forgeax/files#panel/explorer'");
		expectCodeContains(source, "id: '@forgeax/files#panel/preview'");
		expectCodeContains(source, "id: '@forgeax/files#resource-editor/default'");
		expectCodeNotContains(source, "forgeax-ide.files#");
		expectCodeContains(source, "schemes: ['forgeax-file']");
		expectCodeNotContains(source, "@forgeax/ai-page");
		expectCodeNotContains(source, "/api/files");
		expectCodeNotContains(source, "page:files");
		expectCodeNotContains(source, "page:open-file");
	});

	test("keeps HTTP transport in the IDE adapter", async () => {
		const adapter = await readFile(
			new URL("../src/integration/rest-files-client.ts", import.meta.url),
			"utf8",
		);

		expectCodeContains(
			adapter,
			"fetch(`/api/files?path=${encodeURIComponent(path)}`)",
		);
		expectCodeContains(adapter, "fetch('/api/files'");
		expectCodeContains(adapter, "rawUrl(path)");
	});

	test("passes the real page registry owner and reference validation", async () => {
		const stdout = await runIsolatedViteProbe(
			[
				"node",
				"--experimental-strip-types",
				resolve(import.meta.dirname, "fixtures/files-registration-build.mjs"),
			],
			45_000,
		);
		const bundle = stdout
			.split("\n")
			.find((line) => line.startsWith("FILES_REGISTRATION_BUNDLE:"));
		if (!bundle)
			throw new Error(`Files registration probe produced no bundle: ${stdout}`);
		const code = JSON.parse(
			bundle.slice("FILES_REGISTRATION_BUNDLE:".length),
		) as string;
		const built = new Function(
			`${code}; return FilesRegistrationFixture;`,
		)() as {
			filesRegistration: Record<string, string | undefined>;
		};

		expect(built.filesRegistration).toEqual({
			explorer: "available",
			preview: "available",
			owner: "@forgeax/files",
			resourceEditorId: "@forgeax/files#resource-editor/default",
		});
	}, 50_000);
});
