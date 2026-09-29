import { describe, expect, test } from "bun:test";
import { isDesktopStartupDocument } from "../src/runtime/desktop-startup";

describe("desktop startup document", () => {
	test("gates the packaged Tauri origins before the runtime is ready", () => {
		expect(
			isDesktopStartupDocument({
				protocol: "tauri:",
				hostname: "localhost",
			} as Location),
		).toBe(true);
		expect(
			isDesktopStartupDocument({
				protocol: "http:",
				hostname: "tauri.localhost",
			} as Location),
		).toBe(true);
	});

	test("allows the ready loopback runtime and normal web development origins", () => {
		expect(
			isDesktopStartupDocument({
				protocol: "http:",
				hostname: "127.0.0.1",
			} as Location),
		).toBe(false);
		expect(
			isDesktopStartupDocument({
				protocol: "http:",
				hostname: "localhost",
			} as Location),
		).toBe(false);
	});
});
