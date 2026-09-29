import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "vitest";
import { writeDesktopPipe } from "../scripts/desktop-pipe";

// The launcher writes Bun's inherited pipe descriptors. Exercise that real
// runtime in a subprocess while Vitest and every assertion run in Node.
function probe(mode: string) {
	return JSON.parse(
		execFileSync(
			"bun",
			[join(import.meta.dirname, "fixtures/desktop-pipe-probe.ts"), mode],
			{ encoding: "utf8", timeout: 5_000 },
		),
	);
}

test.skipIf(process.platform === "win32")(
	"drains a payload larger than pipe capacity to a delayed reader",
	() => {
		const payloadSize = 512 * 1024;
		expect(probe("drain")).toEqual({
			code: 0,
			output: `${payloadSize} ${payloadSize * 97}`,
		});
	},
);

test.skipIf(process.platform === "win32")(
	"bounds a blocked reader and propagates permanent fd errors",
	async () => {
		expect(probe("blocked").error).toContain("timed out");
		await expect(writeDesktopPipe(-1, Buffer.from("x"))).rejects.toThrow();
	},
);
