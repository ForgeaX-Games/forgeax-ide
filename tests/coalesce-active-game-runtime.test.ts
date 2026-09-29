import { describe, expect, test } from "vitest";
import {
	coalesceActiveProjectSelection,
	coalesceIncomingActiveGameRuntime,
} from "../src/product/coalesce-active-game-runtime";
import type {
	RuntimeAssetBinding,
	RuntimeScopeState,
} from "../src/product/shell-state-domain-contract";

const binding: RuntimeAssetBinding = {
	schemaVersion: "runtime-asset-binding-v1",
	gameId: "test-game-390",
	scopeId: "studio-abc",
	generation: 7,
	status: "degraded",
	catalogUrl: "/preview/__pack/scopes/studio-abc/7/catalog.json",
	importUrlBase: "/preview/__pack/scopes/studio-abc/7/import",
	packageUrlBase: "/preview/__pack/scopes/studio-abc/7/asset",
	catalogRoots: [
		{ root: "assets", catalogPrefix: "host-games/test-game-390/assets" },
	],
};

describe("coalesceIncomingActiveGameRuntime", () => {
	test("retains binding when server publishes transitioning without payload", () => {
		const previous: RuntimeScopeState = { status: "degraded", binding };
		const incoming: RuntimeScopeState = { status: "transitioning" };
		const merged = coalesceIncomingActiveGameRuntime(
			"test-game-390",
			incoming,
			previous,
		);
		expect(merged.binding).toEqual(binding);
		expect(merged.status).toBe("transitioning");
	});

	test("does not retain binding for a different game slug", () => {
		const previous: RuntimeScopeState = { status: "degraded", binding };
		const incoming: RuntimeScopeState = { status: "transitioning" };
		expect(
			coalesceIncomingActiveGameRuntime("other-game", incoming, previous)
				.binding,
		).toBeUndefined();
	});

	test("incoming binding wins over retained copy", () => {
		const next: RuntimeAssetBinding = {
			...binding,
			generation: 8,
			status: "ready",
		};
		const previous: RuntimeScopeState = { status: "degraded", binding };
		const incoming: RuntimeScopeState = { status: "ready", binding: next };
		expect(
			coalesceIncomingActiveGameRuntime("test-game-390", incoming, previous)
				.binding,
		).toEqual(next);
	});

	test("coalesceActiveProjectSelection wraps runtime", () => {
		const selection = coalesceActiveProjectSelection(
			{ activeSlug: "test-game-390", runtime: { status: "transitioning" } },
			{ status: "degraded", binding },
		);
		expect(selection.runtime?.binding?.generation).toBe(7);
	});
});
