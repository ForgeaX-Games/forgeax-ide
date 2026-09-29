import { describe, expect, test, vi } from "vitest";
import { createBusSnapshotBinding } from "../src/integration/react-bus-snapshot";

describe("IDE React bus snapshot adapter", () => {
	test("reads the same retained snapshot for client and server renders", () => {
		const snapshot = { activeFilePath: "/game/src/main.ts" };
		const peek = vi.fn((_topic: string) => snapshot);
		const binding = createBusSnapshotBinding(
			{
				peek,
				subscribe: () => () => undefined,
			},
			"resource-editor:files",
		);

		expect(binding.getSnapshot()).toBe(snapshot);
		expect(binding.getServerSnapshot()).toBe(snapshot);
		expect(peek.mock.calls).toEqual([
			["resource-editor:files"],
			["resource-editor:files"],
		]);
	});

	test("translates payload notifications to React changes and preserves disposal", () => {
		const dispose = vi.fn(() => undefined);
		const subscribe = vi.fn(
			(topic: string, listener: (payload: unknown) => void) => {
				expect(topic).toBe("prefs:agents");
				listener({ agents: [] });
				return dispose;
			},
		);
		const onChange = vi.fn(() => undefined);
		const binding = createBusSnapshotBinding(
			{
				peek: () => undefined,
				subscribe,
			},
			"prefs:agents",
		);

		const unsubscribe = binding.subscribe(onChange);

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(unsubscribe).toBe(dispose);
	});
});
