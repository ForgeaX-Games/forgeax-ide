import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import transport from "../../release/transport-contract.v1.json";
import { DESKTOP_TASKKILL_TIMEOUT_MS } from "../../scripts/desktop-process-tree";
import {
	desktopStableAgentHostDirectory,
	desktopStableAgentHostSocket,
} from "../../scripts/desktop-runtime-layout";
import {
	MACOS_DMG_CREATE_RETRY_DELAYS_MS,
	MACOS_HDIUTIL_TIMEOUT_MS,
	macosBunSidecarPath,
	macosDmgCreateArgs,
	outerAdHocSignArgs,
	runMacosDmgCreate,
	runMacosDmgVerify,
} from "../../scripts/finalize-macos-bundle";
import {
	assessLauncherShutdown,
	catalogHasExpectedGuids,
	classifyConsoleMessage,
	cleanupOperationDeadline,
	deadlineRemaining,
	expectedPackGuids,
	FRAME_SUBMISSION_POLL_INTERVAL_MS,
	formatPreviewWaitFailure,
	frameSubmissionIsReady,
	isAllowedBrowserWarning,
	jsonPackGuid,
	observePreviewResponse,
	PREVIEW_CANVAS_SELECTOR,
	PREVIEW_DOM_DIAGNOSTICS_TIMEOUT_MS,
	PREVIEW_FRAME_SUBMITTED_ATTRIBUTE,
	previewRequiredPaths,
	previewUrl,
	requireDeadlineRemaining,
	scriptablePackGuid,
	serializeConsoleDiagnostic,
	verifyPreviewPostReadiness,
	waitForFrameSubmission,
} from "../../scripts/smoke-assembled-desktop-runtime";
import {
	fetchBounded,
	type SidecarManifest,
	validateSidecar,
	validateTrustedReleaseUrl,
} from "../../scripts/stage-release-sidecar";

import { hasRequiredBunVendorSignature } from "../../scripts/verify-macos-bundle";
import {
	expectCodeContains,
	expectCodeNotContains,
} from "../helpers/code-token-assertions";

// These operations exercise the packaged Bun runtime's real import scanner.
// Keep the test runner on Node and preserve the production parser semantics.
function runRuntime<T>(module: string, operation: string, args: unknown[]): T {
	return JSON.parse(
		execFileSync(
			"bun",
			[
				"-e",
				"const module = await import(process.argv[1]); console.log(JSON.stringify(await module[process.argv[2]](...JSON.parse(process.argv[3])) ?? null));",
				join(import.meta.dirname, "../../scripts", module),
				operation,
				JSON.stringify(args),
			],
			{ encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"] },
		),
	);
}
const materializeDesktopEngineRootFiles = (
	source: string,
	destination: string,
) =>
	runRuntime("desktop-runtime-layout.ts", "materializeDesktopEngineRootFiles", [
		source,
		destination,
	]);
const desktopEngineConfigImportErrors = (root: string) =>
	runRuntime<string[]>(
		"desktop-runtime-layout.ts",
		"desktopEngineConfigImportErrors",
		[root],
	);
const assertDesktopEngineConfigImportClosure = (root: string) =>
	runRuntime(
		"desktop-runtime-layout.ts",
		"assertDesktopEngineConfigImportClosure",
		[root],
	);
const validateDesktopResources: typeof import("../../scripts/validate-desktop-resources").validateDesktopResources =
	(...args) =>
		runRuntime(
			"validate-desktop-resources.ts",
			"validateDesktopResources",
			args,
		);

const bytes = new Uint8Array(1_048_576).fill(7);
bytes.set([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 0x01], 0);
const digest = createHash("sha256").update(bytes).digest("hex");
const manifest: SidecarManifest = {
	schema: "forgeax-server-release-candidate/v1",
	service: "forgeax-server",
	version: "0.1.0",
	artifacts: transport.platforms.map((platform) => ({
		platform: platform.logicalId as "macos-arm64" | "macos-x64" | "windows-x64",
		targetTriple: platform.targetTriple,
		url: `https://github.com/ForgeaX-Games/forgeax-server/releases/download/server-v0.1.0/server-${platform.logicalId}.bin`,
		sha256: digest,
		size: bytes.byteLength,
	})),
};

describe("production desktop resources", () => {
	test("polls frame submission with the default timer until a frame arrives", async () => {
		vi.useFakeTimers();
		try {
			const read = vi.fn().mockResolvedValueOnce("0").mockResolvedValue("7");
			const result = expect(
				waitForFrameSubmission(read, Date.now() + 1_000),
			).resolves.toBe("7");
			await vi.advanceTimersByTimeAsync(FRAME_SUBMISSION_POLL_INTERVAL_MS);
			await result;
			expect(read).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	test("retains nested renderer causes in browser console diagnostics", () => {
		const cause = Object.assign(new Error("shader validation failed"), {
			code: "shader-invalid",
		});
		const error = Object.assign(
			new Error("device-operation-failed", { cause }),
			{
				detail: { operation: "draw", cause },
			},
		);
		const diagnostic = serializeConsoleDiagnostic(error);
		expect(diagnostic).toContain("shader-invalid");
		expect(diagnostic).toContain("shader validation failed");
		expect(diagnostic).toContain("draw");
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(serializeConsoleDiagnostic(cyclic)).toContain("[circular]");
	});
	test("materializes every regular packaged Engine root file and closes the real config imports", () => {
		const root = mkdtempSync(join(tmpdir(), "ide-engine-workspace-"));
		const source = join(root, "resources/engine");
		const destination = join(root, "runtime/engine");
		mkdirSync(source, { recursive: true });
		mkdirSync(destination, { recursive: true });
		writeFileSync(join(destination, "stale-root-file.mjs"), "stale");
		for (const entry of ["index.html", "tsconfig.json"])
			writeFileSync(join(source, entry), `source:${entry}`);
		writeFileSync(join(source, "package.json"), "{}");
		writeFileSync(
			join(source, "vite.config.ts"),
			[
				"import { defineConfig } from 'vite';",
				"import './engine-vite-preset.mjs';",
				"import './future-helper.mjs';",
				"// import './comment-only-helper.mjs';",
				"const text = \"import './string-only-helper.mjs'\";",
				"export default defineConfig({});",
			].join("\n"),
		);
		writeFileSync(join(source, "engine-vite-preset.mjs"), "export {};");
		writeFileSync(join(source, "future-helper.mjs"), "export {};");
		mkdirSync(join(source, "not-a-root-file"), { recursive: true });
		writeFileSync(join(source, "not-a-root-file", "nested.txt"), "nested");

		materializeDesktopEngineRootFiles(source, destination);

		expect(readFileSync(join(destination, "future-helper.mjs"), "utf8")).toBe(
			"export {};",
		);
		expect(existsSync(join(destination, "rhi-debug-config.ts"))).toBe(false);
		expect(existsSync(join(destination, "stale-root-file.mjs"))).toBe(false);
		expect(existsSync(join(destination, "not-a-root-file"))).toBe(false);
		expect(desktopEngineConfigImportErrors(destination)).toEqual([]);
		expect(() =>
			assertDesktopEngineConfigImportClosure(destination),
		).not.toThrow();
		rmSync(root, { recursive: true, force: true });
	});

	test("fails closed for a missing source or a missing config import", () => {
		const root = mkdtempSync(join(tmpdir(), "ide-engine-workspace-"));
		const source = join(root, "resources/engine");
		const destination = join(root, "runtime/engine");
		expect(() =>
			materializeDesktopEngineRootFiles(source, destination),
		).toThrow("packaged Engine source is missing");
		mkdirSync(source, { recursive: true });
		writeFileSync(join(source, "package.json"), "{}");
		writeFileSync(
			join(source, "vite.config.ts"),
			"import './future-helper.mjs';",
		);
		expect(() =>
			materializeDesktopEngineRootFiles(source, destination),
		).toThrow("engine/index.html");
		writeFileSync(join(source, "index.html"), "");
		writeFileSync(join(source, "tsconfig.json"), "{}");
		expect(() =>
			materializeDesktopEngineRootFiles(source, destination),
		).toThrow("future-helper.mjs");
		rmSync(root, { recursive: true, force: true });
	});

	test("consumes producer-owned Engine artifacts instead of copying producer internals", () => {
		const artifacts = readFileSync(
			join(import.meta.dirname, "../../scripts/runtime-artifacts.ts"),
			"utf8",
		);
		expectCodeContains(
			artifacts,
			"composeEngineCommonArtifacts(engineCommon, engine)",
		);
		expectCodeContains(
			artifacts,
			"composeEngineTargetArtifact(engineTarget, platform, engine)",
		);
		expectCodeNotContains(artifacts, "stageEngineDependencyClosure");
	});

	test("materializes the verified common Web artifact without rebuilding it per target", () => {
		const artifacts = readFileSync(
			join(import.meta.dirname, "../../scripts/runtime-artifacts.ts"),
			"utf8",
		);
		const baseConfig = JSON.parse(
			readFileSync(
				join(import.meta.dirname, "../../src-tauri/tauri.conf.json"),
				"utf8",
			),
		) as any;
		const releaseConfig = JSON.parse(
			readFileSync(
				join(import.meta.dirname, "../../src-tauri/tauri.release.conf.json"),
				"utf8",
			),
		) as any;
		expectCodeContains(artifacts, "argument('--web-common')");
		expectCodeContains(
			artifacts,
			"materializeWebArtifact(webCommon, join(payload, 'interface/dist'))",
		);
		expectCodeNotContains(artifacts, "run(['run', 'build:web'])");
		expect(baseConfig.build.beforeBuildCommand).toBe("bun run prepare:desktop");
		expect(releaseConfig.build).toEqual({
			beforeBuildCommand: null,
			frontendDist: "../dist",
		});
	});

	test("smokes the built bundle without loading the source Vite configuration", () => {
		const smoke = readFileSync(
			join(import.meta.dirname, "../../scripts/smoke-production-bundle.mjs"),
			"utf8",
		);
		const manifest = JSON.parse(
			readFileSync(join(import.meta.dirname, "../../package.json"), "utf8"),
		) as { scripts: Record<string, string> };
		expect(manifest.scripts["smoke:production-bundle"]).toBe(
			"node scripts/smoke-production-bundle.mjs",
		);
		expectCodeContains(
			smoke,
			"const server = createServer(async (request, response) =>",
		);
		expectCodeContains(
			smoke,
			"const indexPath = resolve(distRoot, 'index.html')",
		);
		expectCodeContains(smoke, "process.platform === 'win32'");
		expectCodeContains(smoke, "'msedge.exe'");
		expectCodeNotContains(smoke, "'vite',");
		expectCodeNotContains(smoke, "Bun.spawn(");
	});

	test("smokes the assembled desktop runtime with real sidecar resources and authoritative packs", () => {
		const smoke = readFileSync(
			join(
				import.meta.dirname,
				"../../scripts/smoke-assembled-desktop-runtime.ts",
			),
			"utf8",
		);
		const manifest = JSON.parse(
			readFileSync(join(import.meta.dirname, "../../package.json"), "utf8"),
		) as { scripts: Record<string, string> };
		expect(manifest.scripts["smoke:desktop-runtime"]).toBe(
			"bun run scripts/smoke-assembled-desktop-runtime.ts",
		);
		expectCodeContains(
			smoke,
			"join(resourceRoot, 'runtime/local-runtime.mjs')",
		);
		expectCodeContains(
			smoke,
			"join(resourceRoot, 'sidecars', `bun-$" + "{triple}$" + "{extension}`)",
		);
		expectCodeContains(smoke, "FORGEAX_RUNTIME_STATE_FILE: stateFile");
		expectCodeContains(smoke, "'assets', 'material.pack.json'");
		expectCodeContains(smoke, "'assets', 'desktop-smoke.pack.ts'");
		expectCodeContains(smoke, "method: 'PUT'");
		expectCodeContains(
			smoke,
			"fetchWithinSmokeBudget(state.publicOrigin + '/api/projects/active'",
		);
		expectCodeContains(smoke, "state.publicOrigin");
		expectCodeContains(smoke, "authority !== 'authoritative'");
		expectCodeContains(smoke, "catalogUrl");
		expectCodeContains(smoke, "if (import.meta.main) await runSmoke()");
		// These imports are embedded in the generated fixture, not TypeScript source.
		expect(smoke).toContain(
			"import type { Plugin } from '@forgeax/engine-plugin'",
		);
		expect(smoke).toContain(
			"import { Camera, perspective } from '@forgeax/engine-render'",
		);
		expect(smoke).toContain(
			"import { Transform } from '@forgeax/engine-scene'",
		);
		expectCodeContains(smoke, "PREVIEW_CANVAS_SELECTOR = '#app > canvas'");
		expectCodeContains(smoke, "locator(PREVIEW_CANVAS_SELECTOR)");
		expectCodeNotContains(smoke, "canvas#app");
		expectCodeContains(smoke, "formatPreviewWaitFailure");
		expect(smoke).toContain("page errors and classified console failures");
		expect(smoke).toContain("observed required paths");
		expectCodeContains(smoke, "PREVIEW_DOM_DIAGNOSTICS_TIMEOUT_MS");
		expect(smoke).toContain("first frame submission readiness");
		expect(smoke).toContain("preview post-readiness verification");
		expectCodeContains(smoke, "waitForFrameSubmission");
		expectCodeContains(smoke, "verifyPreviewPostReadiness");
		expectCodeContains(smoke, "document.documentElement.getAttribute");
		expect(smoke).toContain("first frame submission readiness polling");
		expectCodeNotContains(smoke, "waitForFunction");
		expectCodeNotContains(smoke, "__forgeaxPreviewInspection");
		expectCodeNotContains(smoke, "renderer health");
		expectCodeContains(smoke, "page!.close()");
		expectCodeContains(smoke, "context!.close()");
		expectCodeContains(smoke, "browser!.close()");
		expectCodeContains(smoke, "child.stdin.write('shutdown\\n')");
		expectCodeContains(smoke, "if (process.platform === 'win32')");
		expectCodeContains(
			smoke,
			"input.child.kill(process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM')",
		);
		expectCodeContains(smoke, "forced = true");
		expectCodeNotContains(smoke, "18810");
		expectCodeNotContains(smoke, "15273");
	});

	test("keeps assembled preview smoke observations and failure classification behavioral", async () => {
		expect(PREVIEW_CANVAS_SELECTOR).toBe("#app > canvas");
		expect(PREVIEW_DOM_DIAGNOSTICS_TIMEOUT_MS).toBe(2_000);
		expect(expectedPackGuids).toEqual([jsonPackGuid, scriptablePackGuid]);
		expect(previewUrl("http://127.0.0.1:18810")).toBe(
			"http://127.0.0.1:18810/preview/?game=legacy-material-smoke",
		);
		expect(() => previewUrl("http://127.0.0.1:18810/preview")).toThrow(
			"must be an origin",
		);

		const observed = new Set<string>();
		for (const path of previewRequiredPaths()) {
			expect(
				observePreviewResponse(
					{ url: `http://127.0.0.1:18810${path}?cache=1`, status: 200 },
					observed,
				),
			).toBeUndefined();
		}
		expect([...observed]).toEqual([...previewRequiredPaths()]);
		expect(
			observePreviewResponse(
				{
					url: "http://127.0.0.1:18810/preview/shaders/manifest.json",
					status: 503,
				},
				observed,
			),
		).toContain("503");

		expect(
			classifyConsoleMessage("error", "[engine] createApp failed"),
		).toContain("createApp failure");
		expect(
			classifyConsoleMessage(
				"log",
				"[engine] loadGame: module-not-found — using fallback",
			),
		).toContain("module failure");
		expect(
			isAllowedBrowserWarning(
				"WebGPU is unavailable; falling back to SwiftShader",
			),
		).toBe(true);
		expect(
			isAllowedBrowserWarning(
				"WebGPU shader import failed; falling back to SwiftShader",
			),
		).toBe(false);
		expect(
			classifyConsoleMessage(
				"warning",
				"WebGPU shader import failed; falling back to SwiftShader",
			),
		).toContain("shader failure");
		expect(
			classifyConsoleMessage("warning", "unrelated browser warning"),
		).toBeUndefined();
		expect(classifyConsoleMessage("log", "shader compiled")).toBeUndefined();
		expect(classifyConsoleMessage("warning", "renderer ready")).toBeUndefined();
		expect(
			classifyConsoleMessage("error", "renderer initialization failed"),
		).toContain("renderer failure");
		expect(PREVIEW_FRAME_SUBMITTED_ATTRIBUTE).toBe(
			"data-forgeax-frame-submitted",
		);
		expect(frameSubmissionIsReady("1")).toBe(true);
		expect(frameSubmissionIsReady("9007199254740991")).toBe(true);
		for (const value of [
			"",
			"0",
			"-1",
			"0x1",
			"1e0",
			"+1",
			"01",
			" 1 ",
			"1 ",
			" 1",
			"1.5",
			"9007199254740992",
			"not-a-frame",
			null,
			1,
		])
			expect(frameSubmissionIsReady(value)).toBe(false);
		expect(frameSubmissionIsReady(undefined)).toBe(false);

		const polledValues: unknown[] = [
			undefined,
			"0",
			"0x1",
			"1e0",
			"+1",
			"01",
			" 1 ",
			"9007199254740991",
		];
		let reads = 0;
		expect(
			await waitForFrameSubmission(
				async () => polledValues[reads++],
				Date.now() + 1_000,
				async () => undefined,
			),
		).toBe("9007199254740991");
		expect(reads).toBe(polledValues.length);
		expect(FRAME_SUBMISSION_POLL_INTERVAL_MS).toBe(50);

		const readFailure = new Error("attribute read failed");
		await expect(
			waitForFrameSubmission(
				async () => {
					throw readFailure;
				},
				Date.now() + 1_000,
				async () => undefined,
			),
		).rejects.toBe(readFailure);

		const sleepStarted = Date.now();
		await expect(
			waitForFrameSubmission(
				async () => undefined,
				sleepStarted + 25,
				async () => new Promise<void>(() => undefined),
			),
		).rejects.toThrow(
			"first frame submission readiness polling exceeded its deadline",
		);
		expect(Date.now() - sleepStarted).toBeLessThan(500);

		const requiredPaths = previewRequiredPaths();
		let serialized = false;
		await expect(
			verifyPreviewPostReadiness({
				serializeFrame: async () => {
					serialized = true;
					return '"1"';
				},
				failures: [],
				observedPaths: requiredPaths,
				requiredPaths,
			}),
		).resolves.toBeUndefined();
		expect(serialized).toBe(true);
		const serializationFailure = new Error("json serialization failed");
		await expect(
			verifyPreviewPostReadiness({
				serializeFrame: async () => {
					throw serializationFailure;
				},
				failures: [],
				observedPaths: requiredPaths,
				requiredPaths,
			}),
		).rejects.toBe(serializationFailure);
		await expect(
			verifyPreviewPostReadiness({
				serializeFrame: async () => undefined,
				failures: [],
				observedPaths: requiredPaths,
				requiredPaths,
			}),
		).rejects.toThrow("serialization returned undefined");
		await expect(
			verifyPreviewPostReadiness({
				serializeFrame: async () => '"1"',
				failures: ["page error: boot failed"],
				observedPaths: requiredPaths,
				requiredPaths,
			}),
		).rejects.toThrow("page or console failures");
		await expect(
			verifyPreviewPostReadiness({
				serializeFrame: async () => '"1"',
				failures: [],
				observedPaths: ["/preview/"],
				requiredPaths,
			}),
		).rejects.toThrow("required preview paths missing");

		const diagnostics = formatPreviewWaitFailure({
			phase: "first frame submission readiness",
			cause: new Error("deadline exceeded"),
			failures: [
				"page error (console error): boot failed",
				"renderer failure: initialization failed",
			],
			observedPaths: ["/preview/"],
			requiredPaths: previewRequiredPaths(),
			dom: {
				currentUrl:
					"http://127.0.0.1:15273/preview/?game=legacy-material-smoke",
				appExists: true,
				canvasCount: 0,
				frameSubmittedValue: "0",
			},
		});
		expect(diagnostics).toContain("deadline exceeded");
		expect(diagnostics).toContain("boot failed");
		expect(diagnostics).toContain("renderer failure: initialization failed");
		expect(diagnostics).toContain("/preview/");
		expect(diagnostics).toContain("/preview/src/main.ts");
		expect(diagnostics).toContain(
			"http://127.0.0.1:15273/preview/?game=legacy-material-smoke",
		);
		expect(diagnostics).toContain("#app exists: true");
		expect(diagnostics).toContain("#app > canvas count: 0");
		expect(diagnostics).toContain("observed data-forgeax-frame-submitted: 0");

		expect(
			catalogHasExpectedGuids({
				authority: "authoritative",
				entries: [
					{ guid: jsonPackGuid },
					{ guid: scriptablePackGuid },
					{ guid: "other" },
				],
			}),
		).toBe(true);
		expect(
			catalogHasExpectedGuids({
				authority: "authoritative",
				entries: [{ guid: jsonPackGuid }],
			}),
		).toBe(false);
	});

	test("bounds assembled smoke work and requires a clean launcher terminal state", () => {
		expect(deadlineRemaining(5_000, 1_000)).toBe(4_000);
		expect(deadlineRemaining(5_000, 6_000)).toBe(0);
		expect(requireDeadlineRemaining(5_000, "renderer", 4_999)).toBe(1);
		expect(() => requireDeadlineRemaining(5_000, "renderer", 5_000)).toThrow(
			"renderer",
		);

		const stopped = assessLauncherShutdown({
			exited: true,
			forced: false,
			exitCode: 0,
			signalCode: null,
			terminalState: { status: "stopped" },
		});
		expect(stopped).toEqual({ ok: true, errors: [] });

		const nonZero = assessLauncherShutdown({
			exited: true,
			forced: false,
			exitCode: 1,
			signalCode: null,
			terminalState: { status: "stopped" },
		});
		expect(nonZero.ok).toBe(false);
		expect(nonZero.errors.join("; ")).toContain("code 1");

		const signaled = assessLauncherShutdown({
			exited: true,
			forced: false,
			exitCode: null,
			signalCode: "SIGTERM",
			terminalState: { status: "stopped" },
		});
		expect(signaled.ok).toBe(false);
		expect(signaled.errors.join("; ")).toContain("SIGTERM");

		for (const status of ["failed", "error"] as const) {
			const terminalFailure = assessLauncherShutdown({
				exited: true,
				forced: false,
				exitCode: 0,
				signalCode: null,
				terminalState: { status, error: "teardown failed" },
			});
			expect(terminalFailure.ok).toBe(false);
			expect(terminalFailure.errors.join("; ")).toContain(status);
			expect(terminalFailure.errors.join("; ")).toContain("teardown failed");
		}

		const forced = assessLauncherShutdown({
			exited: true,
			forced: true,
			exitCode: 0,
			signalCode: null,
			terminalState: { status: "stopped" },
		});
		expect(forced.ok).toBe(false);
		expect(forced.errors.join("; ")).toContain("SIGKILL");

		expect(cleanupOperationDeadline(100_000, 1_000)).toBe(11_000);
		expect(cleanupOperationDeadline(5_000, 1_000)).toBe(5_000);
		const smoke = readFileSync(
			join(
				import.meta.dirname,
				"../../scripts/smoke-assembled-desktop-runtime.ts",
			),
			"utf8",
		);
		expectCodeContains(
			smoke,
			"Math.min(cleanupDeadlineMs, nowMs + SMOKE_CLEANUP_STEP_BUDGET_MS)",
		);
		expectCodeContains(smoke, "cleanupRuntimeLauncher({ child, stateFile");
		expectCodeContains(
			smoke,
			"const deadlineMs = Date.now() + SMOKE_CLEANUP_BUDGET_MS",
		);
		expectCodeContains(
			smoke,
			"waitForPortsReleasedUntil(input.ports, input.deadlineMs)",
		);
		expectCodeContains(smoke, "input.processObserver.verify(input.deadlineMs)");
		expectCodeContains(
			smoke,
			"browser = await withinDeadline(smokeDeadline, 'browser launch'",
		);
		expectCodeContains(
			smoke,
			"context = await withinDeadline(smokeDeadline, 'browser context creation'",
		);
		expectCodeContains(
			smoke,
			"page = await withinDeadline(smokeDeadline, 'browser page creation'",
		);
		expectCodeContains(
			smoke,
			"await withinDeadline(smokeDeadline, 'preview post-readiness verification'",
		);
	});

	test("routes desktop builds through Tauri with runtime preparation in its hook", () => {
		const manifest = JSON.parse(
			readFileSync(join(import.meta.dirname, "../../package.json"), "utf8"),
		) as { scripts: Record<string, string> };
		expect(manifest.scripts["build:desktop"]).toBe("bun run tauri build");
	});

	test("restores only the supported macOS vendor Bun targets and preserves its signature", () => {
		const manifest = JSON.parse(
			readFileSync(join(import.meta.dirname, "../../package.json"), "utf8"),
		) as { scripts: Record<string, string> };
		expect(manifest.scripts["finalize:macos-bundle"]).toBe(
			"bun run scripts/finalize-macos-bundle.ts",
		);
		expect(
			macosBunSidecarPath("aarch64-apple-darwin").replaceAll("\\", "/"),
		).toEqual(
			expect.stringMatching(
				new RegExp(
					"src-tauri/resources/sidecars/bun-aarch64-apple-darwin" + "$",
				),
			),
		);
		expect(
			macosBunSidecarPath("x86_64-apple-darwin").replaceAll("\\", "/"),
		).toEqual(
			expect.stringMatching(
				new RegExp(
					"src-tauri/resources/sidecars/bun-x86_64-apple-darwin" + "$",
				),
			),
		);
		expect(() => macosBunSidecarPath("x86_64-pc-windows-msvc")).toThrow(
			"unsupported macOS target",
		);

		expect(
			outerAdHocSignArgs(
				"/bundle/ForgeaX Studio.app",
				"/repo/src-tauri/Entitlements.plist",
			),
		).toEqual([
			"--force",
			"--sign",
			"-",
			"--options",
			"runtime",
			"--entitlements",
			"/repo/src-tauri/Entitlements.plist",
			"/bundle/ForgeaX Studio.app",
		]);
		expect(outerAdHocSignArgs("/bundle/ForgeaX Studio.app")).not.toContain(
			"--deep",
		);

		expect(
			hasRequiredBunVendorSignature(
				[
					"flags=0x10000(runtime)",
					"Authority=Developer ID Application: Jarred Sumner (7FRXF46ZSN)",
					"TeamIdentifier=7FRXF46ZSN",
				].join("\n"),
			),
		).toBe(true);
		expect(
			hasRequiredBunVendorSignature(
				[
					"flags=0x10000(runtime)",
					"Authority=Developer ID Application: Other Vendor",
					"TeamIdentifier=7FRXF46ZSN",
				].join("\n"),
			),
		).toBe(false);
		expect(
			hasRequiredBunVendorSignature("Signature=adhoc\nTeamIdentifier=not set"),
		).toBe(false);

		const finalizer = readFileSync(
			join(import.meta.dirname, "../../scripts/finalize-macos-bundle.ts"),
			"utf8",
		);
		expectCodeContains(
			finalizer,
			"run('codesign', ['--verify', '--strict', path])",
		);
		expectCodeContains(
			finalizer,
			"run('codesign', ['--verify', '--deep', '--strict', appBundle])",
		);
		expectCodeNotContains(
			finalizer,
			"outerAdHocSignArgs(appBundle).concat('--deep')",
		);
	});

	test("rebuilds a bounded DMG from the finalized app without mounting an image", () => {
		expect(
			macosDmgCreateArgs(
				"ForgeaX Studio",
				"/tmp/forgeax-dmg-source",
				"/tmp/forgeax.dmg",
			),
		).toEqual([
			"create",
			"-volname",
			"ForgeaX Studio",
			"-srcfolder",
			"/tmp/forgeax-dmg-source",
			"-fs",
			"HFS+",
			"-ov",
			"-format",
			"UDZO",
			"-imagekey",
			"zlib-level=9",
			"-o",
			"/tmp/forgeax.dmg",
		]);
		const finalizer = readFileSync(
			join(import.meta.dirname, "../../scripts/finalize-macos-bundle.ts"),
			"utf8",
		);
		expectCodeContains(finalizer, "run('ditto', [appBundle, stagedApp])");
		expectCodeContains(finalizer, "symlinkSync('/Applications'");
		expectCodeContains(finalizer, "runMacosDmgVerify(finalDmg)");
		expectCodeContains(finalizer, "timeout: options.timeoutMs");
		expectCodeNotContains(finalizer, "['attach'");
		expectCodeNotContains(finalizer, "['detach'");
		expectCodeNotContains(finalizer, "['info', '-plist']");
	});

	test("retries only transient hdiutil resource-busy failures with bounded backoff", () => {
		const attempts: string[][] = [];
		const waits: number[] = [];
		const timeouts: number[] = [];
		runMacosDmgCreate(["create", "-o", "/tmp/forgeax.dmg"], {
			execute: (_command, args, options) => {
				attempts.push(args);
				timeouts.push(options.timeoutMs);
				return attempts.length === 1
					? { status: 1, stderr: "hdiutil: create failed - Resource busy\\n" }
					: { status: 0 };
			},
			wait: (milliseconds) => waits.push(milliseconds),
		});
		expect(attempts).toHaveLength(2);
		expect(timeouts).toEqual([
			MACOS_HDIUTIL_TIMEOUT_MS,
			MACOS_HDIUTIL_TIMEOUT_MS,
		]);
		expect(waits).toEqual([MACOS_DMG_CREATE_RETRY_DELAYS_MS[0]]);
	});

	test("fails fast on a bounded hdiutil create timeout without retrying", () => {
		let attempts = 0;
		const waits: number[] = [];
		const timeoutError = Object.assign(
			new Error("spawnSync hdiutil ETIMEDOUT"),
			{ code: "ETIMEDOUT" },
		);
		expect(() =>
			runMacosDmgCreate(["create"], {
				execute: (_command, _args, options) => {
					attempts += 1;
					expect(options.timeoutMs).toBe(MACOS_HDIUTIL_TIMEOUT_MS);
					return { status: null, error: timeoutError };
				},
				wait: (milliseconds) => waits.push(milliseconds),
			}),
		).toThrow(`hdiutil create timed out after ${MACOS_HDIUTIL_TIMEOUT_MS}ms`);
		expect(attempts).toBe(1);
		expect(waits).toEqual([]);
	});

	test("surfaces hdiutil spawn errors and verify timeouts without retrying", () => {
		const spawnError = Object.assign(new Error("permission denied"), {
			code: "EACCES",
		});
		expect(() =>
			runMacosDmgCreate(["create"], {
				execute: (_command, _args, options) => {
					expect(options.timeoutMs).toBe(MACOS_HDIUTIL_TIMEOUT_MS);
					return { status: null, error: spawnError };
				},
			}),
		).toThrow("hdiutil create failed to start: permission denied");

		expect(() =>
			runMacosDmgVerify("/tmp/final.dmg", {
				execute: (_command, args, options) => {
					expect(args).toEqual(["verify", "/tmp/final.dmg"]);
					expect(options.timeoutMs).toBe(MACOS_HDIUTIL_TIMEOUT_MS);
					return {
						status: null,
						error: Object.assign(new Error("spawnSync hdiutil ETIMEDOUT"), {
							code: "ETIMEDOUT",
						}),
					};
				},
			}),
		).toThrow(`hdiutil verify timed out after ${MACOS_HDIUTIL_TIMEOUT_MS}ms`);

		expect(() =>
			runMacosDmgVerify("/tmp/final.dmg", {
				execute: () => ({
					status: 1,
					stderr: "hdiutil: verify failed - checksum mismatch\n",
				}),
			}),
		).toThrow("command failed (1): hdiutil verify /tmp/final.dmg");
	});

	test("fails immediately on non-transient hdiutil errors", () => {
		let attempts = 0;
		expect(() =>
			runMacosDmgCreate(["create"], {
				execute: () => {
					attempts += 1;
					return {
						status: 1,
						stderr: "hdiutil: create failed - No space left on device\\n",
					};
				},
				wait: () => {
					throw new Error("must not wait");
				},
			}),
		).toThrow("command failed (1): hdiutil create");
		expect(attempts).toBe(1);
	});

	test("fails after exactly three resource-busy attempts", () => {
		let attempts = 0;
		const waits: number[] = [];
		expect(() =>
			runMacosDmgCreate(["create"], {
				execute: () => {
					attempts += 1;
					return {
						status: 1,
						stderr: "hdiutil: create failed - Resource busy\\n",
					};
				},
				wait: (milliseconds) => waits.push(milliseconds),
			}),
		).toThrow("command failed (1): hdiutil create");
		expect(attempts).toBe(MACOS_DMG_CREATE_RETRY_DELAYS_MS.length + 1);
		expect(waits).toEqual([...MACOS_DMG_CREATE_RETRY_DELAYS_MS]);
	});

	test("loads the server preload relative to its cwd so app bundle spaces are safe", () => {
		const runtime = readFileSync(
			join(import.meta.dirname, "../../scripts/desktop-runtime.ts"),
			"utf8",
		);
		const preload = readFileSync(
			join(import.meta.dirname, "../../scripts/server-native-preload.ts"),
			"utf8",
		);
		expectCodeContains(
			runtime,
			"BUN_OPTIONS: '--preload=./native-preload.mjs'",
		);
		expectCodeNotContains(runtime, "pathToFileURL(serverPreload)");
		expectCodeContains(
			runtime,
			"materializeNodeModules(join(source, 'node_modules'), join(destination, 'node_modules'))",
		);
		expectCodeNotContains(
			runtime,
			"for (const entry of ['node_modules', 'forgeax-editor-assets'",
		);
		expectCodeContains(preload, "delete process.env.BUN_OPTIONS");
	});

	test("uses one guarded paired port policy for runtime state, services, and release resources", () => {
		const runtime = readFileSync(
			join(import.meta.dirname, "../../scripts/desktop-runtime.ts"),
			"utf8",
		);
		const preload = readFileSync(
			join(import.meta.dirname, "../../scripts/server-native-preload.ts"),
			"utf8",
		);
		const rustShell = readFileSync(
			join(import.meta.dirname, "../../src-tauri/src/lib.rs"),
			"utf8",
		);
		const desktopSchema = JSON.parse(
			readFileSync(
				join(
					import.meta.dirname,
					"../../release/desktop-runtime-manifest.v2.schema.json",
				),
				"utf8",
			),
		) as any;
		expectCodeContains(runtime, "await reserveDesktopPorts()");
		expectCodeContains(runtime, "portOffset");
		expectCodeContains(
			runtime,
			"managedPorts: { server: serverPort, engine: enginePort }",
		);
		expectCodeContains(runtime, "FORGEAX_SERVER_PORT: String(serverPort)");
		expectCodeContains(runtime, "FORGEAX_ENGINE_PORT: String(enginePort)");
		expectCodeContains(runtime, "const STARTUP_TIMEOUT_MS = 120_000");
		expectCodeContains(
			runtime,
			"probeDesktopEngine(`http://127.0.0.1:$" +
				"{enginePort}/`, engineReadyFile)",
		);
		expectCodeNotContains(
			runtime,
			"probe(`http://127.0.0.1:$" + "{enginePort}/preview/`)",
		);
		const exitedServiceCheck = runtime.indexOf("const exitedService");
		const readinessCheck = runtime.indexOf("if (\n\t\t\tserver.ready &&");
		expect(exitedServiceCheck).toBeGreaterThanOrEqual(0);
		expect(readinessCheck).toBeGreaterThanOrEqual(0);
		expect(exitedServiceCheck).toBeLessThan(readinessCheck);
		expectCodeContains(
			runtime,
			"const STATE_WRITE_RETRY_CODES = new Set(['EPERM', 'EBUSY'])",
		);
		expectCodeContains(runtime, "attempt <= STATE_WRITE_ATTEMPTS");
		expectCodeContains(
			runtime,
			"'[desktop-runtime] failed to persist terminal failure state:'",
		);
		expectCodeContains(runtime, "await stop(1, false)");
		expectCodeContains(
			preload,
			"import { resolveServerRuntimeAsset } from './server-runtime-assets'",
		);
		expectCodeContains(
			preload,
			"import { normalizeWindowsDevicePath } from './desktop-environment'",
		);
		expectCodeNotContains(preload, "startsWith('/$bunfs/root/')");
		expectCodeContains(runtime, "await ports.releaseReservations()");
		const reservationsReleased = runtime.indexOf(
			"await ports.releaseReservations()",
		);
		const serverStarted = runtime.indexOf('spawn("server"');
		const portsReleased = runtime.indexOf("await ports.release();");
		const runtimeReady = runtime.indexOf(
			"if (\n\t\t\tserver.ready &&\n\t\t\tengine.ready &&",
		);
		expect(reservationsReleased).toBeGreaterThanOrEqual(0);
		expect(serverStarted).toBeGreaterThanOrEqual(0);
		expect(portsReleased).toBeGreaterThanOrEqual(0);
		expect(runtimeReady).toBeGreaterThanOrEqual(0);
		expect(reservationsReleased).toBeLessThan(serverStarted);
		expect(portsReleased).toBeGreaterThan(runtimeReady);
		expectCodeContains(runtime, "FORGEAX_AGENT_HOST_SOCK: agentHostSocket");
		expectCodeContains(
			runtime,
			"desktopStableAgentHostDirectory(projectRoot, portOffset)",
		);
		expectCodeContains(runtime, "if (assessment.cleanupRuntimeDirectory)");
		expect(
			desktopStableAgentHostDirectory("/project", 7).replaceAll("\\", "/"),
		).toBe("/project/.forgeax/runtime/desktop-prod-offset-7");
		expect(
			desktopStableAgentHostSocket("/project", 7).replaceAll("\\", "/"),
		).toBe("/project/.forgeax/runtime/desktop-prod-offset-7/agent-host.sock");
		expectCodeContains(
			runtime,
			"const destination = join(runtimeDirectory, 'engine')",
		);
		expectCodeNotContains(runtime, "join(projectRoot, '.engine-runtime')");
		expectCodeNotContains(
			runtime,
			"join(projectRoot, '.forgeax', 'runtime', 'agent-host.sock')",
		);
		expectCodeContains(
			runtime,
			"replaceJunction(join(destination, '.forgeax', 'games'), join(projectRoot, '.forgeax', 'games'))",
		);
		expectCodeContains(runtime, "await portLease?.release();");
		expectCodeNotContains(runtime, "const processGroupIds = new Set<number>()");
		expectCodeNotContains(runtime, "waitForDesktopProcessGroups");
		expectCodeContains(
			runtime,
			"const processTreeClosed = !childrenLive && !groupsLive",
		);
		expectCodeContains(runtime, "desktopProcessTreePlan");
		expectCodeContains(
			runtime,
			"desktopProcessTreePlan('win32', gracefulPids, 'SIGTERM')",
		);
		expectCodeNotContains(
			runtime,
			"desktopProcessTreePlan(process.platform === 'win32' ? 'win32' : 'posix'",
		);
		expectCodeNotContains(runtime, "process.kill(");
		expectCodeContains(runtime, "requestPosixGuardianShutdown");
		expectCodeContains(runtime, "probeAgentHost");
		expectCodeContains(runtime, "spawn('agent-host'");
		expectCodeContains(runtime, "FORGEAX_AGENT_HOST_EXTERNAL_ONLY: '1'");
		expectCodeContains(
			runtime,
			"FORGEAX_RUNTIME_GUARDIAN_PATH: runtimeGuardianPath",
		);
		expectCodeContains(runtime, "sanitizedGuardianEnvironment");
		expectCodeContains(runtime, "'--target-env-fd', '3'");
		expectCodeContains(runtime, "MAX_TARGET_ENV_BYTES");
		expectCodeContains(
			runtime,
			"stdio: ['pipe', 'inherit', 'inherit', 'pipe']",
		);
		expectCodeNotContains(runtime, "process.kill(-");
		expectCodeContains(
			runtime,
			"{ taskkillTimeoutMs: DESKTOP_TASKKILL_TIMEOUT_MS }",
		);
		expectCodeContains(runtime, "stdout: 'ignore'");
		expectCodeContains(runtime, "taskkill.kill('SIGKILL')");
		expectCodeContains(runtime, "taskkill.exitCode !== null");
		expect(2 * DESKTOP_TASKKILL_TIMEOUT_MS + 3_000 + 3_000).toBeLessThan(
			15_000,
		);
		expect(rustShell).toContain(
			"LAUNCHER_SHUTDOWN_GRACE: Duration = Duration::from_secs(15)",
		);
		expect(rustShell).toContain("drop(child.take());");
		expect(rustShell).not.toContain("libc::kill(child.pid()");
		expectCodeContains(runtime, "status = finalAssessment.status");
		expect(rustShell).toContain(
			'format!("desktop-prod-{}.json", std::process::id())',
		);
		expect(rustShell).not.toContain('.join("desktop-prod.json")');
		expect(rustShell).toContain("std::time::Duration::from_secs(120)");
		expect(rustShell).toContain(
			"runtime state did not become ready within 120 seconds",
		);
		expect(desktopSchema.required).toContain("portPolicy");
		expect(desktopSchema.required).not.toContain("ports");
		expect(desktopSchema.properties.portPolicy.properties).toMatchObject({
			kind: { const: "guarded-paired-offset" },
			serverBase: { const: 18810 },
			engineBase: { const: 15273 },
			guardBase: { const: 25273 },
			maximumOffset: { const: 128 },
			overrideEnvironment: { const: "FORGEAX_DESKTOP_PORT_OFFSET" },
		});
	});

	test("ships and selects the forgeax-core serve entry for the compiled server", () => {
		const artifacts = readFileSync(
			join(import.meta.dirname, "../../scripts/runtime-artifacts.ts"),
			"utf8",
		);
		const runtime = readFileSync(
			join(import.meta.dirname, "../../scripts/desktop-runtime.ts"),
			"utf8",
		);
		expectCodeContains(
			artifacts,
			"join(IDE_ROOT, 'scripts/forgeax-core-serve-entry.ts')",
		);
		expectCodeContains(artifacts, "'server-runtime/forgeax-core-serve.mjs'");
		expectCodeContains(artifacts, "'--packages=bundle'");
		expectCodeContains(
			runtime,
			"join(serverRuntime, 'forgeax-core-serve.mjs')",
		);
		expectCodeContains(runtime, "FORGEAX_CORE_SERVE_ENTRY: coreServe");
	});

	test("binds every released server sidecar to service version, exact platform target, size, and digest", () => {
		expect(
			validateSidecar(manifest, "macos-arm64", bytes, "0.1.0").sha256,
		).toBe(digest);
		expect(() =>
			validateSidecar(manifest, "macos-arm64", bytes, "0.1.1"),
		).toThrow("version mismatch");
		const changed = bytes.slice();
		changed[0] = 8;
		expect(() =>
			validateSidecar(manifest, "macos-arm64", changed, "0.1.0"),
		).toThrow("digest mismatch");
		const wrongArch = bytes.slice();
		wrongArch.set([0x07, 0, 0, 0x01], 4);
		const wrongArchManifest = structuredClone(manifest);
		wrongArchManifest.artifacts[0].sha256 = createHash("sha256")
			.update(wrongArch)
			.digest("hex");
		expect(() =>
			validateSidecar(wrongArchManifest, "macos-arm64", wrongArch, "0.1.0"),
		).toThrow("architecture mismatch");
		const wrongTarget = structuredClone(manifest);
		wrongTarget.artifacts[0].targetTriple = "x86_64-apple-darwin";
		expect(() =>
			validateSidecar(wrongTarget, "macos-arm64", bytes, "0.1.0"),
		).toThrow("invalid sidecar artifact");
	});

	test("restricts source URLs to canonical versioned forgeax-server GitHub Release paths", () => {
		const valid =
			"https://github.com/ForgeaX-Games/forgeax-server/releases/download/server-v0.1.0/candidate.json";
		expect(validateTrustedReleaseUrl(valid, "manifest", "0.1.0")).toBe(valid);
		for (const url of [
			"https://user:pass@github.com/ForgeaX-Games/forgeax-server/releases/download/server-v0.1.0/candidate.json",
			"https://github.com.evil.test/ForgeaX-Games/forgeax-server/releases/download/server-v0.1.0/candidate.json",
			"https://github.com/ForgeaX-Games/other/releases/download/server-v0.1.0/candidate.json",
			"https://github.com/ForgeaX-Games/forgeax-server/releases/download/server-v0.1.0/%2e%2e.json",
			`${valid}?token=secret`,
			`${valid}#fragment`,
			`${valid}\nINJECTED=1`,
		])
			expect(() =>
				validateTrustedReleaseUrl(url, "manifest", "0.1.0"),
			).toThrow();
	});

	test("allows GitHub release-asset redirects but rejects untrusted origins and oversized responses", async () => {
		const url =
			"https://github.com/ForgeaX-Games/forgeax-server/releases/download/server-v0.1.0/candidate.json";
		const allowed = async () => {
			const response = new Response(bytes);
			Object.defineProperty(response, "url", {
				value:
					"https://release-assets.githubusercontent.com/github-production-release-asset/file",
			});
			return response;
		};
		expect(
			await fetchBounded(
				url,
				digest,
				bytes.length,
				allowed as unknown as typeof fetch,
			),
		).toEqual(bytes);
		const untrusted = async () => {
			const response = new Response(bytes);
			Object.defineProperty(response, "url", {
				value: "https://evil.test/file",
			});
			return response;
		};
		await expect(
			fetchBounded(
				url,
				digest,
				bytes.length,
				untrusted as unknown as typeof fetch,
			),
		).rejects.toThrow("untrusted origin");
		const oversized = async () => {
			const response = new Response(bytes, {
				headers: { "content-length": String(bytes.length + 1) },
			});
			Object.defineProperty(response, "url", { value: url });
			return response;
		};
		await expect(
			fetchBounded(
				url,
				digest,
				bytes.length,
				oversized as unknown as typeof fetch,
			),
		).rejects.toThrow("byte limit");
	});

	test("rejects the repository placeholder and requires the target-specific binary", () => {
		const root = mkdtempSync(join(tmpdir(), "ide-resources-"));
		mkdirSync(join(root, "src-tauri/resources/sidecars"), { recursive: true });
		mkdirSync(join(root, "src-tauri/capabilities"), { recursive: true });
		mkdirSync(join(root, "src-tauri/src"), { recursive: true });
		writeFileSync(
			join(root, "src-tauri/tauri.conf.json"),
			JSON.stringify({
				build: { frontendDist: "../dist" },
				bundle: {
					active: true,
					externalBin: ["resources/sidecars/bun"],
					resources: ["resources"],
				},
			}),
		);
		writeFileSync(join(root, "src-tauri/capabilities/main.json"), "{}");
		writeFileSync(
			join(root, "src-tauri/src/lib.rs"),
			'app.shell().sidecar("bun")',
		);
		mkdirSync(join(root, "src-tauri/resources/engine"), { recursive: true });
		writeFileSync(
			join(root, "src-tauri/resources/engine/vite.config.ts"),
			"import './vite-fs-allow.mjs';",
		);
		expect(
			validateDesktopResources(root, "windows-x64").map((error) => error.code),
		).toContain("production-sidecar-missing");
		expect(
			validateDesktopResources(root, "windows-x64").map((error) => error.code),
		).not.toContain("runtime-guardian-missing-or-invalid");
		expect(
			validateDesktopResources(root, "macos-arm64").map((error) => error.code),
		).toContain("runtime-guardian-missing-or-invalid");
		writeFileSync(
			join(
				root,
				"src-tauri/resources/sidecars/forgeax-server-x86_64-pc-windows-msvc.exe",
			),
			"IDE_SIDECAR_PLACEHOLDER",
		);
		expect(
			validateDesktopResources(root, "windows-x64").map((error) => error.code),
		).toContain("production-sidecar-invalid");
		expect(
			validateDesktopResources(root, "windows-x64").some(
				(error) =>
					error.code === "runtime-engine-config-import-missing" &&
					error.path === "engine/vite.config.ts -> ./vite-fs-allow.mjs",
			),
		).toBe(true);
		rmSync(root, { recursive: true, force: true });
	});
});
