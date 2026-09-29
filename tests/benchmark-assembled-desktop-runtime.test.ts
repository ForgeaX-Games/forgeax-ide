import { describe, expect, test } from "vitest";
import {
	ownedRuntimeRss,
	parseProcessRows,
	smokePhaseDurations,
} from "../scripts/benchmark-assembled-desktop-runtime";

describe("assembled desktop runtime benchmark", () => {
	test("samples the recorded runtime process tree without counting unrelated processes", () => {
		const rows = parseProcessRows(
			"10 1 100\n11 10 300\n12 11 500\n13 2 1000\n",
		);
		expect(ownedRuntimeRss(rows, [10])).toEqual({ totalKiB: 900, members: 3 });
		expect(ownedRuntimeRss(rows, [10, 13])).toEqual({
			totalKiB: 1900,
			members: 4,
		});
		expect(ownedRuntimeRss(rows, [99])).toBeNull();
	});

	test("derives non-overlapping startup, binding and preview spans", () => {
		const events = [
			{
				at: "2026-09-20T00:00:00.000Z",
				name: "phase",
				detail: "launch-runtime",
			},
			{ at: "2026-09-20T00:00:02.000Z", name: "phase", detail: "bind-project" },
			{
				at: "2026-09-20T00:00:02.250Z",
				name: "phase",
				detail: "browser-preview",
			},
			{
				at: "2026-09-20T00:00:05.500Z",
				name: "phase",
				detail: "cleanup-launcher",
			},
		]
			.map((event) => JSON.stringify(event))
			.join("\n");
		expect(smokePhaseDurations(events)).toEqual({
			startupReadyMs: 2000,
			projectBindMs: 250,
			previewValidatedMs: 3250,
			runtimeToValidationMs: 5500,
		});
		expect(() =>
			smokePhaseDurations(events.replace("cleanup-launcher", "other-phase")),
		).toThrow("missing or reversed smoke phases");
	});
});
