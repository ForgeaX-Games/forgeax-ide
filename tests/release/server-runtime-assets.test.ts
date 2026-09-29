import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	resolveServerRuntimeAsset,
	SERVER_RUNTIME_ASSET_NAMES,
} from "../../scripts/server-runtime-assets";

const assetRoot = join("runtime", "assets");

describe("compiled Bun server runtime assets", () => {
	test.each([
		"/$bunfs/root/game-charter.md",
		"file:///$bunfs/root/game-charter.md",
		"B:\\~BUN\\root\\game-charter.md",
		"B:/~BUN/root/game-charter.md",
		"file:///B:/%7EBUN/root/game-charter.md",
		"file:///B:/~BUN/root/game-charter.md",
	])("maps the confirmed Bun virtual form %s", (value) => {
		expect(resolveServerRuntimeAsset(value, assetRoot)).toBe(
			join(assetRoot, "game-charter.md"),
		);
	});

	test("uses the same rule for fs strings and URL instances", () => {
		const fsPath = "B:\\~BUN\\root\\ui-bridge-contract.json";
		const urlPath = new URL("file:///B:/%7EBUN/root/ui-bridge-contract.json");
		expect(resolveServerRuntimeAsset(fsPath, assetRoot)).toBe(
			join(assetRoot, "ui-bridge-contract.json"),
		);
		expect(resolveServerRuntimeAsset(urlPath, assetRoot)).toBe(
			join(assetRoot, "ui-bridge-contract.json"),
		);
		expect(SERVER_RUNTIME_ASSET_NAMES).toEqual([
			"game-charter.md",
			"ui-bridge-contract.json",
			"watcher-worker.mjs",
		]);
	});

	test("resolves the packaged worker without remapping arbitrary code", () => {
		expect(
			resolveServerRuntimeAsset(
				new URL("file:///B:/~BUN/root/watcher-worker.mjs"),
				assetRoot,
			),
		).toBe(join(assetRoot, "watcher-worker.mjs"));
		expect(
			resolveServerRuntimeAsset("/$bunfs/root/watcher-worker.mjs", assetRoot),
		).toBe(join(assetRoot, "watcher-worker.mjs"));
		expect(
			resolveServerRuntimeAsset("/$bunfs/root/other-worker.mjs", assetRoot),
		).toBeNull();
	});

	test.each([
		"/$bunfs/root/not-allowlisted.md",
		"B:\\~BUN\\root\\not-allowlisted.md",
		"C:\\ordinary\\game-charter.md",
		"/tmp/game-charter.md",
		"B:\\~BUN\\root\\nested\\game-charter.md",
		"B:/~BUN/root/../game-charter.md",
		"file:///B:/%7EBUN/root/nested/game-charter.md",
		"file:///B:/%7EBUN/root/%2e%2e/game-charter.md",
		"file:///B:/%7EBUN/root/nested%2Fgame-charter.md",
		"https://example.test/$bunfs/root/game-charter.md",
	])("does not remap an untrusted or disguised path %s", (value) => {
		expect(resolveServerRuntimeAsset(value, assetRoot)).toBeNull();
	});
});
