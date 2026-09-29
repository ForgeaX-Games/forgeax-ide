import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
	expectCodeContains,
	expectCodeNotContains,
} from "./helpers/code-token-assertions";

const configPath = resolve(import.meta.dirname, "../vite.config.ts");

describe("Engine MCP gateway proxy", () => {
	test("publishes only the scoped MCP path through the IDE origin", () => {
		const source = readFileSync(configPath, "utf8");

		expectCodeContains(source, "process.env.FORGEAX_MCP_URL?.trim()");
		expect(source).toMatch(/["']\/engine\/mcp["']/);
		expect(source).toMatch(/path\.replace\(\/\^\\\/engine\\\/mcp/);
		expect(source).toContain("proxyTimeout: 600_000");
		expectCodeNotContains(source, "'/engine':");
	});
});
