import { describe, expect, test } from "vitest";
import { normalizeWindowsDevicePath } from "../scripts/desktop-environment";

describe("normalizeWindowsDevicePath", () => {
	test("removes Windows drive and UNC device prefixes", () => {
		expect(
			normalizeWindowsDevicePath(
				"\\\\?\\C:\\Program Files\\ForgeaX Studio",
				"win32",
			),
		).toBe("C:\\Program Files\\ForgeaX Studio");
		expect(
			normalizeWindowsDevicePath(
				"\\\\?\\UNC\\server\\share\\ForgeaX Studio",
				"win32",
			),
		).toBe("\\\\server\\share\\ForgeaX Studio");
	});

	test("preserves ordinary and non-Windows paths", () => {
		expect(normalizeWindowsDevicePath("C:\\ForgeaX Studio", "win32")).toBe(
			"C:\\ForgeaX Studio",
		);
		expect(
			normalizeWindowsDevicePath("\\\\?\\C:\\ForgeaX Studio", "darwin"),
		).toBe("\\\\?\\C:\\ForgeaX Studio");
	});
});
