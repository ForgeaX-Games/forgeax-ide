import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "vitest";

const wrapper = join(import.meta.dirname, "../scripts/ci-native-desktop.ts");

test("CI native wrapper rejects unknown arguments instead of silently running a normal smoke", () => {
	const result = spawnSync(
		"bun",
		[wrapper, "--app", "/tmp/release.app", "--unknown", "value"],
		{ encoding: "utf8" },
	);
	expect(result.status).not.toBe(0);
	expect(`${result.stdout}${result.stderr}`).toContain(
		"does not accept --unknown",
	);
});

test("CI native wrapper requires a value for forwarded native smoke options", () => {
	const result = spawnSync(
		"bun",
		[wrapper, "--app", "/tmp/release.app", "--fault"],
		{ encoding: "utf8" },
	);
	expect(result.status).not.toBe(0);
	expect(`${result.stdout}${result.stderr}`).toContain(
		"requires a value for --fault",
	);
});
