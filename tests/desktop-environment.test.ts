import { delimiter } from "node:path";
import { describe, expect, test } from "vitest";
import { desktopExecutablePath } from "../scripts/desktop-environment";

describe("desktopExecutablePath", () => {
	test("admits standard macOS GUI CLI locations without dropping launchd PATH", () => {
		const value = desktopExecutablePath(
			"/usr/bin:/bin",
			"darwin",
			"/Users/you",
		);
		expect(value.split(delimiter)).toEqual([
			"/usr/bin",
			"/bin",
			"/opt/homebrew/bin",
			"/usr/local/bin",
			"/Users/you/.local/bin",
			"/Users/you/.bun/bin",
		]);
	});

	test("does not duplicate an inherited Homebrew entry", () => {
		const value = desktopExecutablePath(
			"/opt/homebrew/bin:/usr/bin",
			"darwin",
			"/Users/you",
		);
		expect(
			value.split(delimiter).filter((entry) => entry === "/opt/homebrew/bin"),
		).toHaveLength(1);
	});

	test("leaves non-macOS PATH unchanged", () => {
		expect(
			desktopExecutablePath(
				"C:\\Windows\\System32",
				"win32",
				"C:\\Users\\tester",
			),
		).toBe("C:\\Windows\\System32");
	});
});
