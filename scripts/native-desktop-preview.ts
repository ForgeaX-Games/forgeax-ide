/**
 * Native-product project/preview evidence shared by the Mac2 and WebView2
 * smoke runners.  It deliberately does not launch a browser or a runtime:
 * the owning runner has already established the product-process receipt and
 * must supply its real native session here.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const NATIVE_PREVIEW_GAME_SLUG = "native-desktop-preview-smoke";
export const NATIVE_PREVIEW_GAME_NAME = "Native desktop preview smoke";
export const NATIVE_PREVIEW_FRAME_ATTRIBUTE = "data-forgeax-frame-submitted";

/** Only a generic AX observation; it is never enough to prove a preview frame. */
export const NATIVE_PREVIEW_UI = {
	viewport: "Viewport",
} as const;

export type NativeDesktopPreviewFixture = {
	readonly projectRoot: string;
	readonly gameRoot: string;
	readonly slug: typeof NATIVE_PREVIEW_GAME_SLUG;
	readonly displayName: typeof NATIVE_PREVIEW_GAME_NAME;
	/** Remove only the game directory created by this helper. */
	readonly cleanup: () => void;
};

/**
 * Create a real user game below the isolated product root.  The entry draws a
 * frame through the engine. macOS selection and rendering proof remain
 * deliberately unproven until a real post-selection AX trace supplies them.
 */
export function prepareNativeDesktopPreviewFixture(
	projectRoot: string,
): NativeDesktopPreviewFixture {
	const root = resolve(projectRoot);
	const gameRoot = join(root, ".forgeax", "games", NATIVE_PREVIEW_GAME_SLUG);
	if (existsSync(gameRoot))
		throw new Error(`native preview fixture already exists: ${gameRoot}`);
	mkdirSync(join(gameRoot, "assets"), { recursive: true });
	writeFileSync(
		join(gameRoot, "forge.json"),
		`${JSON.stringify({
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
		})}\n`,
	);
	writeFileSync(
		join(gameRoot, "assets", "native-desktop-preview.plugin.ts"),
		`import type { Plugin } from '@forgeax/engine-plugin';
import { Camera, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

const nativeDesktopPreviewSmoke: Plugin = {
  name: 'native-desktop-preview-smoke',
  inject: ['world'],
  apply(ctx) {
    ctx.effect(() => {
      const camera = ctx.world.spawn(
        { component: Transform, data: { pos: [0, 0, 5] } },
        { component: Camera, data: { ...perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 }), clearColor: [0.08, 0.22, 0.38, 1] } },
      ).unwrap();
      return () => { void ctx.world.despawn(camera); };
    });
  },
};

export default nativeDesktopPreviewSmoke;
`,
	);
	return {
		projectRoot: root,
		gameRoot,
		slug: NATIVE_PREVIEW_GAME_SLUG,
		displayName: NATIVE_PREVIEW_GAME_NAME,
		cleanup: () =>
			rmSync(gameRoot, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 50,
			}),
	};
}

/**
 * Bounded Mac2 discovery only. The installed Mac2 4.3.5 driver exposes this
 * as `execute('macos: keys', { keys })`; it is not WebdriverIO's browser.keys
 * command. Do not promote a discovery result to rendering evidence.
 */
export type MacosPreviewProbeBrowser = {
	getPageSource(): Promise<string>;
	execute(
		command: "macos: keys",
		args: {
			readonly keys: readonly (
				| { readonly key: string; readonly modifierFlags?: number }
				| string
			)[];
		},
	): Promise<unknown>;
};

export type MacosPreviewProbe = {
	readonly outcome: "unproven";
	readonly fixtureSlug: string;
	readonly beforeSource: string;
	readonly paletteSource: string;
	readonly nextStep: string;
};

/**
 * Opens the real Command Palette once and preserves before/after AX XML for
 * the owner to derive exact, observed locators. It intentionally stops before
 * filtering, selecting, or pressing Play: those projections have not yet been
 * captured from the signed app and source text alone is not selection proof.
 */
export async function probeMacosNativePreviewPalette(
	browser: MacosPreviewProbeBrowser,
	fixture: NativeDesktopPreviewFixture,
	deadline: number,
): Promise<MacosPreviewProbe> {
	const beforeSource = await withinMacosPreviewDeadline(
		deadline,
		"Command Palette baseline source",
		browser.getPageSource(),
	);
	await withinMacosPreviewDeadline(
		deadline,
		"Command Palette shortcut",
		browser.execute("macos: keys", {
			keys: [{ key: "k", modifierFlags: 1 << 4 }], // XCUIKeyModifierFlags.command
		}),
	);
	const paletteSource = await withinMacosPreviewDeadline(
		deadline,
		"Command Palette post-shortcut source",
		browser.getPageSource(),
	);
	return {
		outcome: "unproven",
		fixtureSlug: fixture.slug,
		beforeSource,
		paletteSource,
		nextStep:
			"Capture exact AX nodes after filtering game.switch, choosing this slug, and clicking Play. A rendered oracle additionally needs one observed visible node that structurally binds games/<slug> to a changed positive PlaySurface FPS; generic Viewport/FPS, iframe nodes, and screenshots are insufficient.",
	};
}

export type WindowsPreviewDom = {
	readonly activeGameText: string;
	readonly viewportVisible: boolean;
	readonly canvasCount: number;
	readonly frameSubmittedValue: string | null;
};

export type WindowsPreviewEvidence = WindowsPreviewDom & {
	readonly outcome: "rendered";
};

type WindowsDomElement = {
	isExisting(): Promise<boolean>;
	isDisplayed(): Promise<boolean>;
	click(): Promise<void>;
	setValue(value: string): Promise<void>;
	selectByAttribute(attribute: string, value: string): Promise<void>;
};

/** The WebView2 operations used by the visible Command Palette and viewport. */
export type WindowsPreviewBrowser = {
	$(selector: string): Promise<WindowsDomElement>;
	keys(value: string | readonly string[]): Promise<void>;
	execute<Args extends unknown[], Result>(
		script: (...args: Args) => Result,
		...args: Args
	): Promise<Result>;
	switchToFrame(element: WindowsDomElement): Promise<void>;
	switchToParentFrame(): Promise<void>;
};

export type WindowsNativePreviewScenario = {
	readonly selectedSlug: string;
	readonly previewUrl: string;
	readonly canvasCount: number;
	readonly frameSubmittedValue: string | null;
	readonly evidence: WindowsPreviewEvidence;
};

async function waitForWindowsPreview<T>(
	deadline: number,
	phase: string,
	read: () => Promise<T | undefined>,
): Promise<T> {
	while (Date.now() < deadline) {
		const value = await withinWindowsPreviewDeadline(deadline, phase, read());
		if (value !== undefined) return value;
		await withinWindowsPreviewDeadline(
			deadline,
			phase,
			sleep(Math.min(50, Math.max(1, deadline - Date.now()))),
		);
	}
	throw new Error(
		`Windows native preview ${phase} did not complete before deadline`,
	);
}

/** Every WebDriver command shares the runner's absolute deadline. */
async function withinWindowsPreviewDeadline<T>(
	deadline: number,
	phase: string,
	operation: Promise<T>,
): Promise<T> {
	const remaining = deadline - Date.now();
	if (remaining <= 0)
		throw new Error(`Windows native preview deadline elapsed before ${phase}`);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<T>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(
								`Windows native preview ${phase} exceeded its deadline`,
							),
						),
					remaining,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Mac2 calls use the same absolute-deadline race as WebView2 calls. */
async function withinMacosPreviewDeadline<T>(
	deadline: number,
	phase: string,
	operation: Promise<T>,
): Promise<T> {
	const remaining = deadline - Date.now();
	if (remaining <= 0)
		throw new Error(`macOS native preview deadline elapsed before ${phase}`);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<T>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(`macOS native preview ${phase} exceeded its deadline`),
						),
					remaining,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Select the fixture through the visible Command Palette (`Ctrl+K` →
 * `game.switch` → slug dropdown → execute), then drive the real in-app Play
 * control and switch WebDriver into the resulting game iframe. It never accepts
 * a canvas in the shell document: the iframe URL and its `game` query bind it
 * to this fixture.
 *
 * `game.open` is a command-bus-only entry and is not listed by CommandPalette,
 * whose source is ActionRegistry. `game.switch` is the product's visible action
 * with a server-backed existing-game dropdown and the same setActiveGame path.
 */
export async function runWindowsNativePreviewScenario(
	browser: WindowsPreviewBrowser,
	fixture: NativeDesktopPreviewFixture,
	deadline: number,
	expectedRuntimeOrigin: string,
): Promise<WindowsNativePreviewScenario> {
	const expected = new URL(expectedRuntimeOrigin);
	if (
		expected.origin !== expectedRuntimeOrigin ||
		expected.pathname !== "/" ||
		expected.search ||
		expected.hash
	)
		throw new Error(
			"Windows native preview expected runtime origin must be an origin",
		);
	await withinWindowsPreviewDeadline(
		deadline,
		"Command Palette shortcut",
		browser.keys(["Control", "k"]),
	);
	const search = await waitForWindowsPreview(
		deadline,
		"Command Palette search field",
		async () => {
			const input = await withinWindowsPreviewDeadline(
				deadline,
				"Command Palette search field lookup",
				browser.$("input[cmdk-input]"),
			);
			return await withinWindowsPreviewDeadline(
				deadline,
				"Command Palette search field visibility",
				Promise.all([input.isExisting(), input.isDisplayed()]),
			).then(([existing, displayed]) =>
				existing && displayed ? input : undefined,
			);
		},
	);
	await withinWindowsPreviewDeadline(
		deadline,
		"game.switch search entry",
		search.setValue("game.switch"),
	);
	const switchGame = await waitForWindowsPreview(
		deadline,
		"game.switch command",
		async () => {
			const item = await withinWindowsPreviewDeadline(
				deadline,
				"game.switch command lookup",
				browser.$('[cmdk-item][data-value*="game.switch"]'),
			);
			return await withinWindowsPreviewDeadline(
				deadline,
				"game.switch command visibility",
				Promise.all([item.isExisting(), item.isDisplayed()]),
			).then(([existing, displayed]) =>
				existing && displayed ? item : undefined,
			);
		},
	);
	await withinWindowsPreviewDeadline(
		deadline,
		"game.switch command click",
		switchGame.click(),
	);
	const slugSelect = await waitForWindowsPreview(
		deadline,
		"existing-game slug dropdown",
		async () => {
			const select = await withinWindowsPreviewDeadline(
				deadline,
				"existing-game slug dropdown lookup",
				browser.$("#fx-cmdk-slug"),
			);
			return await withinWindowsPreviewDeadline(
				deadline,
				"existing-game slug dropdown visibility",
				Promise.all([select.isExisting(), select.isDisplayed()]),
			).then(([existing, displayed]) =>
				existing && displayed ? select : undefined,
			);
		},
	);
	await withinWindowsPreviewDeadline(
		deadline,
		"fixture slug selection",
		slugSelect.selectByAttribute("value", fixture.slug),
	);
	const execute = await withinWindowsPreviewDeadline(
		deadline,
		"Command Palette execute button lookup",
		browser.$(".fx-cmdk-run"),
	);
	const executeVisible = await withinWindowsPreviewDeadline(
		deadline,
		"Command Palette execute button visibility",
		Promise.all([execute.isExisting(), execute.isDisplayed()]),
	);
	if (!executeVisible[0] || !executeVisible[1])
		throw new Error(
			"Windows native preview could not expose the Command Palette execute button",
		);
	await withinWindowsPreviewDeadline(
		deadline,
		"fixture selection execution",
		execute.click(),
	);
	await waitForWindowsPreview(
		deadline,
		"fixture selection acknowledgement",
		async () =>
			await browser.execute((slug: string) => {
				const feedback =
					document.querySelector(".fx-cmdk-feedback--ok")?.textContent ?? "";
				return feedback.includes(slug) ? true : undefined;
			}, fixture.slug),
	);

	const play = await withinWindowsPreviewDeadline(
		deadline,
		"in-app Play control lookup",
		browser.$('[data-testid="vp-play"]'),
	);
	const playVisible = await withinWindowsPreviewDeadline(
		deadline,
		"in-app Play control visibility",
		Promise.all([play.isExisting(), play.isDisplayed()]),
	);
	if (!playVisible[0] || !playVisible[1])
		throw new Error(
			"Windows native preview could not expose the in-app Play control",
		);
	await withinWindowsPreviewDeadline(
		deadline,
		"in-app Play control click",
		play.click(),
	);

	const outer = await waitForWindowsPreview(
		deadline,
		"fixture-bound PlaySurface",
		async () => {
			const observed = await withinWindowsPreviewDeadline(
				deadline,
				"fixture-bound PlaySurface inspection",
				browser.execute((slug: string) => {
					const gameSurface = Array.from(
						document.querySelectorAll<HTMLElement>("[data-game-slug]"),
					).find((element) => element.dataset.gameSlug === slug);
					const frame = gameSurface?.querySelector<HTMLIFrameElement>(
						"iframe.preview-iframe, iframe.preview-iframe-mobile",
					);
					return gameSurface && frame
						? {
								selectedSlug: gameSurface.dataset.gameSlug ?? "",
								previewUrl: frame.src,
							}
						: undefined;
				}, fixture.slug),
			);
			if (!observed) return undefined;
			const url = new URL(observed.previewUrl);
			return url.origin === expected.origin &&
				url.pathname === "/preview/" &&
				url.searchParams.get("game") === fixture.slug
				? observed
				: undefined;
		},
	);

	const frame = await withinWindowsPreviewDeadline(
		deadline,
		"fixture preview iframe lookup",
		browser.$(`iframe[title="game preview: ${fixture.slug}"]`),
	);
	const frameVisible = await withinWindowsPreviewDeadline(
		deadline,
		"fixture preview iframe visibility",
		Promise.all([frame.isExisting(), frame.isDisplayed()]),
	);
	if (!frameVisible[0] || !frameVisible[1])
		throw new Error(
			`Windows native preview iframe for ${fixture.slug} is not visible`,
		);
	await withinWindowsPreviewDeadline(
		deadline,
		"fixture preview iframe switch",
		browser.switchToFrame(frame),
	);
	let primary: unknown;
	let result: WindowsNativePreviewScenario | undefined;
	try {
		const dom = await waitForWindowsPreview(
			deadline,
			"submitted game frame",
			async () => {
				const observed = await withinWindowsPreviewDeadline(
					deadline,
					"submitted game frame inspection",
					browser.execute(
						(attribute: string) => ({
							canvasCount: document.querySelectorAll("#app > canvas").length,
							frameSubmittedValue:
								document.documentElement.getAttribute(attribute),
						}),
						NATIVE_PREVIEW_FRAME_ATTRIBUTE,
					),
				);
				return observed.canvasCount > 0 &&
					frameSubmissionIsReady(observed.frameSubmittedValue)
					? observed
					: undefined;
			},
		);
		const evidence = assessWindowsNativePreview(
			{
				activeGameText: outer.selectedSlug,
				viewportVisible: true,
				canvasCount: dom.canvasCount,
				frameSubmittedValue: dom.frameSubmittedValue,
			},
			fixture,
		);
		result = { ...outer, ...dom, evidence };
	} catch (error) {
		primary = error;
	}
	let teardown: unknown;
	try {
		await withinWindowsPreviewDeadline(
			deadline,
			"fixture preview iframe teardown",
			browser.switchToParentFrame(),
		);
	} catch (error) {
		teardown = error;
	}
	if (primary && teardown)
		throw new AggregateError(
			[primary, teardown],
			"Windows native preview frame operation and teardown failed",
		);
	if (primary) throw primary;
	if (teardown) throw teardown;
	if (!result) throw new Error("Windows native preview produced no result");
	return result;
}

/** Same native WebView2 document: no standalone Chromium or synthetic canvas. */
export function assessWindowsNativePreview(
	dom: WindowsPreviewDom,
	fixture: NativeDesktopPreviewFixture,
): WindowsPreviewEvidence {
	const missing: string[] = [];
	if (
		!dom.activeGameText.includes(fixture.displayName) &&
		!dom.activeGameText.includes(fixture.slug)
	)
		missing.push(`active fixture ${fixture.slug}`);
	if (!dom.viewportVisible) missing.push("visible Viewport");
	if (dom.canvasCount < 1) missing.push("viewport canvas");
	if (!frameSubmissionIsReady(dom.frameSubmittedValue))
		missing.push(`${NATIVE_PREVIEW_FRAME_ATTRIBUTE} positive safe-integer`);
	if (missing.length)
		throw new Error(
			`Windows native preview was not proven: ${missing.join(", ")}`,
		);
	return { ...dom, outcome: "rendered" };
}

export function frameSubmissionIsReady(value: unknown): value is string {
	if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return false;
	return Number.isSafeInteger(Number(value));
}

/** The product runtime endpoint that must serve this selected game. */
export function nativePreviewUrl(
	publicOrigin: string,
	fixture: NativeDesktopPreviewFixture,
): string {
	const origin = new URL(publicOrigin);
	if (
		origin.origin !== publicOrigin ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.hash
	) {
		throw new Error("native preview public origin must be an origin");
	}
	return `${publicOrigin}/preview/?game=${encodeURIComponent(fixture.slug)}`;
}

export type NativePreviewServiceSession = {
	/** Observed from a real runtime fetch, never inferred from a screenshot. */
	readonly url: string;
	readonly status: number;
};

export type MacosPreviewEvidence = {
	readonly outcome: "unproven";
	readonly selectedThroughUi: boolean;
	readonly viewportVisible: boolean;
	readonly previewServiceReached: boolean;
	readonly nextStep: string;
};

/**
 * Mac2 exposes native accessibility, not the WebView DOM.  A visible viewport
 * or a saved screenshot has no renderer-submission semantics, so this function
 * deliberately never upgrades such evidence to rendered.
 */
export function assessMacosNativePreview(
	accessibilitySource: string,
	fixture: NativeDesktopPreviewFixture,
	service: NativePreviewServiceSession,
): MacosPreviewEvidence {
	const target = new URL(service.url);
	if (
		target.pathname !== "/preview/" ||
		target.searchParams.get("game") !== fixture.slug ||
		service.status < 200 ||
		service.status >= 300
	) {
		throw new Error(
			`macOS native preview service did not serve ${fixture.slug}: ${service.status} ${service.url}`,
		);
	}
	return {
		outcome: "unproven",
		selectedThroughUi:
			accessibilitySource.includes(fixture.displayName) ||
			accessibilitySource.includes(fixture.slug),
		viewportVisible: accessibilitySource.includes(NATIVE_PREVIEW_UI.viewport),
		previewServiceReached: true,
		nextStep: `Capture the post-selection/post-Play AX structure. A future oracle needs one visible container that binds games/${fixture.slug} to a positive FPS whose value changes between snapshots; screenshots, iframe nodes, generic Viewport/FPS nodes, and ${NATIVE_PREVIEW_FRAME_ATTRIBUTE} (a DOM-only attribute) cannot prove rendering through Mac2.`,
	};
}
