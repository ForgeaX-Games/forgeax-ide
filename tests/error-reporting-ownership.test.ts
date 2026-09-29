import { readFileSync } from "node:fs";
import { test } from "vitest";
import {
	expectCodeContains,
	expectCodeNotContains,
} from "./helpers/code-token-assertions";

test("IDE owns its error reporting without importing the Interface SDK loader", () => {
	const entry = readFileSync(
		new URL("../src/main.tsx", import.meta.url),
		"utf8",
	);
	const lifecycle = readFileSync(
		new URL(
			"../src/product/application-lifecycle-boundary.tsx",
			import.meta.url,
		),
		"utf8",
	);
	const declarations = readFileSync(
		new URL("../src/types/interface-integration.d.ts", import.meta.url),
		"utf8",
	);
	expectCodeNotContains(entry, "@forgeax/interface/lib/aegis");
	expectCodeNotContains(declarations, "@forgeax/interface/lib/aegis");
	expectCodeContains(entry, "from './integration/error-reporting'");
	expectCodeContains(entry, "reportError(error, info.componentStack, scope)");
	expectCodeContains(
		lifecycle,
		"reportError(toError(retryError), null, 'studio-shell-shutdown')",
	);
});
