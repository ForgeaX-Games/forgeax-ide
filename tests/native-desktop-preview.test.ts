import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	assessMacosNativePreview,
	assessWindowsNativePreview,
	NATIVE_PREVIEW_FRAME_ATTRIBUTE,
	NATIVE_PREVIEW_GAME_NAME,
	NATIVE_PREVIEW_GAME_SLUG,
	nativePreviewUrl,
	prepareNativeDesktopPreviewFixture,
	probeMacosNativePreviewPalette,
	runWindowsNativePreviewScenario,
} from "../scripts/native-desktop-preview";

describe("native desktop preview helper", () => {
	test("creates an isolated real game entry and removes only that entry", () => {
		const root = mkdtempSync(join(tmpdir(), "forgeax-native-preview-"));
		const sentinel = join(root, "keep.txt");
		writeFileSync(sentinel, "keep");
		try {
			const fixture = prepareNativeDesktopPreviewFixture(root);
			expect(fixture.gameRoot).toBe(
				join(root, ".forgeax", "games", NATIVE_PREVIEW_GAME_SLUG),
			);
			expect(
				JSON.parse(readFileSync(join(fixture.gameRoot, "forge.json"), "utf8")),
			).toEqual({
				id: NATIVE_PREVIEW_GAME_SLUG,
				name: NATIVE_PREVIEW_GAME_NAME,
				schemaVersion: "2.0.0",
				plugins: [
					{
						id: "native-desktop-preview-smoke",
						name: "./assets/native-desktop-preview.plugin.ts",
						realm: "engine",
					},
				],
			});
			expect(
				readFileSync(
					join(fixture.gameRoot, "assets", "native-desktop-preview.plugin.ts"),
					"utf8",
				),
			).toContain("native-desktop-preview-smoke");
			fixture.cleanup();
			expect(existsSync(fixture.gameRoot)).toBe(false);
			expect(existsSync(sentinel)).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("accepts only WebView2 evidence that binds fixture, viewport canvas, and submitted frame", () => {
		const root = mkdtempSync(join(tmpdir(), "forgeax-native-preview-"));
		try {
			const fixture = prepareNativeDesktopPreviewFixture(root);
			expect(
				assessWindowsNativePreview(
					{
						activeGameText: NATIVE_PREVIEW_GAME_NAME,
						viewportVisible: true,
						canvasCount: 1,
						frameSubmittedValue: "7",
					},
					fixture,
				).outcome,
			).toBe("rendered");
			expect(() =>
				assessWindowsNativePreview(
					{
						activeGameText: NATIVE_PREVIEW_GAME_NAME,
						viewportVisible: true,
						canvasCount: 1,
						frameSubmittedValue: "0",
					},
					fixture,
				),
			).toThrow(NATIVE_PREVIEW_FRAME_ATTRIBUTE);
			fixture.cleanup();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("enters only the fixture-bound in-app preview iframe before reading the game canvas", async () => {
		const root = mkdtempSync(join(tmpdir(), "forgeax-native-preview-"));
		const calls: string[] = [];
		try {
			const fixture = prepareNativeDesktopPreviewFixture(root);
			const browser = {
				$(selector: string) {
					return Promise.resolve({
						isExisting: async () => true,
						isDisplayed: async () => true,
						click: async () => {
							calls.push(`click:${selector}`);
						},
						setValue: async (value: string) => {
							calls.push(`value:${selector}:${value}`);
						},
						selectByAttribute: async (attribute: string, value: string) => {
							calls.push(`select:${selector}:${attribute}:${value}`);
						},
					});
				},
				keys: async (keys: readonly string[]) => {
					calls.push(`keys:${keys.join("+")}`);
				},
				execute<T>(script: (...args: any[]) => T, ...args: any[]) {
					const previousDocument = globalThis.document;
					const shell = {
						querySelectorAll: () => [
							{
								dataset: { gameSlug: fixture.slug },
								querySelector: () => ({
									src: `http://127.0.0.1:15273/preview/?game=${fixture.slug}`,
								}),
							},
						],
						querySelector: () => ({
							textContent: `已执行 · {"activeGameSlug":"${fixture.slug}"}`,
						}),
					};
					const preview = {
						querySelectorAll: () => [{}],
						documentElement: { getAttribute: () => "9" },
					};
					(globalThis as any).document = calls.includes("frame")
						? preview
						: shell;
					try {
						return Promise.resolve(script(...args));
					} finally {
						(globalThis as any).document = previousDocument;
					}
				},
				switchToFrame: async () => {
					calls.push("frame");
				},
				switchToParentFrame: async () => {
					calls.push("parent");
				},
			};
			const result = await runWindowsNativePreviewScenario(
				browser,
				fixture,
				Date.now() + 500,
				"http://127.0.0.1:15273",
			);
			expect(result).toEqual(
				expect.objectContaining({
					selectedSlug: fixture.slug,
					canvasCount: 1,
					frameSubmittedValue: "9",
				}),
			);
			expect(calls).toEqual([
				"keys:Control+k",
				"value:input[cmdk-input]:game.switch",
				'click:[cmdk-item][data-value*="game.switch"]',
				`select:#fx-cmdk-slug:value:${fixture.slug}`,
				"click:.fx-cmdk-run",
				'click:[data-testid="vp-play"]',
				"frame",
				"parent",
			]);
			fixture.cleanup();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("fails when the in-app iframe points at another runtime origin", async () => {
		const root = mkdtempSync(join(tmpdir(), "forgeax-native-preview-"));
		try {
			const fixture = prepareNativeDesktopPreviewFixture(root);
			let inFrame = false;
			const element = {
				isExisting: async () => true,
				isDisplayed: async () => true,
				click: async () => {},
				setValue: async () => {},
				selectByAttribute: async () => {},
			};
			const browser = {
				$: async () => element,
				keys: async () => {},
				execute: async (script: Function) => {
					if (script.toString().includes("fx-cmdk-feedback")) return true;
					if (inFrame) return { canvasCount: 1, frameSubmittedValue: "2" };
					return {
						selectedSlug: fixture.slug,
						previewUrl: `http://127.0.0.1:15273/preview/?game=${fixture.slug}`,
					};
				},
				switchToFrame: async () => {
					inFrame = true;
				},
				switchToParentFrame: async () => {},
			};
			await expect(
				runWindowsNativePreviewScenario(
					browser as any,
					fixture,
					Date.now() + 80,
					"http://127.0.0.1:18810",
				),
			).rejects.toThrow("fixture-bound PlaySurface");
			fixture.cleanup();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("bounds a hung WebDriver command by the shared absolute deadline", async () => {
		const root = mkdtempSync(join(tmpdir(), "forgeax-native-preview-"));
		try {
			const fixture = prepareNativeDesktopPreviewFixture(root);
			const browser = { keys: () => new Promise<void>(() => {}) } as any;
			await expect(
				runWindowsNativePreviewScenario(
					browser,
					fixture,
					Date.now() + 20,
					"http://127.0.0.1:15273",
				),
			).rejects.toThrow("Command Palette shortcut exceeded its deadline");
			fixture.cleanup();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("preserves a frame failure when returning from its iframe also fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "forgeax-native-preview-"));
		try {
			const fixture = prepareNativeDesktopPreviewFixture(root);
			let inFrame = false;
			const element = {
				isExisting: async () => true,
				isDisplayed: async () => true,
				click: async () => {},
				setValue: async () => {},
				selectByAttribute: async () => {},
			};
			const browser = {
				$: async () => element,
				keys: async () => {},
				execute: async (script: Function) => {
					if (script.toString().includes("fx-cmdk-feedback")) return true;
					if (inFrame) throw new Error("frame primary failure");
					return {
						selectedSlug: fixture.slug,
						previewUrl: `http://127.0.0.1:15273/preview/?game=${fixture.slug}`,
					};
				},
				switchToFrame: async () => {
					inFrame = true;
				},
				switchToParentFrame: async () => {
					throw new Error("frame teardown failure");
				},
			};
			try {
				await runWindowsNativePreviewScenario(
					browser as any,
					fixture,
					Date.now() + 120,
					"http://127.0.0.1:15273",
				);
				throw new Error("expected native preview scenario to fail");
			} catch (error) {
				expect(error).toBeInstanceOf(AggregateError);
				const errors = (error as AggregateError).errors.map((value) =>
					String(value),
				);
				expect(errors.join("\n")).toContain("frame primary failure");
				expect(errors.join("\n")).toContain("frame teardown failure");
			}
			fixture.cleanup();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("does not call an AX viewport or screenshot a rendered preview on macOS", () => {
		const root = mkdtempSync(join(tmpdir(), "forgeax-native-preview-"));
		try {
			const fixture = prepareNativeDesktopPreviewFixture(root);
			expect(nativePreviewUrl("http://127.0.0.1:18810", fixture)).toBe(
				`http://127.0.0.1:18810/preview/?game=${NATIVE_PREVIEW_GAME_SLUG}`,
			);
			expect(
				assessMacosNativePreview(
					`<AXStaticText>${NATIVE_PREVIEW_GAME_NAME}</AXStaticText><AXGroup>Viewport</AXGroup>`,
					fixture,
					{
						url: nativePreviewUrl("http://127.0.0.1:18810", fixture),
						status: 200,
					},
				),
			).toEqual(
				expect.objectContaining({
					outcome: "unproven",
					selectedThroughUi: true,
					viewportVisible: true,
					previewServiceReached: true,
				}),
			);
			fixture.cleanup();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("opens only the real Mac2 Command Palette shortcut and retains raw AX before/after XML for locator discovery", async () => {
		const root = mkdtempSync(join(tmpdir(), "forgeax-native-preview-"));
		try {
			const fixture = prepareNativeDesktopPreviewFixture(root);
			const calls: unknown[][] = [];
			let reads = 0;
			const browser = {
				getPageSource: async () =>
					++reads === 1
						? "<AXApplication><AXWebView/></AXApplication>"
						: '<AXApplication><AXWebView><AXTextField value="game.switch"/></AXWebView></AXApplication>',
				execute: async (...args: unknown[]) => {
					calls.push(args);
				},
			};
			const result = await probeMacosNativePreviewPalette(
				browser,
				fixture,
				Date.now() + 500,
			);
			expect(result).toEqual(
				expect.objectContaining({
					outcome: "unproven",
					fixtureSlug: fixture.slug,
					beforeSource: "<AXApplication><AXWebView/></AXApplication>",
				}),
			);
			expect(result.paletteSource).toContain("game.switch");
			expect(calls).toEqual([
				["macos: keys", { keys: [{ key: "k", modifierFlags: 16 }] }],
			]);
			fixture.cleanup();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("bounds a hung Mac2 accessibility source operation by the caller deadline", async () => {
		const root = mkdtempSync(join(tmpdir(), "forgeax-native-preview-"));
		try {
			const fixture = prepareNativeDesktopPreviewFixture(root);
			const browser = {
				execute: async () => {},
				getPageSource: () => new Promise<string>(() => {}),
			};
			await expect(
				probeMacosNativePreviewPalette(browser, fixture, Date.now() + 20),
			).rejects.toThrow(
				"macOS native preview Command Palette baseline source exceeded its deadline",
			);
			fixture.cleanup();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
