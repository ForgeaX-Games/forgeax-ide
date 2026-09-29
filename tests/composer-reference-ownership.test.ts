import { readFileSync } from "node:fs";
import { test } from "vitest";
import {
	expectCodeContains,
	expectCodeNotContains,
} from "./helpers/code-token-assertions";

test("IDE owns the composer queue and injects it into shell startup", () => {
	const read = (file: string) =>
		readFileSync(new URL(file, import.meta.url), "utf8");
	const adapter = read("../src/product/chat-runtime-adapter.tsx");
	const entry = read("../src/main.tsx");
	const startup = read("../src/product/application-startup.ts");
	const declarations = read("../src/types/interface-integration.d.ts");
	expectCodeNotContains(adapter, "@forgeax/interface/lib/composer-bridge");
	expectCodeNotContains(declarations, "@forgeax/interface/lib/composer-bridge");
	expectCodeContains(adapter, "from '../integration/composer-reference-queue'");
	expectCodeContains(
		entry,
		"startIdeApplication(() => bootstrapIdeApplication(IDE_PRODUCT_OVERRIDES)",
	);
	expectCodeContains(
		startup,
		"configureComposerInsertRuntime(createIdeComposerInsertRuntime)",
	);
});
