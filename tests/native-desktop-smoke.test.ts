import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
	activateMacNativeApp,
	assertMacNativeForeground,
	inspectMacosApp,
	mac2SessionRequestTimeout,
	parseNativeSmokeOptions,
	retainValidatedReadyRuntimeSnapshot,
	validateDesktopPageLoadReceipt,
	validateDesktopProdState,
	waitForMacDashboardControl,
	waitForMacDashboardResult,
} from "../scripts/smoke-native-desktop";

async function expectPollingDeadlineFailure(
	operation: (deadline: number) => Promise<unknown>,
	message: string,
): Promise<void> {
	vi.useFakeTimers();
	try {
		// Let the mocked driver operations settle before expiring the poll.
		// A busy CI worker must not consume this deadline between microtasks.
		const failure = expect(operation(Date.now() + 25)).rejects.toThrow(message);
		await vi.advanceTimersByTimeAsync(25);
		await failure;
	} finally {
		vi.useRealTimers();
	}
}

describe("native desktop smoke contract", () => {
	test("requires an explicit product artifact and rejects malformed ports", () => {
		vi.stubEnv("FORGEAX_CI_IDE_REVISION", undefined);
		try {
			expect(() => parseNativeSmokeOptions([])).toThrow("--app");
			expect(() =>
				parseNativeSmokeOptions([
					"--app",
					"/tmp/Fake.app",
					"--appium-port",
					"0",
				]),
			).toThrow("integer");
			const args = [
				"--app",
				"/tmp/Fake.app",
				"--appium-port",
				"4724",
				"--keep-artifacts",
			];
			expect(parseNativeSmokeOptions(args)).toEqual({
				app: "/tmp/Fake.app",
				appiumPort: 4724,
				keepArtifacts: true,
			});
			const revision = "a".repeat(40);
			vi.stubEnv("FORGEAX_CI_IDE_REVISION", revision);
			expect(parseNativeSmokeOptions(args)).toEqual({
				app: "/tmp/Fake.app",
				appiumPort: 4724,
				keepArtifacts: true,
				revision,
			});
		} finally {
			vi.unstubAllEnvs();
		}
	});

	test("gives only session creation the bounded Mac2 startup allowance", () => {
		expect(mac2SessionRequestTimeout(Date.now() + 999_999)).toBe(270_000);
		expect(mac2SessionRequestTimeout(Date.now() + 500)).toBeLessThanOrEqual(
			500,
		);
	});

	test.runIf(process.platform === "darwin")(
		"rejects a missing release bundle with an actionable error",
		() => {
			expect(() =>
				inspectMacosApp("/tmp/forgeax-native-desktop-missing.app"),
			).toThrow("--app must name an existing release .app bundle");
		},
	);

	test.runIf(process.platform === "darwin")(
		"rejects a package whose executable identity is not the product identifier",
		() => {
			const root = mkdtempSync(join(tmpdir(), "forgeax-native-bad-app-"));
			const app = join(root, "Other.app");
			try {
				mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
				writeFileSync(
					join(app, "Contents", "Info.plist"),
					`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Other</string><key>CFBundleIdentifier</key><string>example.other</string></dict></plist>`,
				);
				writeFileSync(
					join(app, "Contents", "MacOS", "Other"),
					"not executable",
				);
				expect(() => inspectMacosApp(app)).toThrow(
					"unexpected product bundle identifier",
				);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	test("fails closed when a ready state omits runtime ownership or port evidence", () => {
		const ready = {
			profile: "desktop-prod",
			status: "ready",
			readiness: { ready: true },
			portOffset: 0,
			publicOrigin: "http://127.0.0.1:18810",
			launcherPid: 101,
			servicePids: { server: 102, engine: 103, "agent-host": 104 },
			managedPorts: { server: 18810, engine: 15273 },
		};
		expect(() =>
			validateDesktopProdState({ ...ready, managedPorts: { server: 18810 } }),
		).toThrow("incomplete managed port");
		expect(() =>
			validateDesktopProdState({
				...ready,
				publicOrigin: "https://example.test:18810",
			}),
		).toThrow("loopback");
		expect(() =>
			validateDesktopProdState({ ...ready, servicePids: {} }),
		).toThrow("incomplete launcher/service");
		expect(() => validateDesktopProdState({ ...ready, portOffset: 1 })).toThrow(
			"managed port",
		);
		expect(() =>
			validateDesktopProdState({
				...ready,
				portOffset: 4,
				publicOrigin: "http://127.0.0.1:18814",
				managedPorts: { server: 18814, engine: 15277 },
			}),
		).not.toThrow();
		expect(() =>
			validateDesktopProdState({
				...ready,
				servicePids: { server: 101, engine: 103, "agent-host": 104 },
			}),
		).toThrow("incomplete launcher/service");
		expect(() => validateDesktopProdState(ready)).not.toThrow();
	});

	test("retains verified ready ownership when the runtime writes a terminal state after Quit", () => {
		const ready = {
			profile: "desktop-prod",
			status: "ready",
			readiness: { ready: true },
			portOffset: 0,
			publicOrigin: "http://127.0.0.1:18810",
			launcherPid: 101,
			servicePids: { server: 102, engine: 103, "agent-host": 104 },
			managedPorts: { server: 18810, engine: 15273 },
		} as const;
		const terminal = { ...ready, status: "stopped" as const };
		expect(retainValidatedReadyRuntimeSnapshot(ready, terminal)).toBe(ready);
		expect(
			retainValidatedReadyRuntimeSnapshot(undefined, terminal),
		).toBeUndefined();
	});

	test("accepts only a finished main-window receipt bound to this app, project, and origin", () => {
		const receipt = {
			schemaVersion: 1,
			appPid: 101,
			projectRoot: "/tmp/project",
			windowLabel: "main",
			expectedOrigin: "http://127.0.0.1:18810",
			pageUrl: "http://127.0.0.1:18810",
			runtimeStartedAt: "launch-a",
			navigationGeneration: "ready-a",
			event: "finished",
		};
		expect(() =>
			validateDesktopPageLoadReceipt(
				receipt,
				101,
				"/tmp/project",
				"http://127.0.0.1:18810",
				"launch-a",
				"ready-a",
			),
		).not.toThrow();
		expect(() =>
			validateDesktopPageLoadReceipt(
				{ ...receipt, pageUrl: "http://127.0.0.1:19999" },
				101,
				"/tmp/project",
				"http://127.0.0.1:18810",
				"launch-a",
				"ready-a",
			),
		).toThrow("project/origin");
		expect(() =>
			validateDesktopPageLoadReceipt(
				{ ...receipt, appPid: 102 },
				101,
				"/tmp/project",
				"http://127.0.0.1:18810",
				"launch-a",
				"ready-a",
			),
		).toThrow("identity");
		expect(() =>
			validateDesktopPageLoadReceipt(
				receipt,
				101,
				"/tmp/project",
				"http://127.0.0.1:18810",
				"launch-b",
				"ready-a",
			),
		).toThrow("generation");
	});

	test("waits through empty AX until the exact visible Dashboard control exists", async () => {
		const label = "Dashboard — Run/Thread/Provider monitoring";
		let reads = 0;
		const captures: string[] = [];
		const selectors: string[] = [];
		const element = {
			isExisting: async () => true,
			isDisplayed: async () => true,
			click: async () => {},
		};
		const browser = {
			getPageSource: async () =>
				++reads < 3
					? '<XCUIElementTypeWindow><XCUIElementTypeButton label="Other"/></XCUIElementTypeWindow>'
					: `<XCUIElementTypeButton identifier="" label="${label}" enabled="true"/>`,
			$: async (selector: string) => {
				selectors.push(selector);
				return element;
			},
		};
		expect(
			await waitForMacDashboardControl(
				browser,
				Date.now() + 2_000,
				(source) => {
					captures.push(source);
				},
			),
		).toBe(element);
		expect(reads).toBe(3);
		expect(captures.at(-1)).toContain(label);
		expect(selectors).toEqual([`~${label}`]);
	});

	test("rejects a source-only or fake Dashboard target and retains the last AX source", async () => {
		const label = "Dashboard — Run/Thread/Provider monitoring";
		const captures: string[] = [];
		const browser = {
			getPageSource: async () =>
				`<XCUIElementTypeButton identifier="" label="${label}" enabled="false"/>`,
			$: async () => ({
				isExisting: async () => true,
				isDisplayed: async () => false,
				click: async () => {},
			}),
		};
		await expect(
			waitForMacDashboardControl(browser, Date.now() + 1_000, (source) => {
				captures.push(source);
			}),
		).rejects.toThrow("visible Dashboard");
		expect(captures.at(-1)).toContain(label);
	});

	test("bounds an AX source operation that never returns", async () => {
		const browser = {
			getPageSource: () => new Promise<string>(() => {}),
			$: async () => ({
				isExisting: async () => false,
				isDisplayed: async () => false,
				click: async () => {},
			}),
		};
		await expectPollingDeadlineFailure(
			(deadline) => waitForMacDashboardControl(browser, deadline, () => {}),
			"exceeded",
		);
	});

	test("bounds a Dashboard locator that never returns", async () => {
		const label = "Dashboard — Run/Thread/Provider monitoring";
		const browser = {
			getPageSource: async () =>
				`<XCUIElementTypeButton identifier="" label="${label}" enabled="true"/>`,
			$: () => new Promise<never>(() => {}),
		};
		await expectPollingDeadlineFailure(
			(deadline) => waitForMacDashboardControl(browser, deadline, () => {}),
			"Dashboard locator",
		);
	});

	test("activates the exact bundle and rejects a background product before clicking", async () => {
		const calls: Array<[string, { readonly path: string }]> = [];
		const browser = {
			execute: async (script: string, args: { readonly path: string }) => {
				calls.push([script, args]);
				return script === "macos: queryAppState" ? 4 : null;
			},
		};
		await activateMacNativeApp(
			browser,
			"/tmp/ForgeaX Studio.app",
			Date.now() + 100,
		);
		expect(calls).toEqual([
			["macos: activateApp", { path: "/tmp/ForgeaX Studio.app" }],
			["macos: queryAppState", { path: "/tmp/ForgeaX Studio.app" }],
		]);
		await expect(
			activateMacNativeApp(
				{
					execute: async (script) =>
						script === "macos: queryAppState" ? 3 : null,
				},
				"/tmp/ForgeaX Studio.app",
				Date.now() + 100,
			),
		).rejects.toThrow("foreground");
		await expect(
			assertMacNativeForeground(
				{ execute: async () => 3 },
				"/tmp/ForgeaX Studio.app",
				Date.now() + 100,
			),
		).rejects.toThrow("lost product foreground");
		await expect(
			assertMacNativeForeground(
				{ execute: async () => 4 },
				"/tmp/ForgeaX Studio.app",
				Date.now() + 100,
				42,
				() => 7,
			),
		).rejects.toThrow("frontmost application changed");
		await expect(
			assertMacNativeForeground(
				{
					execute: async () => {
						throw new Error("driver transport failed");
					},
				},
				"/tmp/ForgeaX Studio.app",
				Date.now() + 100,
			),
		).rejects.toThrow("driver transport failed");
	});

	test("rejects an acknowledged click when AX is unchanged even if it already contains result tokens", async () => {
		const source =
			'<XCUIElementTypeWebView><XCUIElementTypeStaticText label="Dashboard" width="10" height="10"/><XCUIElementTypeStaticText label="Overview" width="10" height="10"/><XCUIElementTypeButton label="close dashboard" width="10" height="10"/></XCUIElementTypeWebView>';
		const browser = {
			getPageSource: async () => source,
			$: async () => ({
				isExisting: async () => true,
				isDisplayed: async () => true,
				click: async () => {},
			}),
		};
		await expectPollingDeadlineFailure(
			(deadline) =>
				waitForMacDashboardResult(browser, source, deadline, () => {}),
			"changed, visible",
		);
	});

	test("requires an exact visible close control in the changed Dashboard tree", async () => {
		const before =
			'<XCUIElementTypeWebView><XCUIElementTypeButton label="Dashboard — Run/Thread/Provider monitoring" width="10" height="10"/></XCUIElementTypeWebView>';
		const after =
			'<XCUIElementTypeWebView><XCUIElementTypeStaticText label="Dashboard" width="10" height="10"/><XCUIElementTypeStaticText label="Overview" width="10" height="10"/></XCUIElementTypeWebView>';
		const browser = {
			getPageSource: async () => after,
			$: async () => ({
				isExisting: async () => true,
				isDisplayed: async () => false,
				click: async () => {},
			}),
		};
		await expectPollingDeadlineFailure(
			(deadline) =>
				waitForMacDashboardResult(browser, before, deadline, () => {}),
			"changed, visible",
		);
	});

	test("accepts the real scoped Dashboard Group AX shape with Overview tab and heading", async () => {
		const before =
			'<XCUIElementTypeWebView><XCUIElementTypeButton label="Dashboard — Run/Thread/Provider monitoring" width="10" height="10"/></XCUIElementTypeWebView>';
		const after =
			'<XCUIElementTypeWebView><XCUIElementTypeGroup label="Dashboard" title="Dashboard" width="1384" height="835"><XCUIElementTypeButton label="close dashboard" title="close dashboard" width="29" height="28"/><XCUIElementTypeTab title="Overview" selected="true" width="164" height="33"/><XCUIElementTypeStaticText title="Overview" width="1158" height="28"/></XCUIElementTypeGroup></XCUIElementTypeWebView>';
		const close = {
			isExisting: async () => true,
			isDisplayed: async () => true,
			click: async () => {},
		};
		const browser = {
			getPageSource: async () => after,
			$: async (selector: string) => {
				expect(selector).toBe("~close dashboard");
				return close;
			},
		};
		await expect(
			waitForMacDashboardResult(browser, before, Date.now() + 100, () => {}),
		).resolves.toBe(after);
	});

	test("stops result polling as soon as foreground verification reports another app", async () => {
		const before = "<XCUIElementTypeWebView/>";
		const browser = {
			getPageSource: async () => {
				throw new Error("source should not be read after focus loss");
			},
			$: async () => ({
				isExisting: async () => false,
				isDisplayed: async () => false,
				click: async () => {},
			}),
		};
		await expect(
			waitForMacDashboardResult(
				browser,
				before,
				Date.now() + 100,
				() => {},
				async () => {
					throw new Error(
						"Mac2 lost product foreground during interaction (state=3)",
					);
				},
			),
		).rejects.toThrow("lost product foreground");
	});
});
