import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
	expectCodeContains,
	expectCodeNotContains,
} from "./helpers/code-token-assertions";

describe("@forgeax/extension-gallery package boundary", () => {
	test("owns discovery presentation and App Shell navigation without Interface adapters", async () => {
		const source = await readFile(
			new URL("../packages/extension-gallery/src/index.tsx", import.meta.url),
			"utf8",
		);
		const runtimeSource = await readFile(
			new URL("../packages/extension-gallery/src/runtime.ts", import.meta.url),
			"utf8",
		);
		const manifest = JSON.parse(
			await readFile(
				new URL("../packages/extension-gallery/package.json", import.meta.url),
				"utf8",
			),
		);
		const productManifest = JSON.parse(
			await readFile(new URL("../package.json", import.meta.url), "utf8"),
		);
		const productComposition = await readFile(
			new URL("../src/product/studio-composition.tsx", import.meta.url),
			"utf8",
		);
		const tsconfig = JSON.parse(
			await readFile(new URL("../tsconfig.json", import.meta.url), "utf8"),
		);

		expect(manifest.name).toBe("@forgeax/extension-gallery");
		expect(productManifest.workspaces).toEqual(["packages/*"]);
		expect(productManifest.dependencies?.["lucide-react"]).toBe("0.460.0");
		expect(manifest.dependencies?.["@forgeax/interface"]).toBeUndefined();
		expect(manifest.peerDependencies?.["@forgeax/app-shell"]).toBe("^0.83.0");
		expect(manifest.peerDependencies?.["@forgeax/interface"]).toBeUndefined();
		expect(
			manifest.peerDependenciesMeta?.["@forgeax/interface"],
		).toBeUndefined();
		expect(tsconfig.include).toContain("packages");
		expectCodeNotContains(source, "@forgeax/interface");
		expectCodeContains(source, "export interface ExtensionGalleryRuntime");
		expectCodeContains(source, "createExtensionGalleryContribution");
		expectCodeContains(source, "runtime.listExtensions()");
		expectCodeNotContains(source, "runtime.pickLang");
		expectCodeContains(runtimeSource, "extensionGalleryText");
		expectCodeContains(source, "item.contributes?.pages");
		expectCodeContains(runtimeSource, "from 'lucide-react'");
		expectCodeContains(source, "setup(context)");
		expectCodeContains(source, "context.host");
		expectCodeNotContains(source, "runtime.lucideIconOrBox");
		expectCodeNotContains(source, "runtime.openExtensionPage");
		expect(productComposition).toContain("extensionGalleryRuntime");
		expect(productComposition).toContain(
			"createExtensionGalleryContribution(extensionGalleryRuntime)",
		);
		expect(productComposition).not.toContain("openExtensionPage");
		expect(productComposition).not.toContain(
			"from '@forgeax/interface/lib/lucide-icon'",
		);
		expectCodeNotContains(source, "@forgeax/ai-page");
		expectCodeNotContains(source, "@forgeax/interface/store");
		expectCodeNotContains(source, "file-preview");
	});
});
