import { describe, expect, test } from "vitest";
import {
	extensionFrameContext,
	extensionRuntimeUrl,
	shouldUseIdeEmbeddedExtensionHost,
} from "../src/product/embedded-extension-runtime";

const embedded = {
	id: "@forgeax-extension/video-game",
	version: "1",
	displayName: "Video Game",
	frontendUrl: "http://localhost:5181/",
};

describe("IDE embedded extension host routing", () => {
	test("owns the two embedded iframe hosts without taking native or inline panels", () => {
		expect(shouldUseIdeEmbeddedExtensionHost(embedded, false)).toBe(true);
		expect(
			shouldUseIdeEmbeddedExtensionHost(
				{ ...embedded, id: "@forgeax-extension/game-video" },
				false,
			),
		).toBe(true);
		expect(shouldUseIdeEmbeddedExtensionHost(embedded, true)).toBe(false);
		expect(
			shouldUseIdeEmbeddedExtensionHost(
				{ ...embedded, runtimeMode: "native-module", moduleUrl: "/native.js" },
				false,
			),
		).toBe(false);
		expect(
			shouldUseIdeEmbeddedExtensionHost(
				{ ...embedded, id: "@demo/tool" },
				false,
			),
		).toBe(false);
		expect(
			shouldUseIdeEmbeddedExtensionHost(
				{ ...embedded, frontendUrl: undefined, entry: undefined },
				false,
			),
		).toBe(false);
	});

	test("keeps pane routing and same-origin URLs unchanged", () => {
		expect(
			extensionRuntimeUrl(
				"/__extension__/v1/runtime/demo?x=1",
				"center",
				"https://studio.example/app",
			),
		).toBe("/__extension__/v1/runtime/demo?x=1&pane=center");
		expect(
			extensionRuntimeUrl(
				"https://extension.example/runtime",
				"left",
				"https://studio.example/app",
			),
		).toBe("https://extension.example/runtime?pane=left");
	});

	test("passes the exact game, locale, and API endpoints to the extension frame", () => {
		const context = extensionFrameContext(
			{
				extensionId: embedded.id,
				runtimeId: "runtime one",
				title: "Video Game",
				runtimeUrl: "/runtime",
			},
			"game/one",
			"zh",
		);
		expect(context).toMatchObject({
			extensionId: embedded.id,
			runtimeId: "runtime one",
			gameId: "game/one",
			locale: "zh",
			theme: "dark",
			endpoints: {
				toolCall: "/__extension__/v1/tools/call",
				gamePackage:
					"/__extension__/v1/games/game%2Fone/package?runtimeId=runtime%20one",
				extensionApi:
					"/__extension__/v1/extension/runtime%20one?gameId=game%2Fone",
				gameVersions: "/__extension__/v1/games/game%2Fone/versions",
				gameComponents: "/__extension__/v1/games/game%2Fone/components",
			},
		});
		expect(context.capabilities).toContain("project.files");
	});
});
