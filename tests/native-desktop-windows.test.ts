import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	assessWindowsQuitEvidence,
	inspectWindowsProduct,
	validateWindowsNativeInteraction,
	windowsTauriDriverArgs,
	windowsWebView2Capabilities,
} from "../scripts/native-desktop-windows";

describe("Windows native desktop adapter contract", () => {
	test("binds the product exe to Tauri driver and WebView2, not Chromium", () => {
		const root = mkdtempSync(join(tmpdir(), "forgeax-windows-smoke-"));
		const app = join(root, "ForgeaX Studio.exe");
		try {
			writeFileSync(app, "product");
			const identity = inspectWindowsProduct(app);
			expect(() =>
				windowsTauriDriverArgs({
					app,
					tauriDriver: "tauri-driver.exe",
					edgeDriver: "msedgedriver.exe",
					port: 4444,
				}),
			).toThrow("native port");
			expect(
				windowsTauriDriverArgs({
					app,
					tauriDriver: "tauri-driver.exe",
					edgeDriver: "msedgedriver.exe",
					port: 4444,
					nativePort: 4445,
				}),
			).toEqual([
				"--native-driver",
				"msedgedriver.exe",
				"--port",
				"4444",
				"--native-port",
				"4445",
			]);
			expect(windowsWebView2Capabilities(identity)).toEqual({
				platformName: "Windows",
				browserName: "webview2",
				"tauri:options": { application: app },
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects driver cleanup as a substitute for product Quit", () => {
		expect(
			assessWindowsQuitEvidence({
				nativeQuitObserved: false,
				processIdentitiesReleased: true,
				portsReleased: true,
				driverTeardownOnly: true,
			}),
		).toEqual([
			"WebDriver teardown is not a Windows product Quit event",
			"Windows product Quit was not observed",
		]);
	});

	test("requires the observed Dashboard state rather than a body click or source-length change", () => {
		const control = "Dashboard — Run/Thread/Provider monitoring";
		expect(() =>
			validateWindowsNativeInteraction(
				`<body>${control}</body>`,
				"<body>different length</body>",
			),
		).toThrow("Dashboard click");
		expect(() =>
			validateWindowsNativeInteraction(
				"<body>any button</body>",
				"<main>Dashboard Overview close dashboard</main>",
			),
		).toThrow("expected Dashboard control");
		expect(() =>
			validateWindowsNativeInteraction(
				`<body>${control}</body>`,
				"<main>Dashboard Overview close dashboard</main>",
			),
		).not.toThrow();
	});
});
