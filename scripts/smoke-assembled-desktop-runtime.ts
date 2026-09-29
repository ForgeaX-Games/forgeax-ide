#!/usr/bin/env bun

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	type Browser,
	type BrowserContext,
	chromium,
	type Page,
} from "playwright-core";
import {
	createProcessObserver,
	type ProcessObserver,
} from "./smoke-process-evidence";

export { parseWindowsProcessSnapshot } from "./smoke-process-evidence";

export const SMOKE_MAIN_BUDGET_MS = 270_000;
export const SMOKE_CLEANUP_BUDGET_MS = 50_000;
export const SMOKE_CLEANUP_STEP_BUDGET_MS = 10_000;
export const PREVIEW_CANVAS_SELECTOR = "#app > canvas";
export const PREVIEW_FRAME_SUBMITTED_ATTRIBUTE = "data-forgeax-frame-submitted";
export const PREVIEW_DOM_DIAGNOSTICS_TIMEOUT_MS = 2_000;
const SHUTDOWN_TIMEOUT_MS = SMOKE_CLEANUP_STEP_BUDGET_MS;

const ideRoot = resolve(import.meta.dirname, "..");
const resourceRoot = join(ideRoot, "src-tauri/resources");
const gameSlug = "legacy-material-smoke";
const fixtureMain = `import type { Plugin } from '@forgeax/engine-plugin';
import { Camera, perspective } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';

const gameplay: Plugin = {
  name: 'game-empty',
  inject: ['world'],
  apply(ctx) {
    ctx.effect(() => {
      const camera = ctx.world
        .spawn(
          { component: Transform, data: { pos: [0, 0, 5] } },
          {
            component: Camera,
            data: {
              ...perspective({ fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 }),
              clearColor: [0.015, 0.02, 0.035, 1],
            },
          },
        )
        .unwrap();
      return () => {
        void ctx.world.despawn(camera);
      };
    });
  },
};

export default gameplay;
`;
export const jsonPackGuid = "01900000-0000-7000-8000-00000000000a";
// AssetGuid.derive(packageId 01900000-0000-7000-8000-00000000000b, "material").
export const scriptablePackGuid = "7194f99f-845f-5e2f-9a77-4dc3f030136d";
export const expectedPackGuids = [jsonPackGuid, scriptablePackGuid] as const;

export function deadlineRemaining(
	deadlineMs: number,
	nowMs = Date.now(),
): number {
	return Math.max(0, deadlineMs - nowMs);
}

export function requireDeadlineRemaining(
	deadlineMs: number,
	phase: string,
	nowMs = Date.now(),
): number {
	const remaining = deadlineRemaining(deadlineMs, nowMs);
	if (remaining <= 0)
		throw new Error(
			"assembled desktop smoke " + phase + " exceeded the smoke deadline",
		);
	return remaining;
}

export function cleanupOperationDeadline(
	cleanupDeadlineMs: number,
	nowMs = Date.now(),
): number {
	return Math.min(cleanupDeadlineMs, nowMs + SMOKE_CLEANUP_STEP_BUDGET_MS);
}

export type LauncherTerminalState = {
	readonly status?: unknown;
	readonly error?: unknown;
};

export type LauncherShutdownAssessment = {
	readonly ok: boolean;
	readonly errors: readonly string[];
};

export type SmokeDiagnostic = {
	readonly directory: string;
	phase(phase: string): void;
	event(name: string, detail?: unknown): void;
	state(snapshot: unknown): void;
	output(stream: "stdout" | "stderr", chunk: string): void;
};

export function serializeDiagnosticError(error: unknown): unknown {
	if (!(error instanceof Error)) return error;
	return {
		name: error.name,
		message: error.message,
		...(error.stack ? { stack: error.stack } : {}),
		...("cause" in error && error.cause !== undefined
			? { cause: serializeDiagnosticError(error.cause) }
			: {}),
		...(error instanceof AggregateError
			? { errors: error.errors.map(serializeDiagnosticError) }
			: {}),
	};
}

/** Keep evidence outside the disposable fixture: cleanup must never erase the failure it reports. */
export function createSmokeDiagnostic(
	directory = mkdtempSync(join(tmpdir(), "forgeax-desktop-smoke-diagnostics-")),
): SmokeDiagnostic {
	mkdirSync(directory, { recursive: true });
	const event = (name: string, detail?: unknown) =>
		appendFileSync(
			join(directory, "events.ndjson"),
			`${JSON.stringify({ at: new Date().toISOString(), name, detail })}\n`,
		);
	writeFileSync(
		join(directory, "run.json"),
		`${JSON.stringify({ platform: process.platform, arch: process.arch, pid: process.pid, startedAt: new Date().toISOString(), ideRevision: process.env.FORGEAX_CI_IDE_REVISION ?? null }, null, 2)}\n`,
	);
	return {
		directory,
		phase(phase) {
			writeFileSync(
				join(directory, "phase.json"),
				`${JSON.stringify({ phase, at: new Date().toISOString() }, null, 2)}\n`,
			);
			event("phase", phase);
		},
		event,
		state(snapshot) {
			writeFileSync(
				join(directory, "runtime-state.json"),
				`${JSON.stringify(snapshot, null, 2)}\n`,
			);
		},
		output(stream, chunk) {
			appendFileSync(join(directory, `${stream}.log`), chunk);
		},
	};
}

export async function verifyPortsReleased(
	ports: readonly number[],
): Promise<string[]> {
	const errors: string[] = [];
	for (const port of [...new Set(ports)]) {
		try {
			await new Promise<void>((resolvePromise, rejectPromise) => {
				const server = createServer();
				server.once("error", rejectPromise);
				server.listen({ host: "127.0.0.1", port }, () =>
					server.close((error) =>
						error ? rejectPromise(error) : resolvePromise(),
					),
				);
			});
		} catch (error) {
			errors.push(
				`port ${port} could not be rebound: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return errors;
}

export async function waitForPortsReleased(
	ports: readonly number[],
	timeoutMs = SMOKE_CLEANUP_STEP_BUDGET_MS,
): Promise<string[]> {
	return waitForPortsReleasedUntil(ports, Date.now() + timeoutMs);
}

/** All cleanup verification shares one absolute deadline. */
export async function waitForPortsReleasedUntil(
	ports: readonly number[],
	deadlineMs: number,
): Promise<string[]> {
	let errors = await verifyPortsReleased(ports);
	while (errors.length > 0 && Date.now() < deadlineMs) {
		await sleep(Math.min(50, Math.max(1, deadlineRemaining(deadlineMs))));
		errors = await verifyPortsReleased(ports);
	}
	return errors;
}

export function assessLauncherShutdown(input: {
	exited: boolean;
	forced: boolean;
	exitCode: number | null;
	signalCode: string | null;
	terminalState?: LauncherTerminalState;
	expectedStartupFailure?: string;
}): LauncherShutdownAssessment {
	const errors: string[] = [];
	if (!input.exited)
		errors.push("launcher did not exit after bounded shutdown waits");
	if (input.forced) errors.push("launcher required SIGKILL during shutdown");
	const expectedFailure =
		input.expectedStartupFailure !== undefined &&
		input.terminalState?.status === "failed" &&
		input.terminalState?.error === input.expectedStartupFailure;
	if (input.exitCode !== 0 && !(expectedFailure && input.exitCode !== null))
		errors.push("launcher exited with code " + String(input.exitCode));
	if (input.signalCode !== null)
		errors.push("launcher exited from signal " + input.signalCode);

	const status = input.terminalState?.status;
	if (status !== "stopped" && !expectedFailure) {
		const detail =
			status === "failed" || status === "error"
				? ": " + String(input.terminalState?.error ?? "unknown error")
				: "";
		errors.push(
			"launcher terminal state is " + String(status ?? "missing") + detail,
		);
	}
	return { ok: errors.length === 0, errors };
}

export type RuntimeCleanupResult = {
	readonly errors: readonly unknown[];
	readonly terminalState?: LauncherTerminalState;
	readonly pids: readonly number[];
	readonly ports: readonly number[];
	readonly processEvidence?: unknown;
};

/** The production smoke and integration fixtures share this bounded cleanup path. */
export async function cleanupRuntimeLauncher(input: {
	readonly child: ChildProcessWithoutNullStreams;
	readonly stateFile: string;
	readonly pids: readonly number[];
	/** Created immediately after a successful detached spawn; it remains live through shutdown. */
	readonly processObserver?: ProcessObserver;
	readonly ports: readonly number[];
	readonly deadlineMs: number;
	readonly expectedStartupFailure?: string;
}): Promise<RuntimeCleanupResult> {
	const errors: unknown[] = [];
	let processEvidence:
		| Awaited<ReturnType<ProcessObserver["verify"]>>
		| undefined;
	let forced = false;
	let exited = input.child.exitCode !== null || input.child.signalCode !== null;
	if (!exited) {
		try {
			input.child.stdin.write("shutdown\n");
		} catch (error) {
			errors.push(error);
		}
		try {
			exited = await waitForExit(
				input.child,
				Math.min(SHUTDOWN_TIMEOUT_MS, deadlineRemaining(input.deadlineMs)),
			);
		} catch (error) {
			errors.push(error);
		}
		if (!exited) {
			forced = true;
			try {
				if (
					!input.child.kill(
						process.platform === "win32" ? "SIGKILL" : "SIGTERM",
					)
				)
					errors.push(new Error("failed to terminate runtime launcher"));
				exited = await waitForExit(
					input.child,
					Math.min(SHUTDOWN_TIMEOUT_MS, deadlineRemaining(input.deadlineMs)),
				);
			} catch (error) {
				errors.push(error);
			}
		}
	}
	let terminalState: LauncherTerminalState | undefined;
	try {
		terminalState = JSON.parse(
			readFileSync(input.stateFile, "utf8"),
		) as LauncherTerminalState;
	} catch (error) {
		errors.push(
			new Error(
				"failed to read launcher terminal state: " +
					(error instanceof Error ? error.message : String(error)),
				{ cause: error },
			),
		);
	}
	const assessment = assessLauncherShutdown({
		exited,
		forced,
		exitCode: input.child.exitCode,
		signalCode: input.child.signalCode,
		terminalState,
		expectedStartupFailure: input.expectedStartupFailure,
	});
	if (!assessment.ok) errors.push(new Error(assessment.errors.join("; ")));
	try {
		if (input.processObserver) {
			processEvidence = await input.processObserver.verify(input.deadlineMs);
			errors.push(...processEvidence.errors);
			if (processEvidence.liveMembers.length > 0)
				errors.push(
					new Error(
						`owned process group members are still alive: ${processEvidence.liveMembers.map((member) => member.pid).join(", ")}`,
					),
				);
		} else if (input.pids.length > 0) {
			errors.push(
				new Error(
					"owned launcher PIDs were recorded without process-identity evidence",
				),
			);
		}
	} catch (error) {
		errors.push(
			new Error(
				"failed to verify process cleanup: " +
					(error instanceof Error ? error.message : String(error)),
				{ cause: error },
			),
		);
	}
	try {
		errors.push(
			...(await waitForPortsReleasedUntil(input.ports, input.deadlineMs)),
		);
	} catch (error) {
		errors.push(
			new Error(
				"failed to verify released ports: " +
					(error instanceof Error ? error.message : String(error)),
				{ cause: error },
			),
		);
	}
	return {
		errors,
		terminalState,
		pids: input.pids,
		ports: input.ports,
		processEvidence,
	};
}

/** Shared failure envelope for the production smoke and its real failure fixtures. */
export async function runWithSmokeCleanup<T>(input: {
	readonly run: () => Promise<T>;
	readonly cleanup: () => Promise<readonly unknown[]>;
	readonly report?: (name: string, detail?: unknown) => void;
}): Promise<T> {
	let value: T | undefined;
	let primary: unknown;
	let hasPrimaryFailure = false;
	const reportErrors: unknown[] = [];
	const report = (name: string, detail?: unknown): void => {
		try {
			input.report?.(name, detail);
		} catch (error) {
			reportErrors.push(error);
		}
	};
	try {
		value = await input.run();
	} catch (error) {
		hasPrimaryFailure = true;
		primary = error;
		report("primary-failure", serializeDiagnosticError(error));
	}
	let cleanupErrors: readonly unknown[] = [];
	try {
		cleanupErrors = await input.cleanup();
	} catch (error) {
		cleanupErrors = [error];
	}
	report("cleanup-finished", {
		errors: cleanupErrors.map(serializeDiagnosticError),
	});
	const secondaryErrors = [...cleanupErrors, ...reportErrors];
	if (hasPrimaryFailure && secondaryErrors.length > 0)
		throw new AggregateError(
			[primary, ...secondaryErrors],
			"assembled desktop smoke and cleanup failed",
		);
	if (hasPrimaryFailure) throw primary;
	if (secondaryErrors.length > 0)
		throw new AggregateError(
			secondaryErrors,
			"assembled desktop smoke cleanup failed",
		);
	return value as T;
}

export function previewUrl(origin: string): string {
	const parsed = new URL(origin);
	if (
		parsed.origin !== origin ||
		parsed.pathname !== "/" ||
		parsed.search ||
		parsed.hash
	)
		throw new Error("preview origin must be an origin");
	return `${origin}/preview/?game=${gameSlug}`;
}

export function previewRequiredPaths(): readonly string[] {
	return [
		"/preview/",
		"/preview/src/main.ts",
		`/preview/host-games/${gameSlug}/forge.json`,
		`/preview/host-games/${gameSlug}/assets/desktop-smoke.plugin.ts`,
		"/preview/shaders/manifest.json",
	];
}

export function observePreviewResponse(
	response: { url: string; status: number },
	observed: Set<string>,
): string | undefined {
	const path = new URL(response.url).pathname;
	if (!previewRequiredPaths().includes(path)) return undefined;
	if (response.status < 200 || response.status >= 300)
		return `preview response ${path} returned ${response.status}`;
	observed.add(path);
	return undefined;
}

export function isAllowedBrowserWarning(message: string): boolean {
	return /webgpu is unavailable; falling back to swiftshader/i.test(message);
}

export function classifyConsoleMessage(
	type: string,
	message: string,
): string | undefined {
	const domain = /createApp/i.test(message)
		? "createApp"
		: /\bmodule\b/i.test(message)
			? "module"
			: /loadGame/i.test(message)
				? "loadGame"
				: /shader/i.test(message)
					? "shader"
					: /renderer/i.test(message)
						? "renderer"
						: undefined;
	if (type === "error")
		return domain === undefined ? "console error" : `${domain} failure`;
	if (isAllowedBrowserWarning(message)) return undefined;
	if (
		(type === "warning" || type === "log") &&
		domain !== undefined &&
		/failed|failure|error|not-found|exception|rejected|unavailable/i.test(
			message,
		)
	) {
		return `${domain} failure`;
	}
	return undefined;
}

// This function also runs in the browser through JSHandle.evaluate.
export function serializeConsoleDiagnostic(value: unknown): string {
	const ancestors = new Set<object>();
	const visit = (input: unknown, depth: number): unknown => {
		if (input === null || typeof input !== "object")
			return typeof input === "bigint" ? String(input) : input;
		if (ancestors.has(input)) return "[circular]";
		if (depth > 6) return "[depth limit]";
		ancestors.add(input);
		const result: Record<string, unknown> = {};
		for (const key of Object.getOwnPropertyNames(input).slice(0, 50)) {
			try {
				result[key] = visit((input as Record<string, unknown>)[key], depth + 1);
			} catch {
				result[key] = "[unreadable]";
			}
		}
		ancestors.delete(input);
		return result;
	};
	return JSON.stringify(visit(value, 0)) ?? String(value);
}

export function frameSubmissionIsReady(value: unknown): value is string {
	if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return false;
	const frameId = Number(value);
	return Number.isSafeInteger(frameId);
}

export const FRAME_SUBMISSION_POLL_INTERVAL_MS = 50;
export type PreviewFrameAttributeReader = () => Promise<unknown>;

export async function waitForFrameSubmission(
	readAttribute: PreviewFrameAttributeReader,
	deadlineMs: number,
	pause: (delayMs: number) => Promise<void> = sleep,
): Promise<string> {
	while (true) {
		const value = await withinDeadline(
			deadlineMs,
			"first frame submission attribute read",
			readAttribute,
		);
		if (frameSubmissionIsReady(value)) return value;
		const delayMs = Math.min(
			FRAME_SUBMISSION_POLL_INTERVAL_MS,
			requireDeadlineRemaining(deadlineMs, "first frame submission readiness"),
		);
		await withinDeadline(
			deadlineMs,
			"first frame submission readiness polling",
			() => pause(delayMs),
		);
	}
}

export async function verifyPreviewPostReadiness(input: {
	readonly serializeFrame: () => Promise<unknown>;
	readonly failures: readonly string[];
	readonly observedPaths: readonly string[];
	readonly requiredPaths: readonly string[];
}): Promise<void> {
	const serializedFrame = await input.serializeFrame();
	if (serializedFrame === undefined)
		throw new Error("first frame submission serialization returned undefined");
	const missingPaths = input.requiredPaths.filter(
		(path) => !input.observedPaths.includes(path),
	);
	if (missingPaths.length > 0)
		throw new Error(
			`required preview paths missing: ${missingPaths.join(", ")}`,
		);
	if (input.failures.length > 0)
		throw new Error("preview reported page or console failures");
}

export function catalogHasExpectedGuids(catalog: {
	authority?: string;
	entries?: readonly { guid?: string }[];
}): boolean {
	const guids = new Set(catalog.entries?.map((entry) => entry.guid));
	return (
		catalog.authority === "authoritative" &&
		expectedPackGuids.every((guid) => guids.has(guid))
	);
}

export type PreviewDomDiagnostics = {
	readonly currentUrl: string;
	readonly appExists: boolean;
	readonly canvasCount: number;
	readonly frameSubmittedValue: string | null;
	readonly error?: string;
};

export type PreviewWaitFailure = {
	readonly phase: string;
	readonly cause: unknown;
	readonly failures: readonly string[];
	readonly observedPaths: readonly string[];
	readonly requiredPaths: readonly string[];
	readonly dom: PreviewDomDiagnostics;
};

export function formatPreviewWaitFailure(input: PreviewWaitFailure): string {
	const missingPaths = input.requiredPaths.filter(
		(path) => !input.observedPaths.includes(path),
	);
	const cause =
		input.cause instanceof Error ? input.cause.message : String(input.cause);
	const diagnostics =
		input.failures.length > 0 ? input.failures.join(" | ") : "none";
	const observed =
		input.observedPaths.length > 0 ? input.observedPaths.join(", ") : "none";
	const missing = missingPaths.length > 0 ? missingPaths.join(", ") : "none";
	return [
		`assembled desktop preview smoke ${input.phase} failed: ${cause}`,
		`page errors and classified console failures: ${diagnostics}`,
		`observed required paths: ${observed}`,
		`missing required paths: ${missing}`,
		`preview URL: ${input.dom.currentUrl || "(unavailable)"}`,
		`#app exists: ${input.dom.appExists}`,
		`${PREVIEW_CANVAS_SELECTOR} count: ${input.dom.canvasCount}`,
		`observed ${PREVIEW_FRAME_SUBMITTED_ATTRIBUTE}: ${input.dom.frameSubmittedValue ?? "(missing)"}`,
		...(input.dom.error ? [`DOM diagnostics error: ${input.dom.error}`] : []),
	].join("\n");
}

function targetTriple(): { triple: string; extension: string } {
	if (process.platform === "linux" && process.arch === "x64")
		return { triple: "x86_64-unknown-linux-gnu", extension: "" };
	if (process.platform === "darwin" && process.arch === "arm64")
		return { triple: "aarch64-apple-darwin", extension: "" };
	if (process.platform === "darwin" && process.arch === "x64")
		return { triple: "x86_64-apple-darwin", extension: "" };
	if (process.platform === "win32" && process.arch === "x64")
		return { triple: "x86_64-pc-windows-msvc", extension: ".exe" };
	throw new Error(
		`unsupported desktop smoke platform: ${process.platform}/${process.arch}`,
	);
}

function browserLaunchOptions(): Parameters<typeof chromium.launch>[0] {
	const configuredExecutable = process.env.IDE_BROWSER_EXECUTABLE;
	if (configuredExecutable) {
		if (!existsSync(configuredExecutable))
			throw new Error(
				"IDE_BROWSER_EXECUTABLE must point to a Chromium-compatible browser",
			);
		return { executablePath: configuredExecutable, headless: true };
	}
	if (process.platform === "win32")
		return { channel: "msedge", headless: true };
	if (process.platform === "linux") return { headless: true };
	const executablePath =
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
	if (!existsSync(executablePath))
		throw new Error(
			"IDE_BROWSER_EXECUTABLE must point to a Chromium-compatible browser",
		);
	return { executablePath, headless: true };
}

async function waitForExit(
	child: ChildProcessWithoutNullStreams,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) return true;
		await sleep(50);
	}
	return child.exitCode !== null || child.signalCode !== null;
}

async function fetchWithinSmokeBudget(
	input: string | URL,
	init: RequestInit | undefined,
	deadlineMs: number,
	phase: string,
): Promise<Response> {
	const timeoutMs = requireDeadlineRemaining(deadlineMs, phase);
	try {
		return await fetch(input, {
			...init,
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		const message =
			deadlineRemaining(deadlineMs) <= 0
				? "exceeded the smoke deadline"
				: "failed";
		throw new Error("assembled desktop smoke " + phase + " " + message, {
			cause: error,
		});
	}
}

async function withinDeadline<T>(
	deadlineMs: number,
	phase: string,
	operation: () => Promise<T>,
): Promise<T> {
	const timeoutMs = requireDeadlineRemaining(deadlineMs, phase);
	return await new Promise<T>((resolvePromise, rejectPromise) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			rejectPromise(
				new Error(
					"assembled desktop smoke " + phase + " exceeded its deadline",
				),
			);
		}, timeoutMs);
		const settle = (settlePromise: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			settlePromise();
		};
		try {
			void operation().then(
				(value) => settle(() => resolvePromise(value)),
				(error) => settle(() => rejectPromise(error)),
			);
		} catch (error) {
			settle(() => rejectPromise(error));
		}
	});
}

async function boundedClose(
	close: () => Promise<void>,
	cleanupDeadline: number,
	phase: string,
): Promise<void> {
	await withinDeadline(cleanupOperationDeadline(cleanupDeadline), phase, close);
}

async function inspectPreviewDom(
	page: Page | undefined,
): Promise<PreviewDomDiagnostics> {
	if (!page)
		return {
			currentUrl: "",
			appExists: false,
			canvasCount: 0,
			frameSubmittedValue: null,
			error: "page was not created",
		};
	const readPageUrl = (): string => {
		try {
			return page.url();
		} catch {
			return "";
		}
	};
	return await new Promise<PreviewDomDiagnostics>((resolve) => {
		let settled = false;
		const finish = (diagnostics: PreviewDomDiagnostics): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(diagnostics);
		};
		const timer = setTimeout(
			() =>
				finish({
					currentUrl: readPageUrl(),
					appExists: false,
					canvasCount: 0,
					frameSubmittedValue: null,
					error: `DOM diagnostics timed out after ${PREVIEW_DOM_DIAGNOSTICS_TIMEOUT_MS}ms`,
				}),
			PREVIEW_DOM_DIAGNOSTICS_TIMEOUT_MS,
		);
		void page
			.evaluate(
				({ selector, frameSubmittedAttribute }) => ({
					currentUrl: window.location.href,
					appExists: document.querySelector("#app") !== null,
					canvasCount: document.querySelectorAll(selector).length,
					frameSubmittedValue: document.documentElement.getAttribute(
						frameSubmittedAttribute,
					),
				}),
				{
					selector: PREVIEW_CANVAS_SELECTOR,
					frameSubmittedAttribute: PREVIEW_FRAME_SUBMITTED_ATTRIBUTE,
				},
			)
			.then(finish, (error) =>
				finish({
					currentUrl: readPageUrl(),
					appExists: false,
					canvasCount: 0,
					frameSubmittedValue: null,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
	});
}

export async function runSmoke(): Promise<void> {
	const smokeDeadline = Date.now() + SMOKE_MAIN_BUDGET_MS;
	const diagnosticErrors: Error[] = [];
	let diagnostic: SmokeDiagnostic | undefined;
	try {
		const requestedDiagnosticRoot =
			process.env.IDE_SMOKE_DIAGNOSTIC_DIR?.trim();
		if (requestedDiagnosticRoot)
			mkdirSync(requestedDiagnosticRoot, { recursive: true });
		diagnostic = createSmokeDiagnostic(
			requestedDiagnosticRoot
				? mkdtempSync(join(requestedDiagnosticRoot, "run-"))
				: undefined,
		);
		console.info(`[desktop-smoke diagnostics] ${diagnostic.directory}`);
	} catch (error) {
		diagnosticErrors.push(
			new Error(
				`desktop smoke diagnostic setup failed: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			),
		);
	}
	const report = (operation: (target: SmokeDiagnostic) => void): void => {
		if (!diagnostic) return;
		try {
			operation(diagnostic);
		} catch (error) {
			diagnosticErrors.push(
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	};
	const throwWithDiagnosticFailures = (primary: Error): never => {
		if (diagnosticErrors.length > 0)
			throw new AggregateError(
				[primary, ...diagnosticErrors],
				"assembled desktop smoke failed and diagnostics could not be written",
			);
		throw primary;
	};
	report((target) => target.phase("validate-inputs"));
	const launcher = join(resourceRoot, "runtime/local-runtime.mjs");
	const { triple, extension } = targetTriple();
	const bunSidecar = join(
		resourceRoot,
		"sidecars",
		`bun-${triple}${extension}`,
	);
	const guardian = join(
		resourceRoot,
		"sidecars",
		`runtime-guardian-${triple}${extension}`,
	);
	for (const required of [
		launcher,
		bunSidecar,
		...(process.platform === "win32" ? [] : [guardian]),
	]) {
		if (!existsSync(required)) {
			const error = `assembled desktop runtime smoke input is missing: ${required}`;
			report((target) => target.event("input-missing", error));
			throwWithDiagnosticFailures(new Error(error));
		}
	}

	const fixtureRoot = mkdtempSync(
		join(tmpdir(), "forgeax-desktop-runtime-smoke-"),
	);
	const projectRoot = join(fixtureRoot, "projects");
	const stateFile = join(fixtureRoot, "runtime-state.json");
	const legacyGameRoot = join(projectRoot, ".forgeax", "games", gameSlug);
	let child: ChildProcessWithoutNullStreams | undefined;
	let browser: Browser | undefined;
	let context: BrowserContext | undefined;
	let page: Page | undefined;
	let output = "";
	let lastState: Record<string, unknown> | undefined;
	let launcherPid: number | undefined;
	let processObserver: ProcessObserver | undefined;
	const observedPorts = new Set<number>();
	let spawnFailure: Error | undefined;
	let primaryFailure: string | undefined;
	const observed = new Set<string>();
	async function cleanupResources(): Promise<unknown[]> {
		const deadlineMs = Date.now() + SMOKE_CLEANUP_BUDGET_MS;
		const errors: unknown[] = [];
		const cleanup = [
			() =>
				page
					? boundedClose(() => page!.close(), deadlineMs, "page cleanup")
					: Promise.resolve(),
			() =>
				context
					? boundedClose(
							() => context!.close(),
							deadlineMs,
							"browser context cleanup",
						)
					: Promise.resolve(),
			() =>
				browser
					? boundedClose(() => browser!.close(), deadlineMs, "browser cleanup")
					: Promise.resolve(),
			async () => {
				if (!child || !processObserver || launcherPid === undefined) {
					// A spawn error can produce a ChildProcess without a PID.  There is
					// no owned process to wait for, so report it and return promptly.
					if (child && launcherPid === undefined)
						errors.push(
							new Error(
								"launcher spawn failed before a PID was assigned; no process cleanup wait was attempted",
							),
						);
					if (diagnosticErrors.length > 0)
						throw new AggregateError(
							diagnosticErrors,
							"desktop smoke diagnostics could not be written",
						);
					return;
				}
				report((target) => target.phase("cleanup-launcher"));
				let result: Awaited<ReturnType<typeof cleanupRuntimeLauncher>>;
				try {
					result = await cleanupRuntimeLauncher({
						child,
						stateFile,
						pids: [launcherPid],
						processObserver,
						ports: [...observedPorts],
						deadlineMs,
						expectedStartupFailure: primaryFailure || undefined,
					});
				} finally {
					// Stop only after verification: shutdown can create descendants.
					processObserver.stop();
				}
				report((target) =>
					target.event("cleanup-result", {
						terminalState: result.terminalState,
						pids: result.pids,
						ports: result.ports,
						processEvidence: result.processEvidence,
						errors: result.errors.map(serializeDiagnosticError),
					}),
				);
				const allErrors = [...result.errors, ...diagnosticErrors];
				if (allErrors.length > 0)
					throw new AggregateError(
						allErrors,
						"assembled desktop launcher cleanup failed",
					);
			},
			async () => {
				rmSync(fixtureRoot, {
					recursive: true,
					force: true,
					maxRetries: 5,
					retryDelay: 50,
				});
			},
		];
		for (const close of cleanup) {
			try {
				await close();
			} catch (error) {
				errors.push(error);
			}
		}
		return errors;
	}
	const smokeWork = async (): Promise<void> => {
		report((target) => target.phase("create-fixture"));
		mkdirSync(join(legacyGameRoot, "assets"), { recursive: true });
		writeFileSync(
			join(legacyGameRoot, "forge.json"),
			`${JSON.stringify({ id: gameSlug, name: "Legacy material smoke", schemaVersion: "2.0.0", plugins: [{ id: "desktop-smoke", name: "./assets/desktop-smoke.plugin.ts", realm: "engine" }] })}\n`,
		);
		writeFileSync(
			join(legacyGameRoot, "assets", "desktop-smoke.plugin.ts"),
			fixtureMain,
		);
		writeFileSync(
			join(legacyGameRoot, "assets", "desktop-smoke.pack.ts"),
			`import { PackageId } from '@forgeax/engine-pack/guid';
import { ok } from '@forgeax/engine-types';
function packageId(value: string) { const parsed = PackageId.parse(value); if (!parsed.ok) throw parsed.error; return parsed.value; }
export default { schemaVersion: '2.0.0', packageId: packageId('01900000-0000-7000-8000-00000000000b'), name: 'Desktop ScriptablePack smoke', async build() { return ok({ material: { kind: 'material', passes: [{ name: 'Forward', program: { module: 'forgeax::default-unlit' }, renderState: { tags: { LightMode: 'Forward' }, queue: 2000 } }], parameters: [{ name: "baseColor", type: "color" }], values: { baseColor: [0.2, 0.7, 0.4, 1] } } }); } };
`,
		);
		writeFileSync(
			join(legacyGameRoot, "assets", "material.pack.json"),
			`${JSON.stringify({ schemaVersion: "1.0.0", kind: "internal-text-package", assets: [{ guid: jsonPackGuid, kind: "material", payload: { kind: "material", passes: [{ name: "Forward", program: { module: "forgeax::default-unlit" }, renderState: { tags: { LightMode: "Forward" }, queue: 2000 } }], parameters: [{ name: "baseColor", type: "color" }], values: { baseColor: [0.6, 0.6, 0.6, 1] } }, refs: [] }] })}\n`,
		);

		const command = process.platform === "win32" ? bunSidecar : guardian;
		const commandArgs =
			process.platform === "win32"
				? ["run", launcher, "--profile", "desktop-prod"]
				: [
						"--grace-ms",
						"3000",
						"--",
						bunSidecar,
						"run",
						launcher,
						"--profile",
						"desktop-prod",
					];
		report((target) => target.phase("launch-runtime"));
		child = spawn(command, commandArgs, {
			cwd: ideRoot,
			env: {
				...process.env,
				FORGEAX_STARTUP_PROFILE: "desktop-prod",
				FORGEAX_RESOURCE_ROOT: resourceRoot,
				FORGEAX_PROJECT_ROOT: projectRoot,
				FORGEAX_RUNTIME_STATE_FILE: stateFile,
			},
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		child.on("error", (error) => {
			spawnFailure = error instanceof Error ? error : new Error(String(error));
			report((target) =>
				target.event("launcher-spawn-error", {
					name: spawnFailure!.name,
					message: spawnFailure!.message,
				}),
			);
		});
		launcherPid = child.pid;
		if (typeof launcherPid !== "number" || !Number.isSafeInteger(launcherPid)) {
			// node emits spawn errors asynchronously; give that listener one turn so
			// the returned failure retains the native ENOENT/EACCES cause.
			await new Promise<void>((resolvePromise) =>
				setTimeout(resolvePromise, 0),
			);
			if (spawnFailure)
				throw new Error(
					`assembled desktop runtime could not spawn: ${spawnFailure.message}`,
					{ cause: spawnFailure },
				);
			throw new Error(
				"assembled desktop runtime spawn did not provide a launcher PID",
			);
		}
		processObserver = createProcessObserver(child);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			const text = String(chunk);
			output = `${output}${text}`.slice(-65_536);
			report((target) => target.output("stdout", text));
		});
		child.stderr.on("data", (chunk) => {
			const text = String(chunk);
			output = `${output}${text}`.slice(-65_536);
			report((target) => target.output("stderr", text));
		});
		report((target) => target.phase("runtime-readiness"));
		let state: { publicOrigin: string } | undefined;
		let lastReadiness: string | undefined;
		while (deadlineRemaining(smokeDeadline) > 0) {
			if (existsSync(stateFile)) {
				const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as {
					status?: string;
					error?: string;
					publicOrigin?: string;
					servicePids?: Record<string, number>;
					managedPorts?: Record<string, number>;
					readiness?: {
						ready?: boolean;
						services?: Record<string, { ready?: boolean }>;
					};
				};
				lastState = parsed as Record<string, unknown>;
				report((target) => target.state(lastState));
				for (const port of Object.values(
					(parsed.managedPorts ?? {}) as Record<string, unknown>,
				))
					if (typeof port === "number") observedPorts.add(port);
				const readinessDiagnostic = JSON.stringify(parsed.readiness?.services);
				if (readinessDiagnostic !== lastReadiness) {
					console.info("[desktop-smoke readiness]", readinessDiagnostic);
					lastReadiness = readinessDiagnostic;
				}
				if (parsed.status === "failed") {
					primaryFailure = parsed.error ?? "unknown error";
					throw new Error(
						`assembled desktop runtime failed: ${primaryFailure}\nreadiness: ${readinessDiagnostic}\n${output.trim()}`,
					);
				}
				if (
					parsed.status === "ready" &&
					parsed.readiness?.ready &&
					parsed.publicOrigin
				) {
					if (process.platform !== "win32") {
						const services = parsed.readiness.services ?? {};
						if (
							!services.agentHost?.ready ||
							!parsed.servicePids?.["agent-host"] ||
							!parsed.servicePids.server ||
							!parsed.servicePids.engine
						) {
							throw new Error(
								"assembled desktop runtime did not expose three independent POSIX guardians",
							);
						}
					}
					state = { publicOrigin: parsed.publicOrigin };
					break;
				}
			}
			if (spawnFailure)
				throw new Error(
					`assembled desktop runtime could not spawn: ${spawnFailure.message}`,
					{ cause: spawnFailure },
				);
			if (child.exitCode !== null || child.signalCode !== null)
				throw new Error(
					`assembled desktop runtime exited before readiness (${child.exitCode ?? child.signalCode})\n${output.trim()}`,
				);
			await sleep(
				Math.min(
					250,
					requireDeadlineRemaining(smokeDeadline, "runtime readiness polling"),
				),
			);
		}
		if (!state)
			throw new Error(
				"assembled desktop runtime did not become ready before the " +
					SMOKE_MAIN_BUDGET_MS +
					"ms smoke deadline\n" +
					output.trim(),
			);
		report((target) => target.phase("bind-project"));
		const activeResponse = await fetchWithinSmokeBudget(
			state.publicOrigin + "/api/projects/active",
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ slug: gameSlug }),
			},
			smokeDeadline,
			"active project binding request",
		);
		const activeBody = await withinDeadline(
			smokeDeadline,
			"active project response body",
			() => activeResponse.text(),
		);
		if (!activeResponse.ok)
			throw new Error(
				`assembled desktop runtime rejected legacy game binding (${activeResponse.status}): ${activeBody}`,
			);
		const active = JSON.parse(activeBody) as {
			activeSlug?: string;
			runtime?: {
				status?: string;
				binding?: { authority?: string; catalogUrl?: string };
			};
		};
		if (active.activeSlug !== gameSlug || !active.runtime?.binding?.catalogUrl)
			throw new Error(
				`assembled desktop runtime did not bind the legacy game: ${activeBody}`,
			);
		const catalogResponse = await fetchWithinSmokeBudget(
			new URL(active.runtime.binding.catalogUrl, state.publicOrigin),
			undefined,
			smokeDeadline,
			"asset catalog request",
		);
		const catalogBody = await withinDeadline(
			smokeDeadline,
			"asset catalog response body",
			() => catalogResponse.text(),
		);
		if (!catalogResponse.ok)
			throw new Error(
				`assembled desktop runtime rejected its bound asset catalog (${catalogResponse.status}): ${catalogBody}`,
			);
		if (
			active.runtime.status !== "ready" ||
			active.runtime.binding.authority !== "authoritative"
		)
			throw new Error(
				`assembled desktop runtime did not bind the legacy game: ${activeBody}\ncatalog: ${catalogBody}`,
			);
		if (!catalogHasExpectedGuids(JSON.parse(catalogBody)))
			throw new Error(
				`assembled desktop runtime published an incomplete asset catalog: ${catalogBody}`,
			);

		report((target) => target.phase("browser-preview"));
		browser = await withinDeadline(smokeDeadline, "browser launch", () =>
			chromium.launch({
				...browserLaunchOptions(),
				// GPU-less Linux workers still need the compute-capable WebGPU path.
				// These flags apply only to the trusted, local release smoke fixture.
				...(process.platform === "linux"
					? {
							args: [
								"--enable-unsafe-webgpu",
								"--enable-features=Vulkan",
								"--use-angle=vulkan",
								"--use-vulkan=swiftshader",
								"--use-webgpu-adapter=swiftshader",
								"--disable-vulkan-surface",
							],
						}
					: {}),
				timeout: requireDeadlineRemaining(smokeDeadline, "browser launch"),
			}),
		);
		if (process.env.IDE_SMOKE_GPU_DIAGNOSTICS === "1") {
			await withinDeadline(
				smokeDeadline,
				"browser GPU diagnostics",
				async () => {
					const session = await browser!.newBrowserCDPSession();
					try {
						const { gpu } = await session.send("SystemInfo.getInfo");
						console.info("[desktop-smoke GPU]", JSON.stringify(gpu));
					} finally {
						await session.detach();
					}
				},
			);
		}
		context = await withinDeadline(
			smokeDeadline,
			"browser context creation",
			() => browser!.newContext({ viewport: { width: 1440, height: 900 } }),
		);
		page = await withinDeadline(smokeDeadline, "browser page creation", () =>
			context!.newPage(),
		);
		const failures: string[] = [];
		const consoleDiagnostics: Promise<void>[] = [];
		page.on("response", (response) => {
			const failure = observePreviewResponse(
				{ url: response.url(), status: response.status() },
				observed,
			);
			if (failure) failures.push(failure);
		});
		page.on("pageerror", (error) => {
			const classification = classifyConsoleMessage("error", error.message);
			failures.push(
				`${classification ? `page error (${classification})` : "page error"}: ${error.message}`,
			);
		});
		page.on("console", (message) => {
			const classification = classifyConsoleMessage(
				message.type(),
				message.text(),
			);
			if (
				!classification ||
				(message.type() !== "error" && !/ failure$/.test(classification))
			)
				return;
			const index = failures.push(`${classification}: ${message.text()}`) - 1;
			consoleDiagnostics.push(
				Promise.all(
					message
						.args()
						.map((argument) => argument.evaluate(serializeConsoleDiagnostic)),
				)
					.then((details) => {
						failures[index] += `\nconsole arguments: ${details.join(" | ")}`;
					})
					.catch((error: unknown) => {
						failures[index] +=
							`\nconsole argument inspection failed: ${String(error)}`;
					}),
			);
		});
		const documentResponse = await withinDeadline(
			smokeDeadline,
			"preview document navigation",
			() =>
				page!.goto(previewUrl(state.publicOrigin), {
					waitUntil: "domcontentloaded",
					timeout: requireDeadlineRemaining(
						smokeDeadline,
						"preview document navigation",
					),
				}),
		);
		if (documentResponse === null || !documentResponse.ok()) {
			throw new Error(
				`assembled desktop preview document returned ${documentResponse?.status() ?? "no response"}`,
			);
		}
		try {
			await withinDeadline(smokeDeadline, "preview canvas readiness", () =>
				page!.locator(PREVIEW_CANVAS_SELECTOR).waitFor({
					state: "visible",
					timeout: requireDeadlineRemaining(
						smokeDeadline,
						"preview canvas readiness",
					),
				}),
			);
		} catch (error) {
			const dom = await inspectPreviewDom(page);
			throw new Error(
				formatPreviewWaitFailure({
					phase: "preview canvas readiness",
					cause: error,
					failures,
					observedPaths: [...observed],
					requiredPaths: previewRequiredPaths(),
					dom,
				}),
				{ cause: error },
			);
		}
		let submittedFrame: string;
		try {
			submittedFrame = await waitForFrameSubmission(
				() =>
					page!.evaluate(
						(frameSubmittedAttribute) =>
							document.documentElement.getAttribute(frameSubmittedAttribute),
						PREVIEW_FRAME_SUBMITTED_ATTRIBUTE,
					),
				smokeDeadline,
			);
		} catch (error) {
			const dom = await inspectPreviewDom(page);
			throw new Error(
				formatPreviewWaitFailure({
					phase: "first frame submission readiness",
					cause: error,
					failures,
					observedPaths: [...observed],
					requiredPaths: previewRequiredPaths(),
					dom,
				}),
				{ cause: error },
			);
		}
		try {
			await withinDeadline(smokeDeadline, "console error diagnostics", () =>
				Promise.all(consoleDiagnostics),
			);
			await withinDeadline(
				smokeDeadline,
				"preview post-readiness verification",
				() =>
					verifyPreviewPostReadiness({
						serializeFrame: async () => JSON.stringify(submittedFrame),
						failures,
						observedPaths: [...observed],
						requiredPaths: previewRequiredPaths(),
					}),
			);
		} catch (error) {
			const dom = await inspectPreviewDom(page);
			throw new Error(
				formatPreviewWaitFailure({
					phase: "preview post-readiness verification",
					cause: error,
					failures,
					observedPaths: [...observed],
					requiredPaths: previewRequiredPaths(),
					dom,
				}),
				{ cause: error },
			);
		}
	};
	await runWithSmokeCleanup({
		run: smokeWork,
		cleanup: cleanupResources,
		report: (name, detail) => {
			if (!diagnostic) return;
			diagnostic.event(name, detail);
			if (name === "primary-failure" && lastState) diagnostic.state(lastState);
		},
	});
	console.log(
		JSON.stringify({
			code: "IDE_ASSEMBLED_DESKTOP_RUNTIME_SMOKE_OK",
			platform: process.platform,
			arch: process.arch,
			observedPaths: [...observed],
		}),
	);
}

if (import.meta.main) await runSmoke();
