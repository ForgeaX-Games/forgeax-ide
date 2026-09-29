import { describe, expect, test, vi } from "vitest";
import {
	createRetainedDeepLinkBridge,
	type IdeDeepLinkTopic,
} from "../src/integration/retained-deep-link-bridge";

describe("IDE retained deep-link bridge", () => {
	test("publishes both product topics with retention enabled", () => {
		const publish = vi.fn(
			(_topic: string, _payload: unknown, _options?: { retain?: boolean }) =>
				undefined,
		);
		const bridge = createRetainedDeepLinkBridge({
			publish,
			clearRetained: () => undefined,
		});
		const cases: Array<[IdeDeepLinkTopic, string]> = [
			["bus:filter-kind", "installed"],
			["bus:expand-plugin", "forgeax.extension"],
		];

		for (const [topic, payload] of cases) bridge.emitDeepLink(topic, payload);

		expect(publish.mock.calls).toEqual([
			["bus:filter-kind", "installed", { retain: true }],
			["bus:expand-plugin", "forgeax.extension", { retain: true }],
		]);
	});

	test("clears retained state before publishing the established null reset signal", () => {
		const calls: Array<[string, ...unknown[]]> = [];
		const bridge = createRetainedDeepLinkBridge({
			clearRetained: (topic) => calls.push(["clearRetained", topic]),
			publish: (topic, payload, options) =>
				calls.push(["publish", topic, payload, options]),
		});

		bridge.clearDeepLink("bus:filter-kind");

		expect(calls).toEqual([
			["clearRetained", "bus:filter-kind"],
			["publish", "bus:filter-kind", null, undefined],
		]);
	});
});
