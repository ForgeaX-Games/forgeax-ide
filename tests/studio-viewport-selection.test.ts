import { describe, expect, test } from "bun:test";
import { resolveCommittedViewportSelection } from "../src/product/studio-viewport-selection";

function runtime(
	runtimeStatus: string,
	bindingStatus = runtimeStatus,
	gameId = "game-a",
	generation = 7,
) {
	return {
		status: runtimeStatus,
		binding: {
			schemaVersion: "runtime-asset-binding-v1",
			gameId,
			scopeId: `studio-${gameId}`,
			generation,
			status: bindingStatus,
			catalogUrl: `/preview/${gameId}/${generation}/catalog.json`,
			importUrlBase: `/preview/${gameId}/${generation}/import`,
			packageUrlBase: `/preview/${gameId}/${generation}/asset`,
			catalogRoots: [
				{ root: "assets", catalogPrefix: `host-games/${gameId}/assets` },
			],
		},
	};
}

describe("Studio viewport committed selection", () => {
	test("rejects bindings without the shared schema or typed catalog roots", () => {
		const missingSchema = runtime("ready");
		Reflect.deleteProperty(missingSchema.binding, "schemaVersion");
		expect(
			resolveCommittedViewportSelection("game-a", missingSchema),
		).toBeUndefined();
		expect(
			resolveCommittedViewportSelection("game-a", {
				...runtime("ready"),
				binding: { ...runtime("ready").binding, catalogRoots: ["assets"] },
			}),
		).toBeUndefined();
	});
	test("keys a ready binding by slug, scope and generation only", () => {
		const selection = resolveCommittedViewportSelection(
			"game-a",
			runtime("ready"),
		);
		expect(selection?.key).toBe("game-a:studio-game-a:7");
		expect(selection?.binding.gameId).toBe("game-a");
	});

	test("rejects transitioning or unavailable runtime projections", () => {
		expect(
			resolveCommittedViewportSelection(
				"game-a",
				runtime("transitioning", "ready"),
			),
		).toBeUndefined();
		expect(
			resolveCommittedViewportSelection(
				"game-a",
				runtime("unavailable", "ready"),
			),
		).toBeUndefined();
		expect(
			resolveCommittedViewportSelection(
				"game-a",
				runtime("ready", "transitioning"),
			),
		).toBeUndefined();
	});

	test("rejects a ready binding that belongs to another game", () => {
		expect(
			resolveCommittedViewportSelection(
				"game-a",
				runtime("ready", "ready", "game-b"),
			),
		).toBeUndefined();
	});

	test("accepts the committed degraded fallback and keeps its identity stable", () => {
		const first = resolveCommittedViewportSelection("game-a", {
			...runtime("degraded"),
			error: "new candidate failed; previous binding retained",
		});
		const movedUrl = resolveCommittedViewportSelection("game-a", {
			...runtime("degraded"),
			binding: {
				...runtime("degraded").binding,
				catalogUrl: "/preview/proxy/catalog.json",
			},
		});
		expect(first?.key).toBe("game-a:studio-game-a:7");
		expect(movedUrl?.key).toBe(first?.key);
	});
});
