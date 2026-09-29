import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("product topic bus comes from App Shell without Interface ambient shims", () => {
	for (const path of [
		"src/product/chat-runtime-adapter.tsx",
		"src/product/studio-composition.tsx",
	]) {
		const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
		expect(source).not.toContain("@forgeax/interface/lib/bus");
		expect(source).toContain("publishTopic as publish");
		expect(source).toContain("subscribeTopic as subscribe");
	}
	const types = readFileSync(
		new URL("../src/types/interface-integration.d.ts", import.meta.url),
		"utf8",
	);
	expect(types).not.toContain("@forgeax/interface/lib/bus");
});
