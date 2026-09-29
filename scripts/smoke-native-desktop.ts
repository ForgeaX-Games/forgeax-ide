#!/usr/bin/env bun

import {
	type ChildProcessWithoutNullStreams,
	spawn,
	spawnSync,
} from "node:child_process";
/**
 * Product-package native desktop smoke.
 *
 * This intentionally drives a bundled release .app through Appium Mac2 rather
 * than starting the resource launcher or a standalone browser.  The outer
 * process owns diagnostics and post-Quit checks, so an unavailable WebDriver
 * session cannot erase evidence of an earlier product-start failure.
 */
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type Browser, remote } from "webdriverio";
import {
	assessNativeDesktopFaultOracle,
	cleanupNativeDesktopFault,
	NATIVE_DESKTOP_FAULT_SCENARIOS,
	type NativeDesktopFaultPhase,
	type NativeDesktopFaultScenario,
	stageNativeDesktopFaultCopy,
} from "./native-desktop-faults";
import {
	type NativeDesktopRuntimeState,
	validateNativeDesktopRuntimeState,
} from "./native-desktop-runtime-contract";
import { verifyNativeProductReceipt } from "./native-product-receipt";
import {
	createSmokeDiagnostic,
	serializeDiagnosticError,
	verifyPortsReleased,
	waitForPortsReleasedUntil,
} from "./smoke-assembled-desktop-runtime";
import {
	createProcessObserver,
	type ProcessEvidence,
	type ProcessIdentity,
	type ProcessObserver,
	type ProcessSnapshot,
	parsePosixProcessSnapshot,
} from "./smoke-process-evidence";
import { verifyApplicationExecutable } from "./verify-macos-bundle";

const DEFAULT_APPIUM_PORT = 47_273;
const APP_START_TIMEOUT_MS = 120_000;
const APP_QUIT_TIMEOUT_MS = 25_000;
const MAC2_SESSION_TIMEOUT_MS = 270_000;
const MAC2_COMMAND_TIMEOUT_MS = 30_000;
const NATIVE_SMOKE_BUDGET_MS = 330_000;
const NATIVE_CLEANUP_BUDGET_MS = 55_000;

export type NativeSmokeOptions = {
	readonly app: string;
	readonly appiumPort: number;
	readonly keepArtifacts: boolean;
	readonly revision?: string;
	readonly fault?: NativeDesktopFaultScenario;
};
export type MacosAppIdentity = {
	readonly app: string;
	readonly executable: string;
	readonly bundleIdentifier: string;
	readonly executableSha256: string;
	readonly bundleSha256: string;
};

type RuntimeState = NativeDesktopRuntimeState & {
	readonly error?: unknown;
	readonly startedAt?: unknown;
	readonly updatedAt?: unknown;
};
type NativeBrowser = Browser;
class FatalNativeSmokeError extends Error {}
class MacNativeFocusLostError extends Error {}

export function parseNativeSmokeOptions(
	args = Bun.argv.slice(2),
): NativeSmokeOptions {
	const appIndex = args.indexOf("--app");
	const app = appIndex < 0 ? undefined : args[appIndex + 1];
	if (!app || app.startsWith("--"))
		throw new Error(
			"usage: bun run smoke:native-desktop --app <release .app> [--appium-port <port>] [--keep-artifacts]",
		);
	const portIndex = args.indexOf("--appium-port");
	const portRaw = portIndex < 0 ? undefined : args[portIndex + 1];
	const appiumPort =
		portRaw === undefined ? DEFAULT_APPIUM_PORT : Number(portRaw);
	if (
		!Number.isSafeInteger(appiumPort) ||
		appiumPort < 1 ||
		appiumPort > 65_535
	)
		throw new Error("appium port must be an integer from 1 to 65535");
	const revisionIndex = args.indexOf("--revision");
	const revision =
		revisionIndex < 0
			? process.env.FORGEAX_CI_IDE_REVISION?.trim()
			: args[revisionIndex + 1];
	if (revision !== undefined && !/^[0-9a-f]{40}$/i.test(revision))
		throw new Error(
			"--revision must be an immutable 40-character IDE revision",
		);
	const faultIndex = args.indexOf("--fault");
	const faultRaw = faultIndex < 0 ? undefined : args[faultIndex + 1];
	if (
		faultRaw !== undefined &&
		!NATIVE_DESKTOP_FAULT_SCENARIOS.includes(
			faultRaw as NativeDesktopFaultScenario,
		)
	)
		throw new Error(
			`--fault must be one of: ${NATIVE_DESKTOP_FAULT_SCENARIOS.join(", ")}`,
		);
	return {
		app: resolve(app),
		appiumPort,
		keepArtifacts: args.includes("--keep-artifacts"),
		...(revision ? { revision } : {}),
		...(faultRaw ? { fault: faultRaw as NativeDesktopFaultScenario } : {}),
	};
}

/** Stages a receipt-owned copy and proves early product rejection before any driver is allowed to speak for it. */
export async function runMacosNativeFaultSmoke(
	options: NativeSmokeOptions,
): Promise<string> {
	if (!options.fault) throw new Error("fault scenario is required");
	const projectRoot = realpathSync(
		mkdtempSync(join(tmpdir(), "forgeax-native-fault-project-")),
	);
	const diagnosticRoot = process.env.IDE_NATIVE_SMOKE_DIAGNOSTIC_DIR?.trim();
	const diagnosticErrors: Error[] = [];
	const diagnostics = safeDiagnostic(
		createSmokeDiagnostic(
			diagnosticRoot
				? join(resolve(diagnosticRoot), `run-${process.pid}-${Date.now()}`)
				: undefined,
		),
		diagnosticErrors,
	);
	const receipt = stageNativeDesktopFaultCopy(options.app, options.fault, {
		projectRoot,
	});
	let productFailure:
		| {
				phase: "preflight" | "startup" | "readiness" | "validator" | "cleanup";
				code?: string;
		  }
		| undefined;
	let productError: string | undefined;
	let preflightRejection: "identity" | "signature" | undefined;
	let primaryError: Error | undefined;
	const cleanupErrors: string[] = [];
	let cleanupEvidence:
		| {
				readonly stateRemoved: boolean;
				readonly fixturePidReleased: boolean;
				readonly fixturePortReleased: boolean;
		  }
		| undefined;
	let liveApp: ProcessIdentity | undefined;
	let inspectedCopy: MacosAppIdentity | undefined;
	let observer: ProcessObserver | undefined;
	let observerClean = true;
	let lastStateSignature = "";
	let readiness503Observed = false;
	if (receipt.evidenceKind === "harness-control") {
		diagnostics.event("fault-receipt", receipt);
		diagnostics.event("fault-isolated-project-root", { projectRoot });
		await runNativeFaultHarnessControl(receipt, diagnostics, diagnosticErrors);
		return diagnostics.directory;
	}
	try {
		diagnostics.event("fault-receipt", receipt);
		diagnostics.event("fault-isolated-project-root", { projectRoot });
		try {
			// This is deliberately before WebDriver: a malformed bundle must be
			// attributed to product/package preflight, never to unavailable GUI automation.
			try {
				inspectedCopy = inspectMacosApp(receipt.copyArtifact);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const rejection = classifyNativeFaultPreflight(options.fault, message);
				if (!rejection) throw error;
				productFailure = { phase: receipt.phase, code: rejection.code };
				productError = message;
				preflightRejection = rejection.kind;
				diagnostics.event("fault-product-preflight-rejection", {
					...rejection,
					error: serializeDiagnosticError(error),
				});
			}
			if (!productFailure) {
				const executable = realpathSync(
					join(
						receipt.copyArtifact,
						"Contents",
						"MacOS",
						plistValue(receipt.copyArtifact, "CFBundleExecutable"),
					),
				);
				diagnostics.event("fault-product-before-launch", {
					executable,
					projectRoot,
					sourceArtifact: receipt.sourceArtifact,
					copyArtifact: receipt.copyArtifact,
				});
				// Per-process Cocoa launch argument: keeps the isolated fault instance
				// out of macOS crash/state restoration without changing global defaults.
				const child = spawn(
					executable,
					["-ApplePersistenceIgnoreState", "YES"],
					{
						cwd: projectRoot,
						env: { ...process.env, FORGEAX_PROJECT_ROOT: projectRoot },
						stdio: "pipe",
					},
				);
				let productStderr = "";
				child.stdout.on("data", (chunk) =>
					diagnostics.output("stdout", `[fault-product] ${String(chunk)}`),
				);
				child.stderr.on("data", (chunk) => {
					productStderr += String(chunk);
					diagnostics.output("stderr", `[fault-product] ${String(chunk)}`);
				});
				if (!child.pid)
					throw new Error("native fault product spawn did not return a PID");
				const appIdentity = await waitUntil(
					"fault product creation identity",
					Date.now() + 5_000,
					() => {
						const current = snapshotProcesses().find(
							(value) => value.pid === child.pid,
						);
						return current
							? { pid: current.pid, startedAt: current.startedAt }
							: undefined;
					},
				);
				// From this point the copy is in use. Any error path must retain the
				// staging root until this exact creation identity has exited normally.
				liveApp = appIdentity;
				observer = createProcessObserver(
					{ pid: appIdentity.pid },
					{ explicitRootIdentity: appIdentity, pollIntervalMs: 50 },
				);
				diagnostics.event("fault-product-identity", {
					executable,
					identity: appIdentity,
				});
				const stateFile = join(
					projectRoot,
					".forgeax",
					"runtime",
					`desktop-prod-${child.pid}.json`,
				);
				const stateDeadline =
					Date.now() + (receipt.phase === "readiness" ? 135_000 : 35_000);
				const observed = await waitUntil(
					"failed runtime state",
					stateDeadline,
					async () => {
						if (!existsSync(stateFile)) {
							if (child.exitCode !== null || child.signalCode !== null)
								throw new FatalNativeSmokeError(
									`native app exited before runtime state: code=${child.exitCode ?? "null"} signal=${child.signalCode ?? "none"} stderr=${productStderr}`,
								);
							return undefined;
						}
						const state = JSON.parse(
							readFileSync(stateFile, "utf8"),
						) as RuntimeState;
						diagnostics.state(state);
						const signature = `${state.status}:${JSON.stringify(state.error ?? null)}`;
						if (signature !== lastStateSignature) {
							lastStateSignature = signature;
							diagnostics.event("fault-runtime-state-observed", {
								stateFile,
								status: state.status,
								error: state.error,
								launcherPid: state.launcherPid,
								servicePids: state.servicePids,
							});
						}
						if (
							options.fault === "readiness-timeout" &&
							!readiness503Observed &&
							(
								state.readiness as
									| { services?: { server?: { status?: unknown } } }
									| undefined
							)?.services?.server?.status === 503 &&
							typeof state.publicOrigin === "string"
						) {
							const response = await boundedFaultHealthFetch(
								`${state.publicOrigin}/api/health`,
								stateDeadline,
							);
							const body = await boundedFaultResponseText(
								response,
								stateDeadline,
							);
							diagnostics.event("fault-readiness-health-curl", {
								url: `${state.publicOrigin}/api/health`,
								status: response.status,
								body,
							});
							if (response.status !== 503)
								throw new Error(
									`fault readiness health probe expected 503, observed ${response.status}`,
								);
							readiness503Observed = true;
						}
						observer?.observeStateRoots(faultStateProcessIdentities(state));
						return state.status === "failed" ? state : undefined;
					},
				);
				productError =
					typeof observed.error === "string"
						? observed.error
						: JSON.stringify(observed.error ?? null);
				const classified = classifyNativeFaultRuntime(
					options.fault,
					observed,
					productError,
				);
				if (!classified)
					throw new Error(
						`runtime state failed, but its actual failure does not match ${options.fault}: ${productError}`,
					);
				productFailure = classified;
				const ports = Object.values(observed.managedPorts ?? {}).filter(
					(port): port is number =>
						typeof port === "number" && Number.isSafeInteger(port),
				);
				const portErrors = await waitForPortsReleasedUntil(
					ports,
					Date.now() + 15_000,
				);
				diagnostics.event("fault-runtime-terminal", {
					stateFile,
					status: observed.status,
					error: productError,
					classified,
					ports,
					portErrors,
					appExited: child.exitCode !== null || child.signalCode !== null,
				});
				if (portErrors.length)
					throw new Error(
						`failed runtime left dynamic ports bound: ${portErrors.join("; ")}`,
					);
				if (identityIsLive(appIdentity)) {
					if (!inspectedCopy)
						throw new Error(
							"fault product identity was unavailable for normal native Quit",
						);
					diagnostics.event("fault-runtime-before-native-quit", {
						app: inspectedCopy.app,
						identity: appIdentity,
						ports,
					});
					await requestNativeQuit(inspectedCopy, appIdentity);
					await waitUntil("normal native Quit", Date.now() + 25_000, () =>
						identityIsLive(appIdentity) ? undefined : true,
					);
					liveApp = undefined;
					const postQuitPortErrors = await waitForPortsReleasedUntil(
						ports,
						Date.now() + 15_000,
					);
					diagnostics.event("fault-runtime-after-native-quit", {
						identity: appIdentity,
						ports,
						portErrors: postQuitPortErrors,
					});
					if (postQuitPortErrors.length)
						throw new Error(
							`normal native Quit left dynamic ports bound: ${postQuitPortErrors.join("; ")}`,
						);
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const early = !productFailure
				? classifyNativeFaultEarly(options.fault, message)
				: undefined;
			if (early) {
				productFailure = early;
				productError = message;
			} else {
				productError ??= message;
				primaryError ??= error instanceof Error ? error : new Error(message);
			}
			diagnostics.event(
				"fault-product-failure",
				serializeDiagnosticError(error),
			);
		}
	} finally {
		if (liveApp && identityIsLive(liveApp)) {
			try {
				if (!inspectedCopy) {
					cleanupErrors.push(
						"could not normally quit owned app because package identity was unavailable",
					);
				} else {
					diagnostics.event("fault-finally-native-quit", {
						app: inspectedCopy.app,
						identity: liveApp,
					});
					await requestNativeQuit(inspectedCopy, liveApp);
					await waitUntil(
						"finally normal native Quit",
						Date.now() + 25_000,
						() => (identityIsLive(liveApp!) ? undefined : true),
					);
				}
			} catch (error) {
				cleanupErrors.push(
					error instanceof Error ? error.message : String(error),
				);
			}
		}
		if (observer) {
			try {
				const tree = await observer.verify(Date.now() + 15_000);
				diagnostics.event("fault-finally-runtime-tree", tree);
				if (tree.errors.length || tree.liveMembers.length) {
					observerClean = false;
					cleanupErrors.push(
						`owned runtime tree remained after product exit: ${[...tree.errors, ...tree.liveMembers.map((member) => `pid ${member.pid}`)].join("; ")}`,
					);
				}
			} catch (error) {
				observerClean = false;
				cleanupErrors.push(
					error instanceof Error ? error.message : String(error),
				);
			}
		}
		if (liveApp && identityIsLive(liveApp))
			cleanupErrors.push(
				`product app remained live after normal native Quit: pid=${liveApp.pid} startedAt=${liveApp.startedAt}`,
			);
		else if (observerClean)
			try {
				cleanupEvidence = await cleanupNativeDesktopFault(receipt);
			} catch (error) {
				cleanupErrors.push(
					error instanceof Error ? error.message : String(error),
				);
			}
		observer?.stop();
	}
	const cleanup = cleanupEvidence ?? {
		stateRemoved: false,
		fixturePidReleased: false,
		fixturePortReleased: false,
	};
	const diagnosticsWritten =
		diagnosticErrors.length === 0 &&
		existsSync(join(diagnostics.directory, "events.ndjson")) &&
		existsSync(join(diagnostics.directory, "run.json"));
	const verdict = assessNativeDesktopFaultOracle(receipt, {
		phase: productFailure?.phase,
		code: productFailure?.code,
		productError,
		preflightRejection,
		diagnosticsWritten,
		cleanup,
	});
	diagnostics.event("fault-verdict", {
		...verdict,
		cleanupErrors,
		diagnosticErrors: diagnosticErrors.map((error) => error.message),
		liveApp,
	});
	if (
		verdict.verdict !== "product-failure-confirmed" ||
		primaryError ||
		cleanupErrors.length ||
		diagnosticErrors.length
	)
		throw new AggregateError(
			[
				...(primaryError ? [primaryError] : []),
				...cleanupErrors.map((message) => new Error(message)),
				...diagnosticErrors,
			],
			`native fault scenario was not confirmed: ${verdict.verdict}: ${verdict.errors.join("; ")}; diagnostics: ${diagnostics.directory}`,
		);
	return diagnostics.directory;
}

export async function verifyNativeDesktopResidualHarnessPrecleanup(
	receipt: ReturnType<typeof stageNativeDesktopFaultCopy>,
): Promise<{
	readonly process: ProcessEvidence;
	readonly portErrors: readonly string[];
}> {
	const fixture = receipt.residualFixture;
	if (
		!fixture ||
		!receipt.residualStatePath ||
		!existsSync(receipt.residualStatePath)
	)
		throw new Error(
			"residual harness receipt did not retain its owned state and fixture",
		);
	const identity = await waitUntil(
		"residual fixture creation identity",
		Date.now() + 2_000,
		() => {
			const current = snapshotProcesses().find(
				(value) => value.pid === fixture.pid,
			);
			return current
				? { pid: current.pid, startedAt: current.startedAt }
				: undefined;
		},
	);
	const observer = createProcessObserver(
		{ pid: identity.pid },
		{ explicitRootIdentity: identity, pollIntervalMs: 20 },
	);
	try {
		const process = observer.snapshot();
		const portErrors = await verifyPortsReleased([fixture.port]);
		if (
			!process.liveMembers.some((member) => member.pid === fixture.pid) ||
			portErrors.length === 0
		) {
			throw new Error(
				`residual harness precleanup verifier did not reject its live fixture: process=${process.liveMembers.map((member) => member.pid).join(",")} portErrors=${portErrors.join("; ")}`,
			);
		}
		return { process, portErrors };
	} finally {
		observer.stop();
	}
}

async function runNativeFaultHarnessControl(
	receipt: ReturnType<typeof stageNativeDesktopFaultCopy>,
	diagnostics: ReturnType<typeof safeDiagnostic>,
	diagnosticErrors: readonly Error[],
): Promise<void> {
	let primary: Error | undefined;
	let cleanupError: Error | undefined;
	try {
		if (receipt.scenario === "negative-validator") {
			let rejected = false;
			try {
				inspectMacosApp(receipt.copyArtifact);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const rejection = classifyNativeFaultPreflight(
					receipt.scenario,
					message,
				);
				if (!rejection || rejection.code !== receipt.code) throw error;
				diagnostics.event("fault-harness-negative-validator", {
					rejection,
					productFailure: false,
					error: serializeDiagnosticError(error),
				});
				rejected = true;
			}
			if (!rejected)
				throw new Error(
					"negative validator copy unexpectedly passed the real product verifier",
				);
		} else if (receipt.scenario === "residual-runtime") {
			const fixture = receipt.residualFixture!;
			const precleanup =
				await verifyNativeDesktopResidualHarnessPrecleanup(receipt);
			diagnostics.event("fault-harness-residual-precleanup", {
				productFailure: false,
				statePath: receipt.residualStatePath,
				fixture,
				...precleanup,
			});
		} else {
			throw new Error(
				`unsupported harness-control scenario: ${receipt.scenario}`,
			);
		}
	} catch (error) {
		primary = error instanceof Error ? error : new Error(String(error));
	}
	try {
		const cleanup = await cleanupNativeDesktopFault(receipt);
		diagnostics.event("fault-harness-control-cleanup", cleanup);
	} catch (error) {
		cleanupError = error instanceof Error ? error : new Error(String(error));
	}
	if (diagnosticErrors.length || primary || cleanupError)
		throw new AggregateError(
			[
				...(primary ? [primary] : []),
				...(cleanupError ? [cleanupError] : []),
				...diagnosticErrors,
			],
			"harness-control assertion or cleanup failed",
		);
}

function classifyNativeFaultPreflight(
	scenario: NativeDesktopFaultScenario,
	error: string,
):
	| { readonly kind: "identity" | "signature"; readonly code: string }
	| undefined {
	if (
		scenario === "negative-validator" &&
		/unexpected product bundle identifier|expected identifier|invalid IDE executable/i.test(
			error,
		)
	) {
		return { kind: "identity", code: "INVALID_PRODUCT_IDENTITY" };
	}
	// A mutated resource that failed before the product could start is a package
	// rejection, never evidence for a runtime phase. Only the explicit validator
	// scenario is permitted to use this class as its expected observation.
	if (
		scenario === "negative-validator" &&
		/signature verification failed|codesign .* failed/i.test(error)
	) {
		return { kind: "signature", code: "INVALID_PRODUCT_IDENTITY" };
	}
	return undefined;
}

export function classifyNativeFaultEarly(
	scenario: NativeDesktopFaultScenario,
	error: string,
):
	| { readonly phase: NativeDesktopFaultPhase; readonly code: string }
	| undefined {
	if (
		scenario === "missing-launcher" &&
		/bundled runtime launcher is missing/i.test(error)
	)
		return { phase: "preflight", code: "MISSING_LAUNCHER" };
	if (
		scenario === "sidecar-not-executable" &&
		/Failed to setup app: error encountered during setup hook: Permission denied \(os error 13\)/.test(
			error,
		)
	) {
		return { phase: "preflight", code: "SIDECAR_NOT_EXECUTABLE" };
	}
	if (
		scenario === "path-permission" &&
		/Failed to setup app: error encountered during setup hook: Permission denied \(os error 13\)/.test(
			error,
		)
	) {
		return { phase: "preflight", code: "PATH_PERMISSION_DENIED" };
	}
	return undefined;
}

async function boundedFaultHealthFetch(
	url: string,
	deadline: number,
): Promise<Response> {
	const remaining = deadline - Date.now();
	if (remaining <= 0)
		throw new Error("readiness health probe began after the fault deadline");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), remaining);
	try {
		return await fetch(url, { signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

async function boundedFaultResponseText(
	response: Response,
	deadline: number,
): Promise<string> {
	const remaining = deadline - Date.now();
	if (remaining <= 0)
		throw new Error(
			"readiness health response body began after the fault deadline",
		);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), remaining);
	const reader = response.body?.getReader();
	try {
		// The injected JSON response is tiny. Reading a bounded stream avoids a
		// malicious/buggy service keeping this fault acceptance run alive forever.
		if (!reader) return "";
		const chunks: Uint8Array[] = [];
		let size = 0;
		while (true) {
			const next = await Promise.race([
				reader.read(),
				new Promise<never>((_, reject) =>
					controller.signal.addEventListener(
						"abort",
						() =>
							reject(
								new Error(
									"readiness health response body exceeded fault deadline",
								),
							),
						{ once: true },
					),
				),
			]);
			if (next.done) break;
			size += next.value.byteLength;
			if (size > 16 * 1024)
				throw new Error("readiness health response body exceeded 16KiB");
			chunks.push(next.value);
		}
		return new TextDecoder().decode(Buffer.concat(chunks));
	} finally {
		clearTimeout(timer);
		// Promise.race cannot cancel a pending stream read. Explicitly cancel the
		// reader so a slow body cannot keep an owned socket alive after timeout.
		if (reader)
			try {
				await reader.cancel();
			} catch {
				/* stream already closed */
			}
	}
}

function classifyNativeFaultRuntime(
	scenario: NativeDesktopFaultScenario,
	state: RuntimeState,
	error: string,
):
	| { readonly phase: NativeDesktopFaultPhase; readonly code: string }
	| undefined {
	if (
		scenario === "missing-launcher" &&
		/bundled runtime launcher is missing/i.test(error)
	)
		return { phase: "preflight", code: "MISSING_LAUNCHER" };
	if (
		scenario === "sidecar-not-executable" &&
		/permission denied|operation not permitted|failed to spawn/i.test(error)
	)
		return { phase: "preflight", code: "SIDECAR_NOT_EXECUTABLE" };
	if (
		scenario === "path-permission" &&
		/permission denied|operation not permitted|failed to spawn/i.test(error)
	)
		return { phase: "preflight", code: "PATH_PERMISSION_DENIED" };
	if (
		scenario === "mid-start-failure" &&
		/server.*(exited|readiness)|permission denied|operation not permitted/i.test(
			error,
		)
	)
		return { phase: "startup", code: "STARTUP_FAILURE" };
	const readiness = state.readiness as
		| {
				readonly services?: { readonly server?: { readonly status?: unknown } };
		  }
		| undefined;
	if (
		scenario === "readiness-timeout" &&
		/packaged runtime did not become ready within 120 seconds/i.test(error) &&
		readiness?.services?.server?.status === 503
	)
		return { phase: "readiness", code: "READINESS_TIMEOUT" };
	return undefined;
}

/** Failed/starting states are intentionally not accepted by the ready-state contract. */
function faultStateProcessIdentities(state: RuntimeState): ProcessIdentity[] {
	const candidates = [
		state.launcherPid,
		...Object.values(state.servicePids ?? {}),
	].filter(
		(pid): pid is number =>
			typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0,
	);
	const snapshot = snapshotProcesses();
	return candidates.flatMap((pid) => {
		const row = snapshot.find((value) => value.pid === pid);
		return row ? [{ pid: row.pid, startedAt: row.startedAt }] : [];
	});
}

function plistValue(app: string, key: string): string {
	const result = spawnSync(
		"/usr/libexec/PlistBuddy",
		["-c", `Print :${key}`, join(app, "Contents", "Info.plist")],
		{ encoding: "utf8" },
	);
	if (result.status !== 0)
		throw new Error(
			`could not read ${key} from product Info.plist: ${result.stderr.trim() || result.error?.message || result.status}`,
		);
	const value = result.stdout.trim();
	if (!value) throw new Error(`product Info.plist has no ${key}`);
	return value;
}

function hashFile(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** A deterministic manifest digest makes a copied or changed package visible in evidence. */
function hashBundle(root: string): string {
	const rows: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
			(a, b) => a.name.localeCompare(b.name),
		)) {
			const absolute = join(directory, entry.name);
			const relative = absolute.slice(root.length + 1);
			if (entry.isDirectory()) visit(absolute);
			else if (entry.isFile())
				rows.push(
					`${relative}\u0000${statSync(absolute).mode & 0o777}\u0000${hashFile(absolute)}`,
				);
			else if (entry.isSymbolicLink())
				throw new Error(
					`product bundle contains a symlink and cannot be identity-hashed safely: ${relative}`,
				);
		}
	};
	visit(root);
	return createHash("sha256").update(rows.join("\n")).digest("hex");
}

export function inspectMacosApp(input: string): MacosAppIdentity {
	const requested = resolve(input);
	if (process.platform !== "darwin")
		throw new Error(
			"macOS native smoke requires a macOS host; use the Windows adapter for a .exe",
		);
	if (
		!requested.endsWith(".app") ||
		!existsSync(requested) ||
		!statSync(requested).isDirectory()
	)
		throw new Error(
			`--app must name an existing release .app bundle: ${requested}`,
		);
	const app = realpathSync(requested);
	const executableName = plistValue(app, "CFBundleExecutable");
	const executable = realpathSync(
		join(app, "Contents", "MacOS", executableName),
	);
	if (!existsSync(executable) || !statSync(executable).isFile())
		throw new Error(`release app executable is missing: ${executable}`);
	const bundleIdentifier = plistValue(app, "CFBundleIdentifier");
	if (bundleIdentifier !== "com.forgeax.ide")
		throw new Error(
			`unexpected product bundle identifier: ${bundleIdentifier}`,
		);
	// Keep this in step with the release verifier: a bundle-id lookalike must
	// never become product evidence merely because it has a similarly named app.
	verifyApplicationExecutable(app);
	// `verifyApplicationExecutable` is intentionally small for other callers.
	// Native product evidence needs the complete release verifier too: the
	// application entitlement and vendor-signed bundled Bun are part of the
	// package identity, not optional smoke conveniences.
	const releaseVerifier = spawnSync(
		"bun",
		[
			"run",
			resolve(import.meta.dirname, "verify-macos-bundle.ts"),
			"--app",
			app,
		],
		{ encoding: "utf8", timeout: 30_000 },
	);
	if (releaseVerifier.status !== 0 || releaseVerifier.error)
		throw new Error(
			`release product verifier rejected bundle: ${releaseVerifier.error?.message ?? releaseVerifier.stderr.trim()}`,
		);
	const signature = spawnSync(
		"codesign",
		["--verify", "--deep", "--strict", "--verbose=2", app],
		{ encoding: "utf8", timeout: 20_000 },
	);
	if (signature.status !== 0 || signature.error)
		throw new Error(
			`release app signature verification failed: ${signature.error?.message ?? signature.stderr.trim()}`,
		);
	return {
		app,
		executable,
		bundleIdentifier,
		executableSha256: hashFile(executable),
		bundleSha256: hashBundle(app),
	};
}

function snapshotProcesses(): ProcessSnapshot[] {
	const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart="], {
		encoding: "utf8",
		timeout: 2_000,
	});
	if (result.status !== 0 || result.error)
		throw new Error(
			`could not capture process identities: ${result.error?.message ?? result.stderr}`,
		);
	return parsePosixProcessSnapshot(result.stdout);
}

type CommandProcessSnapshot = ProcessSnapshot & { readonly command: string };

/** Keep executable path and creation time in the same ps sample; never join two racing snapshots by PID. */
function snapshotCommandProcesses(): CommandProcessSnapshot[] {
	const result = spawnSync(
		"ps",
		["-axo", "pid=,ppid=,pgid=,lstart=,command="],
		{ encoding: "utf8", timeout: 2_000 },
	);
	if (result.status !== 0 || result.error)
		throw new Error(
			`could not capture product process identities: ${result.error?.message ?? result.stderr}`,
		);
	const rows: CommandProcessSnapshot[] = [];
	for (const line of result.stdout.split("\n").filter(Boolean)) {
		// `lstart` is the fixed-width 24-character field emitted by BSD ps.
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/.exec(line);
		if (!match || !match[5])
			throw new Error(`could not parse product process identity row: ${line}`);
		rows.push({
			pid: Number(match[1]),
			parentPid: Number(match[2]),
			processGroupId: Number(match[3]),
			startedAt: match[4].trim(),
			command: match[5],
		});
	}
	if (rows.length === 0)
		throw new Error(
			"product process snapshot is empty and cannot prove identity",
		);
	return rows;
}

function appProcesses(identity: MacosAppIdentity): ProcessIdentity[] {
	return snapshotCommandProcesses().flatMap((row) => {
		// Exact executable argv0 only. A package path in another process argument
		// never grants us ownership of that process.
		if (
			!(
				row.command === identity.executable ||
				row.command.startsWith(`${identity.executable} `)
			)
		)
			return [];
		return [{ pid: row.pid, startedAt: row.startedAt }];
	});
}

type AppLaunchWatcher = {
	readonly take: () => ProcessIdentity | undefined;
	readonly stop: () => void;
};

/** Starts before WebDriver can launch the bundle, so a failed session cannot erase ownership evidence. */
function watchNewProductProcess(
	identity: MacosAppIdentity,
	baseline: readonly ProcessIdentity[],
	onFound: (identity: ProcessIdentity) => void,
	onError: (error: Error) => void,
): AppLaunchWatcher {
	const before = new Set(
		baseline.map((value) => `${value.pid}:${value.startedAt}`),
	);
	let found: ProcessIdentity | undefined;
	let stopped = false;
	const inspect = (): void => {
		if (stopped || found) return;
		try {
			const candidates = appProcesses(identity).filter(
				(value) => !before.has(`${value.pid}:${value.startedAt}`),
			);
			if (candidates.length > 1)
				throw new Error(
					"multiple newly launched product executable processes appeared; refusing ambiguous ownership",
				);
			if (candidates.length === 1) {
				found = candidates[0];
				onFound(found);
			}
		} catch (error) {
			onError(error instanceof Error ? error : new Error(String(error)));
		}
	};
	inspect();
	const timer = setInterval(inspect, 50);
	return {
		take: () => {
			inspect();
			return found;
		},
		stop: () => {
			stopped = true;
			clearInterval(timer);
		},
	};
}

function identityIsLive(identity: ProcessIdentity): boolean {
	return snapshotProcesses().some(
		(value) =>
			value.pid === identity.pid && value.startedAt === identity.startedAt,
	);
}

async function waitUntil<T>(
	description: string,
	deadline: number,
	operation: () => T | undefined | Promise<T | undefined>,
): Promise<T> {
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			const value = await operation();
			if (value !== undefined) return value;
		} catch (error) {
			if (error instanceof FatalNativeSmokeError) throw error;
			last = error;
		}
		await sleep(150);
	}
	throw new Error(
		`${description} did not complete before its deadline${last instanceof Error ? `: ${last.message}` : ""}`,
	);
}

async function withinNativeDeadline<T>(
	description: string,
	deadline: number,
	operation: Promise<T>,
): Promise<T> {
	const remaining = deadline - Date.now();
	if (remaining <= 0)
		throw new Error(
			`native desktop overall deadline elapsed before ${description}`,
		);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<T>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(
								`${description} exceeded the native desktop overall deadline`,
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

async function appiumStatus(
	port: number,
	timeoutMs = 5_000,
): Promise<{ ready?: boolean }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let response: Response;
	try {
		response = await fetch(`http://127.0.0.1:${port}/status`, {
			signal: controller.signal,
		});
		const body = await response.text();
		if (body.length > 65_536)
			throw new Error("Appium status body exceeded 65536 bytes");
		const payload = JSON.parse(body) as {
			value?: { ready?: boolean };
			message?: string;
		};
		if (!response.ok)
			throw new Error(
				`Appium status failed: ${payload.message ?? JSON.stringify(payload)}`,
			);
		return payload.value ?? {};
	} catch (error) {
		throw new Error(`Appium status request exceeded ${timeoutMs}ms`, {
			cause: error,
		});
	} finally {
		clearTimeout(timer);
	}
}

function assertPortOwnedByChild(
	port: number,
	child: ChildProcessWithoutNullStreams,
	label: string,
): void {
	if (!child.pid)
		throw new Error(`${label} has no PID for listener ownership verification`);
	const listeners = spawnSync(
		"lsof",
		["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"],
		{ encoding: "utf8", timeout: 5_000 },
	);
	if (listeners.status !== 0 || listeners.error)
		throw new Error(
			`could not inspect ${label} listener ownership: ${listeners.error?.message ?? listeners.stderr}`,
		);
	const pids = listeners.stdout
		.split("\n")
		.filter((line) => /^p\d+$/.test(line))
		.map((line) => Number(line.slice(1)));
	if (pids.length !== 1)
		throw new Error(`${label} listener ownership is ambiguous on port ${port}`);
	const byPid = new Map(snapshotProcesses().map((value) => [value.pid, value]));
	let current = byPid.get(pids[0]);
	const seen = new Set<number>();
	while (current && !seen.has(current.pid)) {
		if (current.pid === child.pid) return;
		seen.add(current.pid);
		current = byPid.get(current.parentPid);
	}
	throw new Error(
		`${label} listener on port ${port} is not owned by this run's spawned child`,
	);
}

function startAppium(
	port: number,
	diagnostics: ReturnType<typeof createSmokeDiagnostic>,
): ChildProcessWithoutNullStreams {
	const configured = process.env.FORGEAX_APPIUM_BIN?.trim();
	if (!configured)
		throw new Error(
			"FORGEAX_APPIUM_BIN must name a pre-provisioned, pinned Appium executable; smoke does not download a driver at runtime",
		);
	const child = spawn(
		configured,
		[
			"server",
			"--address",
			"127.0.0.1",
			"--port",
			String(port),
			"--use-drivers",
			"mac2",
		],
		{
			stdio: "pipe",
			env: process.env,
		},
	);
	child.stdout.on("data", (value) =>
		diagnostics.output("stdout", `[appium] ${String(value)}`),
	);
	child.stderr.on("data", (value) =>
		diagnostics.output("stderr", `[appium] ${String(value)}`),
	);
	child.once("error", (error) =>
		diagnostics.event("appium-spawn-error", serializeDiagnosticError(error)),
	);
	return child;
}

/** macOS product stdout is not inherited by LaunchServices; stream its system log before creating a session. */
function startProductLog(
	identity: MacosAppIdentity,
	diagnostics: ReturnType<typeof createSmokeDiagnostic>,
): ChildProcessWithoutNullStreams {
	const child = spawn(
		"log",
		[
			"stream",
			"--style",
			"syslog",
			"--predicate",
			`process == "${basename(identity.executable)}"`,
		],
		{ stdio: "pipe" },
	);
	child.stdout.on("data", (value) =>
		diagnostics.output(
			"stdout",
			`[product-pre-session:${basename(identity.executable)}] ${String(value)}`,
		),
	);
	child.stderr.on("data", (value) =>
		diagnostics.output(
			"stderr",
			`[product-pre-session:${basename(identity.executable)}] ${String(value)}`,
		),
	);
	child.once("error", (error) =>
		diagnostics.event(
			"product-log-spawn-error",
			serializeDiagnosticError(error),
		),
	);
	diagnostics.event("product-output-capture", {
		mode: "macos-unified-log",
		executable: identity.executable,
	});
	return child;
}

async function stopChild(
	child: ChildProcessWithoutNullStreams,
	deadline: number,
): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	if (deadline <= Date.now())
		throw new Error(
			`cleanup deadline elapsed before stopping child ${child.pid ?? "unknown"}`,
		);
	if (!child.kill("SIGTERM"))
		throw new Error(
			`could not request child ${child.pid ?? "unknown"} shutdown`,
		);
	await Promise.race([
		new Promise<void>((resolvePromise) =>
			child.once("exit", () => resolvePromise()),
		),
		sleep(Math.min(5_000, Math.max(1, deadline - Date.now()))),
	]);
	if (child.exitCode === null && child.signalCode === null)
		throw new Error(
			`child ${child.pid ?? "unknown"} did not exit after SIGTERM`,
		);
}

function declaredSourceRevision(options: NativeSmokeOptions): string {
	const configured = options.revision;
	if (!configured || !/^[0-9a-f]{40}$/i.test(configured))
		throw new Error(
			"native product evidence requires an explicit immutable source revision declaration; local git HEAD is not package provenance",
		);
	return configured;
}

function verifyMacosProductReceipt(
	identity: MacosAppIdentity,
	revision: string,
): unknown {
	const receiptPath = process.env.FORGEAX_NATIVE_PRODUCT_RECEIPT?.trim();
	if (!receiptPath)
		throw new Error(
			"native product evidence requires FORGEAX_NATIVE_PRODUCT_RECEIPT",
		);
	return verifyNativeProductReceipt({
		receipt: receiptPath,
		platform: "macos",
		executable: identity.executable,
		revision,
	});
}

/** Diagnostic I/O is evidence only: an archive failure must not hide the primary failure. */
function safeDiagnostic(
	diagnostics: ReturnType<typeof createSmokeDiagnostic>,
	errors: Error[],
): ReturnType<typeof createSmokeDiagnostic> {
	const invoke = <T>(operation: () => T): T | undefined => {
		try {
			return operation();
		} catch (error) {
			errors.push(error instanceof Error ? error : new Error(String(error)));
			return undefined;
		}
	};
	return {
		directory: diagnostics.directory,
		phase: (phase) => {
			invoke(() => diagnostics.phase(phase));
		},
		event: (name, detail) => {
			invoke(() => diagnostics.event(name, detail));
		},
		state: (state) => {
			invoke(() => diagnostics.state(state));
		},
		output: (stream, chunk) => {
			invoke(() => diagnostics.output(stream, chunk));
		},
	};
}

function runtimeState(
	projectRoot: string,
	appPid: number,
): RuntimeState | undefined {
	const runtime = join(projectRoot, ".forgeax", "runtime");
	if (!existsSync(runtime)) return undefined;
	const stateFile = join(runtime, `desktop-prod-${appPid}.json`);
	if (!existsSync(stateFile)) return undefined;
	return JSON.parse(readFileSync(stateFile, "utf8")) as RuntimeState;
}

function pageLoadReceiptFile(projectRoot: string, appPid: number): string {
	return join(
		projectRoot,
		".forgeax",
		"runtime",
		`desktop-prod-page-load-${appPid}.json`,
	);
}

/** Validates the native shell's Finished navigation fact; launcher readiness remains authoritative. */
export function validateDesktopPageLoadReceipt(
	value: unknown,
	appPid: number,
	projectRoot: string,
	expectedOrigin: string,
	runtimeStartedAt: string,
	navigationGeneration: string,
): void {
	const receipt = value as Record<string, unknown>;
	const origin = expectedOrigin.replace(/\/$/, "");
	if (
		receipt?.schemaVersion !== 1 ||
		receipt.appPid !== appPid ||
		receipt.windowLabel !== "main" ||
		receipt.event !== "finished"
	)
		throw new Error("native page-load receipt has an invalid identity");
	if (
		receipt.projectRoot !== projectRoot ||
		receipt.expectedOrigin !== origin ||
		receipt.pageUrl !== origin ||
		receipt.runtimeStartedAt !== runtimeStartedAt ||
		receipt.navigationGeneration !== navigationGeneration
	)
		throw new Error(
			"native page-load receipt does not bind this runtime project/origin/generation",
		);
}

async function waitForDesktopPageLoadReceipt(
	projectRoot: string,
	appPid: number,
	expectedOrigin: string,
	runtimeStartedAt: string,
	navigationGeneration: string,
	deadline: number,
): Promise<Record<string, unknown>> {
	const receiptFile = pageLoadReceiptFile(projectRoot, appPid);
	return await waitUntil(
		"native main-window page-load receipt",
		deadline,
		() => {
			if (!existsSync(receiptFile)) return undefined;
			const receipt = JSON.parse(readFileSync(receiptFile, "utf8")) as Record<
				string,
				unknown
			>;
			validateDesktopPageLoadReceipt(
				receipt,
				appPid,
				projectRoot,
				expectedOrigin,
				runtimeStartedAt,
				navigationGeneration,
			);
			return receipt;
		},
	);
}

function portsFromState(state: RuntimeState): number[] {
	return [...validateNativeDesktopRuntimeState(state).ports];
}
function partialPortsFromState(state: RuntimeState | undefined): number[] {
	if (!state?.managedPorts || typeof state.managedPorts !== "object") return [];
	return [
		...new Set(
			Object.values(state.managedPorts)
				.filter(
					(value) =>
						Number.isSafeInteger(value) &&
						Number(value) > 0 &&
						Number(value) < 65_536,
				)
				.map(Number),
		),
	];
}

/** The runtime-state file is the product cleanup contract, never an optional hint. */
export function validateDesktopProdState(state: RuntimeState): void {
	validateNativeDesktopRuntimeState(state);
}

/** Keeps only a fully validated ready snapshot as cleanup ownership evidence. */
export function retainValidatedReadyRuntimeSnapshot(
	verified: RuntimeState | undefined,
	observed: RuntimeState | undefined,
): RuntimeState | undefined {
	if (
		observed?.profile !== "desktop-prod" ||
		observed.status !== "ready" ||
		observed.readiness?.ready !== true
	)
		return verified;
	validateDesktopProdState(observed);
	return observed;
}

function stateProcessIdentities(state: RuntimeState): ProcessIdentity[] {
	const pids = [...validateNativeDesktopRuntimeState(state).pids];
	const snapshot = snapshotProcesses();
	const identities = pids
		.map((pid) => snapshot.find((value) => value.pid === pid))
		.filter((value): value is ProcessSnapshot => value !== undefined)
		.map((value) => ({ pid: value.pid, startedAt: value.startedAt }));
	if (identities.length !== pids.length)
		throw new Error(
			"runtime state named a process that was absent before quit evidence could be established",
		);
	return identities;
}

/** NSRunningApplication.terminate sends a normal native termination request to this exact bundle path and PID. */
export async function requestNativeQuit(
	identity: MacosAppIdentity,
	startedApp: ProcessIdentity,
): Promise<void> {
	const source = [
		"import AppKit",
		"let expected = CommandLine.arguments[1]",
		"let pid = pid_t(CommandLine.arguments[2])!",
		"let expectedStart = CommandLine.arguments[3]",
		`let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "${identity.bundleIdentifier}").filter { $0.executableURL?.path == expected && $0.processIdentifier == pid }`,
		'guard apps.count == 1 else { fputs("expected exactly one matching product process\\n", stderr); exit(2) }',
		"let app = apps[0]",
		// NSRunningApplication is the bound LaunchServices process object. Its
		// launchDate is not a kernel birth timestamp (restore/activation can
		// differ), so never compare it to ps lstart and reject a live instance.
		// We retain this exact object while ps proves the recorded kernel identity.
		'let ps = Process(); ps.executableURL = URL(fileURLWithPath: "/bin/ps"); ps.arguments = ["-p", String(pid), "-o", "lstart="]; let pipe = Pipe(); ps.standardOutput = pipe; try ps.run(); ps.waitUntilExit(); let actualStart = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""',
		'guard ps.terminationStatus == 0 && actualStart == expectedStart && !app.isTerminated else { fputs("product creation identity changed before Quit\\n", stderr); exit(4) }',
		'guard app.terminate() else { fputs("native terminate request was rejected\\n", stderr); exit(3) }',
	].join("\n");
	const result = spawnSync(
		"swift",
		[
			"-e",
			source,
			identity.executable,
			String(startedApp.pid),
			startedApp.startedAt,
		],
		{ encoding: "utf8", timeout: 20_000 },
	);
	if (result.status !== 0 || result.error)
		throw new Error(
			`native product Quit request failed: ${result.error?.message ?? result.stderr.trim()}`,
		);
}

/** Mac2 session creation contains the only app launch in this runner. */
export function mac2SessionRequestTimeout(deadline: number): number {
	return Math.max(1, Math.min(MAC2_SESSION_TIMEOUT_MS, deadline - Date.now()));
}

async function createMac2Session(
	port: number,
	app: MacosAppIdentity,
	projectRoot: string,
	deadline: number,
): Promise<NativeBrowser> {
	const browser = await remote({
		protocol: "http",
		hostname: "127.0.0.1",
		port,
		path: "/",
		connectionRetryCount: 0,
		connectionRetryTimeout: mac2SessionRequestTimeout(deadline),
		logLevel: "warn",
		capabilities: {
			platformName: "Mac",
			"appium:automationName": "Mac2",
			"appium:appPath": app.app,
			"appium:noReset": false,
			// Driver teardown occurs only after the outer runner has evaluated Quit.
			"appium:skipAppKill": true,
			"appium:showServerLogs": true,
			"appium:arguments": ["-ApplePersistenceIgnoreState", "YES"],
			"appium:environment": { FORGEAX_PROJECT_ROOT: projectRoot },
		} as any,
	});
	// Only POST /session receives the long startup allowance. Subsequent
	// WebDriver requests retain their short command bound plus outer deadlines.
	(
		browser.options as { connectionRetryTimeout?: number }
	).connectionRetryTimeout = MAC2_COMMAND_TIMEOUT_MS;
	return browser;
}

const DASHBOARD_CONTROL = "Dashboard — Run/Thread/Provider monitoring";
const DASHBOARD_CLOSE_CONTROL = "close dashboard";
const DASHBOARD_BUTTON_IN_SOURCE = new RegExp(
	`<XCUIElementTypeButton\\b[^>]*\\blabel=(["'])${DASHBOARD_CONTROL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`,
);
function dashboardControl(source: string): string | undefined {
	// This is the concrete product control observed in the signed release, not
	// an arbitrary AX button whose focus mutation could fake a passing result.
	// Mac2 resolves accessibility-id through XCTest `name`, which falls back to
	// label when identifier is empty. The signed app's actual AX button matches
	// this exact label; source remains an independent type/label sanity check.
	return DASHBOARD_BUTTON_IN_SOURCE.test(source)
		? DASHBOARD_CONTROL
		: undefined;
}

export type MacDashboardReadinessBrowser = {
	getPageSource(): Promise<string>;
	$(selector: string): Promise<{
		isExisting(): Promise<boolean>;
		isDisplayed(): Promise<boolean>;
		click(): Promise<void>;
	}>;
};
export type MacNativeActivationBrowser = {
	execute(script: string, args: { readonly path: string }): Promise<unknown>;
};
export type MacFrontmostPidReader = (deadline: number) => number;

function compileMacFrontmostPidReader(
	directory: string,
	deadline: number,
): MacFrontmostPidReader {
	const source = join(directory, "mac-frontmost-pid.swift");
	const executable = join(directory, "mac-frontmost-pid");
	writeFileSync(
		source,
		"import AppKit\nprint(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1)\n",
	);
	const remaining = deadline - Date.now();
	if (remaining <= 0)
		throw new Error(
			"Mac2 UI deadline elapsed before compiling frontmost helper",
		);
	const compiled = spawnSync("swiftc", [source, "-o", executable], {
		encoding: "utf8",
		timeout: Math.min(20_000, remaining),
	});
	if (compiled.status !== 0 || compiled.error)
		throw new Error(
			`could not compile native frontmost helper: ${compiled.error?.message ?? compiled.stderr.trim()}`,
		);
	return (operationDeadline) => {
		const ms = operationDeadline - Date.now();
		if (ms <= 0)
			throw new Error("Mac2 UI deadline elapsed before frontmost check");
		const result = spawnSync(executable, [], {
			encoding: "utf8",
			timeout: Math.min(2_000, ms),
		});
		const pid = Number(result.stdout.trim());
		if (result.status !== 0 || result.error || !Number.isSafeInteger(pid))
			throw new Error(
				`could not read native frontmost PID: ${result.error?.message ?? result.stderr.trim()}`,
			);
		return pid;
	};
}

export async function assertMacNativeForeground(
	browser: MacNativeActivationBrowser,
	app: string,
	deadline: number,
	expectedPid?: number,
	frontmostPid?: MacFrontmostPidReader,
): Promise<void> {
	const state = await withinNativeDeadline(
		"Mac2 product foreground state",
		deadline,
		browser.execute("macos: queryAppState", { path: app }),
	);
	if (state !== 4)
		throw new MacNativeFocusLostError(
			`Mac2 lost product foreground during interaction (state=${String(state)})`,
		);
	if (expectedPid !== undefined && frontmostPid) {
		const actualPid = frontmostPid(deadline);
		if (actualPid !== expectedPid)
			throw new MacNativeFocusLostError(
				`Mac2 frontmost application changed during interaction (expected PID=${expectedPid}, actual PID=${actualPid})`,
			);
	}
}

/** Brings the exact product bundle forward before a native AX click. */
export async function activateMacNativeApp(
	browser: MacNativeActivationBrowser,
	app: string,
	deadline: number,
): Promise<void> {
	// WebdriverIO variadically serializes its second argument as the Appium
	// execute payload. Passing an array here nests it as `args: [{path: ...}]`,
	// which Mac2 rejects; pass the extension's parameter object directly.
	await withinNativeDeadline(
		"Mac2 product activation",
		deadline,
		browser.execute("macos: activateApp", { path: app }),
	);
	await assertMacNativeForeground(browser, app, deadline);
}

/** Polls the actual AX tree; source text alone never counts as a clickable control. */
export async function waitForMacDashboardControl(
	browser: MacDashboardReadinessBrowser,
	deadline: number,
	capture: (source: string) => Promise<void> | void,
): Promise<Awaited<ReturnType<MacDashboardReadinessBrowser["$"]>>> {
	let last = "";
	while (Date.now() < deadline) {
		last = await withinNativeDeadline(
			"Mac2 AX readiness source",
			deadline,
			browser.getPageSource(),
		);
		await capture(last);
		if (dashboardControl(last)) {
			const candidate = await withinNativeDeadline(
				"Mac2 Dashboard locator",
				deadline,
				Promise.resolve(browser.$(`~${DASHBOARD_CONTROL}`)),
			);
			if (
				(await withinNativeDeadline(
					"Mac2 Dashboard existence",
					deadline,
					Promise.resolve(candidate.isExisting()),
				)) &&
				(await withinNativeDeadline(
					"Mac2 Dashboard visibility",
					deadline,
					Promise.resolve(candidate.isDisplayed()),
				))
			)
				return candidate;
		}
		await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
	}
	throw new Error(
		`Mac2 did not expose the expected visible Dashboard control before the shared deadline: ${DASHBOARD_CONTROL}; last AX source bytes=${last.length}`,
	);
}

function hasVisibleAXElement(
	source: string,
	type: string,
	attributes: readonly string[],
): boolean {
	return (
		source.match(new RegExp(`<${type}\\b[^>]+>`, "g"))?.some((element) => {
			if (!attributes.every((attribute) => element.includes(attribute)))
				return false;
			const width = Number(element.match(/\bwidth="([\d.]+)"/)?.[1] ?? 0);
			const height = Number(element.match(/\bheight="([\d.]+)"/)?.[1] ?? 0);
			return width > 0 && height > 0;
		}) ?? false
	);
}

function dashboardGroup(source: string): string | undefined {
	const open =
		/<XCUIElementTypeGroup\b[^>]*\blabel="Dashboard"[^>]*\btitle="Dashboard"[^>]*>/g;
	const start = open.exec(source);
	if (
		!start ||
		!hasVisibleAXElement(start[0], "XCUIElementTypeGroup", [
			'label="Dashboard"',
			'title="Dashboard"',
		])
	)
		return undefined;
	const groupTag = /<\/?XCUIElementTypeGroup\b[^>]*>/g;
	groupTag.lastIndex = start.index;
	let depth = 0;
	let match = groupTag.exec(source);
	while (match) {
		depth += match[0].startsWith("</") ? -1 : 1;
		if (depth === 0) return source.slice(start.index, groupTag.lastIndex);
		match = groupTag.exec(source);
	}
	return undefined;
}

function hasVisibleDashboardPanel(source: string): boolean {
	const panel = dashboardGroup(source);
	return (
		!!panel &&
		hasVisibleAXElement(panel, "XCUIElementTypeButton", [
			'label="close dashboard"',
			'title="close dashboard"',
		]) &&
		hasVisibleAXElement(panel, "XCUIElementTypeTab", [
			'title="Overview"',
			'selected="true"',
		]) &&
		hasVisibleAXElement(panel, "XCUIElementTypeStaticText", [
			'title="Overview"',
		])
	);
}

/** Waits for the actual Dashboard panel, never treating a click acknowledgement as state change. */
export async function waitForMacDashboardResult(
	browser: MacDashboardReadinessBrowser,
	before: string,
	deadline: number,
	capture: (source: string) => Promise<void> | void,
	ensureForeground?: () => Promise<void>,
): Promise<string> {
	let after = before;
	while (Date.now() < deadline) {
		if (ensureForeground) await ensureForeground();
		after = await withinNativeDeadline(
			"Mac2 Dashboard result",
			deadline,
			browser.getPageSource(),
		);
		await capture(after);
		if (after !== before && hasVisibleDashboardPanel(after)) {
			const close = await withinNativeDeadline(
				"Mac2 Dashboard close locator",
				deadline,
				Promise.resolve(browser.$(`~${DASHBOARD_CLOSE_CONTROL}`)),
			);
			if (
				(await withinNativeDeadline(
					"Mac2 Dashboard close existence",
					deadline,
					Promise.resolve(close.isExisting()),
				)) &&
				(await withinNativeDeadline(
					"Mac2 Dashboard close visibility",
					deadline,
					Promise.resolve(close.isDisplayed()),
				))
			)
				return after;
		}
		await sleep(Math.min(200, Math.max(1, deadline - Date.now())));
	}
	throw new Error(
		"Dashboard click did not expose a changed, visible Dashboard/Overview/close dashboard product state",
	);
}

async function interactWithNativeControl(
	browser: NativeBrowser,
	identity: MacosAppIdentity,
	startedApp: ProcessIdentity,
	diagnostics: ReturnType<typeof createSmokeDiagnostic>,
	deadline: number,
): Promise<{
	readonly sourceBytes: number;
	readonly control: string;
	readonly sourceAfterBytes: number;
}> {
	const uiDeadline = Math.min(deadline, Date.now() + 30_000);
	const frontmostPid = compileMacFrontmostPidReader(
		diagnostics.directory,
		uiDeadline,
	);
	const foreground = async (phase: string) => {
		try {
			await assertMacNativeForeground(
				browser,
				identity.app,
				uiDeadline,
				startedApp.pid,
				frontmostPid,
			);
		} catch (error) {
			if (error instanceof MacNativeFocusLostError)
				diagnostics.event("environment-focus-lost", {
					phase,
					error: serializeDiagnosticError(error),
				});
			throw error;
		}
	};
	let lastSource = "";
	await activateMacNativeApp(browser, identity.app, uiDeadline);
	await foreground("before-readiness");
	const element = await waitForMacDashboardControl(
		browser as any,
		uiDeadline,
		async (source) => {
			lastSource = source;
			writeFileSync(join(diagnostics.directory, "native-before.xml"), source);
			await withinNativeDeadline(
				"Mac2 AX readiness screenshot",
				uiDeadline,
				browser.saveScreenshot(
					join(diagnostics.directory, "native-before.png"),
				),
			);
		},
	);
	if (hasVisibleDashboardPanel(lastSource))
		throw new Error(
			"Dashboard panel was already open before the requested control click",
		);
	const control = DASHBOARD_CONTROL;
	await activateMacNativeApp(browser, identity.app, uiDeadline);
	await foreground("before-click");
	await withinNativeDeadline(
		"Mac2 Dashboard click",
		uiDeadline,
		Promise.resolve(element.click()),
	);
	await foreground("after-click");
	const after = await waitForMacDashboardResult(
		browser as any,
		lastSource,
		uiDeadline,
		async (source) => {
			writeFileSync(join(diagnostics.directory, "native-after.xml"), source);
			await withinNativeDeadline(
				"Mac2 Dashboard screenshot",
				uiDeadline,
				browser.saveScreenshot(join(diagnostics.directory, "native-after.png")),
			);
		},
		() => foreground("result-poll"),
	);
	return {
		sourceBytes: lastSource.length,
		control,
		sourceAfterBytes: after.length,
	};
}

export async function runMacosNativeSmoke(
	options: NativeSmokeOptions,
): Promise<string> {
	const requestedDiagnostics =
		process.env.IDE_NATIVE_SMOKE_DIAGNOSTIC_DIR?.trim();
	const diagnosticErrors: Error[] = [];
	const diagnostics = safeDiagnostic(
		createSmokeDiagnostic(
			requestedDiagnostics
				? join(
						resolve(requestedDiagnostics),
						`run-${process.pid}-${Date.now()}`,
					)
				: undefined,
		),
		diagnosticErrors,
	);
	// Establish the receipt directory before rejecting an invalid product, so
	// package-verifier failures leave their primary error next to diagnostics.
	let identity: MacosAppIdentity;
	try {
		identity = inspectMacosApp(options.app);
	} catch (error) {
		diagnostics.phase("preflight-failed");
		diagnostics.event(
			"product-artifact-rejected",
			serializeDiagnosticError(error),
		);
		throw new AggregateError(
			[error, ...diagnosticErrors],
			`native desktop product preflight failed; diagnostics: ${diagnostics.directory}`,
		);
	}
	const deadline = Date.now() + NATIVE_SMOKE_BUDGET_MS;
	const projectRoot = mkdtempSync(
		join(tmpdir(), "forgeax-native-desktop-project-"),
	);
	let appium: ChildProcessWithoutNullStreams | undefined;
	let productLog: ChildProcessWithoutNullStreams | undefined;
	let browser: NativeBrowser | undefined;
	let startedApp: ProcessIdentity | undefined;
	let runtimeIdentities: ProcessIdentity[] = [];
	let observer: ProcessObserver | undefined;
	let launchWatcher: AppLaunchWatcher | undefined;
	let state: RuntimeState | undefined;
	let observedState: RuntimeState | undefined;
	let baselineApps: ProcessIdentity[] = [];
	let primary: unknown;
	let succeeded = false;
	try {
		diagnostics.phase("preflight");
		diagnostics.event("product-artifact", identity);
		const revision = declaredSourceRevision(options);
		const receipt = verifyMacosProductReceipt(identity, revision) as {
			source?: unknown;
		};
		diagnostics.event("product-artifact-binding", {
			declaredSourceRevision: revision,
			receipt: process.env.FORGEAX_NATIVE_PRODUCT_RECEIPT,
			source: receipt.source,
			verified:
				"shared receipt validator bound executable and runtime manifest; source kind is recorded verbatim",
		});
		diagnostics.event("isolated-project-root", projectRoot);
		baselineApps = appProcesses(identity);
		if (baselineApps.length > 0)
			throw new Error(
				`refusing to attach to an already-running product executable: ${identity.executable}`,
			);
		const occupied = await verifyPortsReleased([options.appiumPort]);
		if (occupied.length)
			throw new Error(
				`refusing to attach to an occupied Appium port: ${occupied.join("; ")}`,
			);
		productLog = startProductLog(identity, diagnostics);
		launchWatcher = watchNewProductProcess(
			identity,
			baselineApps,
			(started) => {
				startedApp = started;
				if (!observer)
					observer = createProcessObserver(
						{ pid: started.pid },
						{ explicitRootIdentity: started, pollIntervalMs: 50 },
					);
				diagnostics.event("product-process-pre-session", started);
			},
			(error) => diagnosticErrors.push(error),
		);
		const startedAppium = startAppium(options.appiumPort, diagnostics);
		appium = startedAppium;
		await waitUntil(
			"Appium Mac2 server",
			Math.min(deadline, Date.now() + 20_000),
			async () => {
				if (
					startedAppium.exitCode !== null ||
					startedAppium.signalCode !== null
				)
					throw new FatalNativeSmokeError(
						`new Appium child exited before readiness: ${startedAppium.exitCode ?? startedAppium.signalCode}`,
					);
				const status = await appiumStatus(options.appiumPort);
				if (status.ready)
					assertPortOwnedByChild(options.appiumPort, startedAppium, "Appium");
				return status.ready ? status : undefined;
			},
		);
		diagnostics.phase("create-native-session");
		browser = await withinNativeDeadline(
			"Mac2 session creation",
			deadline,
			createMac2Session(options.appiumPort, identity, projectRoot, deadline),
		);
		diagnostics.event("mac2-session", {
			id: browser.sessionId,
			capabilities: browser.capabilities,
		});
		startedApp = await waitUntil(
			"release product process",
			Math.min(deadline, Date.now() + 15_000),
			() => {
				const watched = launchWatcher?.take();
				if (watched) return watched;
				const matches = appProcesses(identity);
				if (matches.length > 1)
					throw new FatalNativeSmokeError(
						"multiple matching product executable processes appeared; refusing ambiguous ownership",
					);
				return matches[0];
			},
		);
		diagnostics.event("product-process", startedApp);
		if (!observer)
			observer = createProcessObserver(
				{ pid: startedApp.pid },
				{ explicitRootIdentity: startedApp, pollIntervalMs: 50 },
			);
		diagnostics.phase("wait-bundled-runtime");
		state = await waitUntil(
			"bundled runtime ready state",
			Math.min(deadline, Date.now() + APP_START_TIMEOUT_MS),
			() => {
				const current = runtimeState(projectRoot, startedApp!.pid);
				if (current) {
					observedState = current;
					diagnostics.state(current);
				}
				if (current?.status === "failed")
					throw new FatalNativeSmokeError(
						`bundled runtime reported failure: ${String(current.error ?? "unknown")}`,
					);
				const ready = retainValidatedReadyRuntimeSnapshot(undefined, current);
				if (ready) return ready;
				return undefined;
			},
		);
		runtimeIdentities = stateProcessIdentities(state);
		const observed = observer.observeStateRoots(runtimeIdentities);
		if (observed.errors.length)
			throw new Error(
				`runtime identities were not continuously observed: ${observed.errors.join("; ")}`,
			);
		diagnostics.event("runtime-process-identities", {
			identities: runtimeIdentities,
			observed: observed.owned,
			groups: observed.groups,
			limitation:
				"LaunchServices shared PGIDs are never claimed; only the exact app creation identity, ancestry, and guardian-created private groups are observed.",
		});
		if (typeof state.publicOrigin !== "string")
			throw new Error(
				"validated runtime state has no publicOrigin for native page-load receipt",
			);
		if (
			typeof state.startedAt !== "string" ||
			typeof state.updatedAt !== "string"
		)
			throw new Error(
				"validated runtime state lacks launch/navigation generation for native page-load receipt",
			);
		const pageLoad = await waitForDesktopPageLoadReceipt(
			projectRoot,
			startedApp.pid,
			state.publicOrigin,
			state.startedAt,
			state.updatedAt,
			Math.min(deadline, Date.now() + 30_000),
		);
		diagnostics.event("native-main-window-page-load", pageLoad);
		const interaction = await interactWithNativeControl(
			browser,
			identity,
			startedApp,
			diagnostics,
			deadline,
		);
		diagnostics.event("native-control-interaction", interaction);
		diagnostics.phase("native-product-quit");
		await requestNativeQuit(identity, startedApp);
		await waitUntil(
			"product process exit after native Quit",
			Math.min(deadline, Date.now() + APP_QUIT_TIMEOUT_MS),
			() => (!identityIsLive(startedApp!) ? true : undefined),
		);
		const postQuitEvidence = await observer.verify(
			Math.min(deadline, Date.now() + APP_QUIT_TIMEOUT_MS),
		);
		diagnostics.event("post-quit-process-evidence", postQuitEvidence);
		if (postQuitEvidence.errors.length || postQuitEvidence.liveMembers.length)
			throw new Error(
				`product process observer retained identities after native Quit: ${[...postQuitEvidence.errors, ...postQuitEvidence.liveMembers.map((value) => `${value.pid}:${value.startedAt}`)].join("; ")}`,
			);
		const ports = portsFromState(state);
		const portErrors = await waitForPortsReleasedUntil(
			ports,
			Math.min(deadline, Date.now() + APP_QUIT_TIMEOUT_MS),
		);
		if (portErrors.length > 0)
			throw new Error(
				`bundled runtime ports were retained after native Quit: ${portErrors.join("; ")}`,
			);
		diagnostics.event("post-quit-cleanup", {
			app: startedApp,
			runtimeIdentities,
			ports,
			portErrors: await verifyPortsReleased(ports),
		});
		diagnostics.phase("passed");
		diagnostics.event("verdict-before-driver-teardown", {
			outcome: "passed",
			app: startedApp,
			ports,
		});
		console.info(`[native-desktop-smoke diagnostics] ${diagnostics.directory}`);
		succeeded = true;
	} catch (error) {
		primary = error;
		diagnostics.phase("failed");
		diagnostics.event("native-smoke-failure", serializeDiagnosticError(error));
		diagnostics.event("verdict-before-driver-teardown", { outcome: "failed" });
		console.error(
			`[native-desktop-smoke diagnostics] ${diagnostics.directory}`,
		);
	} finally {
		const cleanupDeadline = Date.now() + NATIVE_CLEANUP_BUDGET_MS;
		// The result is decided before fixture teardown.  This fallback is only to
		// avoid leaking this run after a failed startup, never evidence of success.
		let stillLive = false;
		// Mac2 can launch the app and then fail session creation.  Claim only the
		// exact executable + creation identity that appeared after this baseline.
		if (!startedApp) {
			try {
				const watched = launchWatcher?.take();
				if (watched) startedApp = watched;
				else {
					const before = new Set(
						baselineApps.map((value) => `${value.pid}:${value.startedAt}`),
					);
					const candidates = appProcesses(identity).filter(
						(value) => !before.has(`${value.pid}:${value.startedAt}`),
					);
					if (candidates.length === 1) startedApp = candidates[0];
					else if (candidates.length > 1)
						diagnosticErrors.push(
							new Error(
								"multiple newly launched product processes made fallback cleanup ambiguous",
							),
						);
				}
			} catch (error) {
				diagnosticErrors.push(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		}
		if (startedApp && !observer) {
			try {
				observer = createProcessObserver(
					{ pid: startedApp.pid },
					{ explicitRootIdentity: startedApp, pollIntervalMs: 50 },
				);
				const recoveredState = runtimeState(projectRoot, startedApp.pid);
				const ready = retainValidatedReadyRuntimeSnapshot(
					undefined,
					recoveredState,
				);
				if (ready) {
					state = ready;
					runtimeIdentities = stateProcessIdentities(ready);
					const evidence = observer.observeStateRoots(runtimeIdentities);
					if (evidence.errors.length)
						diagnosticErrors.push(
							new Error(
								`failed-session runtime identities were not observed: ${evidence.errors.join("; ")}`,
							),
						);
				}
			} catch (error) {
				diagnosticErrors.push(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		}
		if (startedApp) {
			try {
				const recovered = runtimeState(projectRoot, startedApp.pid);
				if (recovered) {
					observedState = recovered;
					diagnostics.state(recovered);
					state = retainValidatedReadyRuntimeSnapshot(state, recovered);
				}
			} catch (error) {
				diagnosticErrors.push(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		}
		try {
			stillLive = startedApp !== undefined && identityIsLive(startedApp);
		} catch (error) {
			diagnosticErrors.push(
				error instanceof Error ? error : new Error(String(error)),
			);
			diagnostics.event(
				"post-failure-process-inspection-error",
				serializeDiagnosticError(error),
			);
		}
		if (stillLive && startedApp) {
			diagnostics.event("post-failure-product-still-live", startedApp);
			try {
				await requestNativeQuit(identity, startedApp);
				await waitUntil(
					"fallback product exit",
					Math.min(cleanupDeadline, Date.now() + APP_QUIT_TIMEOUT_MS),
					() => (!identityIsLive(startedApp!) ? true : undefined),
				);
				if (state) {
					const retained = await waitForPortsReleasedUntil(
						portsFromState(state),
						Math.min(cleanupDeadline, Date.now() + APP_QUIT_TIMEOUT_MS),
					);
					if (retained.length)
						diagnosticErrors.push(
							new Error(
								`fallback cleanup retained ports: ${retained.join("; ")}`,
							),
						);
				}
			} catch (error) {
				diagnosticErrors.push(
					error instanceof Error ? error : new Error(String(error)),
				);
				diagnostics.event(
					"fallback-quit-failure",
					serializeDiagnosticError(error),
				);
			}
		}
		if (observer) {
			try {
				const fallbackEvidence = await observer.verify(
					Math.min(cleanupDeadline, Date.now() + APP_QUIT_TIMEOUT_MS),
				);
				diagnostics.event(
					"fallback-post-quit-process-evidence",
					fallbackEvidence,
				);
				if (
					fallbackEvidence.errors.length ||
					fallbackEvidence.liveMembers.length
				)
					diagnosticErrors.push(
						new Error(
							`fallback observer retained identities: ${[...fallbackEvidence.errors, ...fallbackEvidence.liveMembers.map((value) => value.pid)].join("; ")}`,
						),
					);
			} catch (error) {
				diagnosticErrors.push(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		}
		// A session can fail after the app exits but before state cleanup. Always
		// inspect known ownership and ports; cleanup evidence is never optional.
		if (state || observedState) {
			try {
				const ports = state
					? portsFromState(state)
					: partialPortsFromState(observedState);
				const retained = await waitForPortsReleasedUntil(
					ports,
					Math.min(cleanupDeadline, Date.now() + APP_QUIT_TIMEOUT_MS),
				);
				if (retained.length)
					diagnosticErrors.push(
						new Error(
							`post-failure cleanup retained ports: ${retained.join("; ")}`,
						),
					);
			} catch (error) {
				diagnosticErrors.push(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		}
		if (browser) {
			try {
				await withinNativeDeadline(
					"Mac2 driver teardown",
					cleanupDeadline,
					browser.deleteSession(),
				);
			} catch (error) {
				diagnosticErrors.push(
					error instanceof Error ? error : new Error(String(error)),
				);
				diagnostics.event(
					"driver-teardown-failure",
					serializeDiagnosticError(error),
				);
			}
		}
		if (launchWatcher) launchWatcher.stop();
		if (observer) observer.stop();
		if (appium)
			try {
				await stopChild(appium, cleanupDeadline);
			} catch (error) {
				diagnosticErrors.push(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		if (productLog)
			try {
				await stopChild(productLog, cleanupDeadline);
			} catch (error) {
				diagnosticErrors.push(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		if (!options.keepArtifacts)
			try {
				writeFileSync(
					join(diagnostics.directory, "retention.txt"),
					"Retained for failed-run upload policy; no project or environment dump is stored.\n",
				);
			} catch (error) {
				diagnosticErrors.push(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
	}
	if (!succeeded || primary || diagnosticErrors.length)
		throw new AggregateError(
			[...(primary ? [primary] : []), ...diagnosticErrors],
			"native desktop smoke failed or cleanup/diagnostics were incomplete",
		);
	return diagnostics.directory;
}

if (import.meta.main) {
	const options = parseNativeSmokeOptions();
	if (process.platform === "darwin") {
		if (options.fault) await runMacosNativeFaultSmoke(options);
		else await runMacosNativeSmoke(options);
	} else if (process.platform === "win32") {
		const { runWindowsNativeSmoke } = await import("./native-desktop-windows");
		const tauriDriver = process.env.FORGEAX_TAURI_DRIVER?.trim();
		const edgeDriver = process.env.FORGEAX_EDGE_WEBDRIVER?.trim();
		if (!tauriDriver || !edgeDriver)
			throw new Error(
				"Windows native smoke requires FORGEAX_TAURI_DRIVER and FORGEAX_EDGE_WEBDRIVER",
			);
		await runWindowsNativeSmoke({
			app: options.app,
			tauriDriver,
			edgeDriver,
			port: options.appiumPort,
			revision: options.revision,
		});
	} else
		throw new Error(
			`native desktop smoke has no adapter for ${process.platform}`,
		);
}
