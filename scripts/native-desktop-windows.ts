import {
	type ChildProcessWithoutNullStreams,
	spawn,
	spawnSync,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type Browser, remote } from "webdriverio";
import {
	type NativeDesktopPreviewFixture,
	prepareNativeDesktopPreviewFixture,
	runWindowsNativePreviewScenario,
} from "./native-desktop-preview";
import {
	type NativeDesktopRuntimeState,
	validateNativeDesktopRuntimeState,
} from "./native-desktop-runtime-contract";
import { verifyNativeProductReceipt } from "./native-product-receipt";
import {
	initializeNativeWindowsJobEvidence,
	type NativeWindowsJobEvidence,
} from "./native-windows-job-evidence";
import {
	verifyPortsReleased,
	waitForPortsReleasedUntil,
} from "./smoke-assembled-desktop-runtime";
import {
	createProcessObserver,
	type ProcessIdentity,
	type ProcessObserver,
	type ProcessSnapshot,
	parseWindowsProcessSnapshot,
} from "./smoke-process-evidence";

const NATIVE_SMOKE_BUDGET_MS = 330_000;
const NATIVE_CLEANUP_BUDGET_MS = 55_000;
const DASHBOARD_CONTROL = "Dashboard — Run/Thread/Provider monitoring";

export type WindowsNativeSmokeConfig = {
	readonly app: string;
	readonly tauriDriver: string;
	readonly edgeDriver: string;
	readonly port: number;
	readonly nativePort?: number;
	readonly projectRoot?: string;
	readonly revision?: string;
};

export type WindowsProductIdentity = {
	readonly executable: string;
	readonly sha256: string;
	readonly size: number;
};

/**
 * This is intentionally configuration-only on non-Windows hosts. A real
 * WebView2 session must be created on a Windows GUI host; unit tests cannot
 * become Windows product evidence.
 */
export function inspectWindowsProduct(input: string): WindowsProductIdentity {
	const executable = resolve(input);
	if (
		!executable.toLowerCase().endsWith(".exe") ||
		!existsSync(executable) ||
		!statSync(executable).isFile()
	) {
		throw new Error(
			`--app must name an existing Windows product .exe: ${executable}`,
		);
	}
	const bytes = readFileSync(executable);
	return {
		executable,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		size: bytes.byteLength,
	};
}

export function validateWindowsNativeSmokeConfig(
	config: WindowsNativeSmokeConfig,
): WindowsProductIdentity {
	if (
		!Number.isSafeInteger(config.port) ||
		config.port < 1 ||
		config.port > 65_535
	)
		throw new Error("tauri-driver port must be an integer from 1 to 65535");
	if (
		config.nativePort !== undefined &&
		(!Number.isSafeInteger(config.nativePort) ||
			config.nativePort < 1 ||
			config.nativePort > 65_535 ||
			config.nativePort === config.port)
	)
		throw new Error(
			"tauri-driver native port must be a distinct integer from 1 to 65535",
		);
	for (const [label, path] of [
		["tauri-driver", config.tauriDriver],
		["Edge WebDriver", config.edgeDriver],
	] as const) {
		if (!path || !existsSync(path) || !statSync(path).isFile())
			throw new Error(`${label} executable is missing: ${path}`);
	}
	return inspectWindowsProduct(config.app);
}

/** Tauri's external driver owns a real WebView2 session; it is never a Chromium fallback. */
export function windowsTauriDriverArgs(
	config: WindowsNativeSmokeConfig,
): readonly string[] {
	if (config.nativePort === undefined)
		throw new Error("tauri-driver native port must be allocated before spawn");
	return [
		"--native-driver",
		config.edgeDriver,
		"--port",
		String(config.port),
		"--native-port",
		String(config.nativePort),
	];
}

/** Reserve an ephemeral loopback port only long enough to choose this run's distinct native driver endpoint. */
async function allocateNativePort(excluding: number): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port: 0 }, () => resolvePromise());
	});
	try {
		const address = server.address();
		if (!address || typeof address === "string" || address.port === excluding)
			throw new Error("could not allocate a distinct native driver port");
		return address.port;
	} finally {
		await new Promise<void>((resolvePromise) =>
			server.close(() => resolvePromise()),
		);
	}
}

export function windowsWebView2Capabilities(
	identity: WindowsProductIdentity,
): Record<string, unknown> {
	return {
		platformName: "Windows",
		browserName: "webview2",
		"tauri:options": { application: identity.executable },
	};
}

/** Driver teardown may clean a process, but it is never accepted as a product Quit verdict. */
export function assessWindowsQuitEvidence(input: {
	readonly nativeQuitObserved: boolean;
	readonly processIdentitiesReleased: boolean;
	readonly portsReleased: boolean;
	readonly driverTeardownOnly: boolean;
}): string[] {
	const errors: string[] = [];
	if (input.driverTeardownOnly)
		errors.push("WebDriver teardown is not a Windows product Quit event");
	if (!input.nativeQuitObserved)
		errors.push("Windows product Quit was not observed");
	if (!input.processIdentitiesReleased)
		errors.push(
			"Windows product/runtime process identities remained after Quit",
		);
	if (!input.portsReleased)
		errors.push("Windows runtime ports remained bound after Quit");
	return errors;
}

type WindowsIdentity = { readonly pid: number; readonly startedAt: string };
type NativeBrowser = Browser;

function windowsProcesses(executable: string): WindowsIdentity[] {
	const escaped = executable.replace(/'/g, "''");
	const command = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${escaped}' } | Select ProcessId,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress`;
	const result = spawnSync(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-Command", command],
		{ encoding: "utf8", timeout: 5_000, windowsHide: true },
	);
	if (result.status !== 0 || result.error)
		throw new Error(
			`could not inspect Windows product identity: ${result.error?.message ?? result.stderr}`,
		);
	const raw = JSON.parse(result.stdout || "[]") as unknown;
	const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
	return rows.flatMap((value) =>
		value &&
		typeof value === "object" &&
		Number.isSafeInteger((value as any).ProcessId) &&
		typeof (value as any).CreationDate === "string"
			? [
					{
						pid: Number((value as any).ProcessId),
						startedAt: String((value as any).CreationDate),
					},
				]
			: [],
	);
}

function windowsSnapshot(): ProcessSnapshot[] {
	const result = spawnSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress",
		],
		{ encoding: "utf8", timeout: 5_000, windowsHide: true },
	);
	if (result.status !== 0 || result.error)
		throw new Error(
			`could not capture Windows process evidence: ${result.error?.message ?? result.stderr}`,
		);
	return parseWindowsProcessSnapshot(result.stdout);
}

function assertWindowsListenerOwnedByDriver(
	port: number,
	driver: WindowsIdentity,
): void {
	const result = spawnSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -ExpandProperty OwningProcess | ConvertTo-Json -Compress`,
		],
		{ encoding: "utf8", timeout: 5_000, windowsHide: true },
	);
	if (result.status !== 0 || result.error)
		throw new Error(
			`could not inspect tauri-driver listener ownership: ${result.error?.message ?? result.stderr}`,
		);
	const raw = JSON.parse(result.stdout || "[]") as unknown;
	const pids = (Array.isArray(raw) ? raw : raw === null ? [] : [raw])
		.filter(Number.isSafeInteger)
		.map(Number);
	if (pids.length !== 1)
		throw new Error(
			`tauri-driver listener ownership is ambiguous on port ${port}`,
		);
	const byPid = new Map(windowsSnapshot().map((value) => [value.pid, value]));
	let current = byPid.get(pids[0]);
	const seen = new Set<number>();
	while (current && !seen.has(current.pid)) {
		if (current.pid === driver.pid && current.startedAt === driver.startedAt)
			return;
		seen.add(current.pid);
		current = byPid.get(current.parentPid);
	}
	throw new Error(
		`tauri-driver listener on port ${port} is not owned by this run's spawned driver`,
	);
}

function live(identity: WindowsIdentity): boolean {
	return windowsProcessesForPid(identity.pid).some(
		(value) => value.startedAt === identity.startedAt,
	);
}
function windowsProcessesForPid(pid: number): WindowsIdentity[] {
	const result = spawnSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select ProcessId,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress`,
		],
		{ encoding: "utf8", timeout: 5_000, windowsHide: true },
	);
	if (result.status !== 0 || result.error)
		throw new Error(
			`could not inspect Windows PID identity: ${result.error?.message ?? result.stderr}`,
		);
	const raw = JSON.parse(result.stdout || "[]") as unknown;
	const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
	return rows.flatMap((value) =>
		value &&
		typeof value === "object" &&
		Number.isSafeInteger((value as any).ProcessId) &&
		typeof (value as any).CreationDate === "string"
			? [
					{
						pid: Number((value as any).ProcessId),
						startedAt: String((value as any).CreationDate),
					},
				]
			: [],
	);
}

type WindowsLaunchWatcher = {
	readonly take: () => WindowsIdentity | undefined;
	readonly stop: () => void;
};
/** Begin watching before tauri-driver can create the session/app. */
function watchNewWindowsProduct(
	executable: string,
	baseline: readonly WindowsIdentity[],
	onFound: (identity: WindowsIdentity) => void,
	onError: (error: Error) => void,
): WindowsLaunchWatcher {
	const before = new Set(
		baseline.map((value) => `${value.pid}:${value.startedAt}`),
	);
	let found: WindowsIdentity | undefined;
	let stopped = false;
	const inspect = (): void => {
		if (stopped || found) return;
		try {
			const candidates = windowsProcesses(executable).filter(
				(value) => !before.has(`${value.pid}:${value.startedAt}`),
			);
			if (candidates.length > 1)
				throw new Error(
					"multiple newly launched Windows product processes appeared; refusing ambiguous ownership",
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

async function waitFor<T>(
	name: string,
	deadline: number,
	operation: () => Promise<T | undefined> | T | undefined,
): Promise<T> {
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			const value = await operation();
			if (value !== undefined) return value;
		} catch (error) {
			last = error;
		}
		await sleep(150);
	}
	throw new Error(
		`${name} exceeded its deadline${last instanceof Error ? `: ${last.message}` : ""}`,
	);
}

function closeMainWindow(identity: WindowsIdentity): void {
	// Hold one Process handle and compare its UTC StartTime in the same format
	// emitted by every Windows snapshot; a reused PID is rejected before WM_CLOSE.
	const started = identity.startedAt.replace(/'/g, "''");
	const script = `$p=Get-Process -Id ${identity.pid} -ErrorAction Stop; try { $h=$p.Handle; if ($p.HasExited -or $p.StartTime.ToUniversalTime().ToString('o') -ne '${started}') { exit 3 }; if (!$p.CloseMainWindow()) { exit 2 } } finally { $p.Dispose() }`;
	const result = spawnSync(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-Command", script],
		{ encoding: "utf8", timeout: 5_000, windowsHide: true },
	);
	if (result.status !== 0 || result.error)
		throw new Error(
			`Windows native product Quit request failed: ${result.error?.message ?? result.stderr}`,
		);
}

type RuntimeState = NativeDesktopRuntimeState;
function runtimeState(
	projectRoot: string,
	appPid: number,
): RuntimeState | undefined {
	const state = join(
		projectRoot,
		".forgeax",
		"runtime",
		`desktop-prod-${appPid}.json`,
	);
	return existsSync(state)
		? (JSON.parse(readFileSync(state, "utf8")) as RuntimeState)
		: undefined;
}
function requireRuntimeContract(state: RuntimeState): {
	readonly ports: number[];
	readonly pids: number[];
} {
	const contract = validateNativeDesktopRuntimeState(state);
	return { ports: [...contract.ports], pids: [...contract.pids] };
}
function partialRuntimePorts(state: RuntimeState | undefined): number[] {
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

function requireArtifactProvenance(
	config: WindowsNativeSmokeConfig,
	product: WindowsProductIdentity,
): { readonly revision: string; readonly source: unknown } {
	const revision =
		config.revision ?? process.env.FORGEAX_CI_IDE_REVISION?.trim();
	if (!revision || !/^[0-9a-f]{40}$/i.test(revision))
		throw new Error(
			"Windows product evidence requires an explicit source baseline declaration; local git HEAD is not package provenance",
		);
	const receiptPath = process.env.FORGEAX_NATIVE_PRODUCT_RECEIPT?.trim();
	if (!receiptPath)
		throw new Error(
			"Windows product evidence requires FORGEAX_NATIVE_PRODUCT_RECEIPT",
		);
	const receipt = verifyNativeProductReceipt({
		receipt: receiptPath,
		platform: "windows",
		executable: product.executable,
		revision,
	});
	return { revision, source: receipt.source };
}

async function withinDeadline<T>(
	name: string,
	deadline: number,
	operation: Promise<T>,
): Promise<T> {
	const remaining = deadline - Date.now();
	if (remaining <= 0)
		throw new Error(`native desktop overall deadline elapsed before ${name}`);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<T>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(`${name} exceeded the native desktop overall deadline`),
						),
					remaining,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export function validateWindowsNativeInteraction(
	before: string,
	after: string,
): void {
	if (!before.includes(DASHBOARD_CONTROL))
		throw new Error(
			`WebView2 did not expose expected Dashboard control: ${DASHBOARD_CONTROL}`,
		);
	if (
		!/Dashboard/.test(after) ||
		!/Overview/.test(after) ||
		!/close dashboard/i.test(after)
	)
		throw new Error(
			"Dashboard click did not expose the expected Dashboard/Overview/close dashboard product state",
		);
}

/** Executable Windows product adapter. It must be called on a Windows GUI host. */
export async function runWindowsNativeSmoke(
	config: WindowsNativeSmokeConfig,
): Promise<string> {
	if (process.platform !== "win32")
		throw new Error("Windows native smoke requires a Windows GUI host");
	const deadline = Date.now() + NATIVE_SMOKE_BUDGET_MS;
	const requestedDiagnostics =
		process.env.IDE_NATIVE_SMOKE_DIAGNOSTIC_DIR?.trim();
	if (requestedDiagnostics)
		mkdirSync(resolve(requestedDiagnostics), { recursive: true });
	const directory = requestedDiagnostics
		? mkdtempSync(join(resolve(requestedDiagnostics), `run-${process.pid}-`))
		: mkdtempSync(join(tmpdir(), "forgeax-windows-native-smoke-"));
	const projectRoot =
		config.projectRoot ??
		mkdtempSync(join(tmpdir(), "forgeax-windows-native-project-"));
	const event = (name: string, detail?: unknown) =>
		appendFileSync(
			join(directory, "events.ndjson"),
			`${JSON.stringify({ at: new Date().toISOString(), name, detail })}\n`,
		);
	let product: WindowsProductIdentity | undefined;
	let revision: string | undefined;
	let driver: ChildProcessWithoutNullStreams | undefined;
	let driverIdentity: WindowsIdentity | undefined;
	let browser: NativeBrowser | undefined;
	let app: WindowsIdentity | undefined;
	let observer: ProcessObserver | undefined;
	let launchWatcher: WindowsLaunchWatcher | undefined;
	let jobEvidence: NativeWindowsJobEvidence | undefined;
	let initialJobBaseline: readonly ProcessIdentity[] | undefined;
	let driverJobBaseline: readonly ProcessIdentity[] | undefined;
	let runtime:
		| { readonly ports: number[]; readonly pids: number[] }
		| undefined;
	let previewFixture: NativeDesktopPreviewFixture | undefined;
	let observedState: RuntimeState | undefined;
	const cleanupErrors: Error[] = [];
	let primary: unknown;
	let succeeded = false;
	const safeEvent = (name: string, detail?: unknown): void => {
		try {
			event(name, detail);
		} catch (error) {
			cleanupErrors.push(
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	};
	const safeLog = (file: string, value: unknown): void => {
		try {
			appendFileSync(join(directory, file), String(value));
		} catch (error) {
			cleanupErrors.push(
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	};
	try {
		// Diagnostics exist before any artifact/config rejection.
		const allocatedNativePort =
			config.nativePort ?? (await allocateNativePort(config.port));
		const runtimeConfig = { ...config, nativePort: allocatedNativePort };
		product = validateWindowsNativeSmokeConfig(runtimeConfig);
		const provenance = requireArtifactProvenance(config, product);
		revision = provenance.revision;
		writeFileSync(
			join(directory, "artifact.json"),
			`${JSON.stringify(product, null, 2)}\n`,
		);
		jobEvidence = await initializeNativeWindowsJobEvidence();
		initialJobBaseline = jobEvidence?.snapshot();
		safeEvent("product-artifact", {
			...product,
			revision,
			source: provenance.source,
		});
		previewFixture = prepareNativeDesktopPreviewFixture(projectRoot);
		const baselineApps = windowsProcesses(product.executable);
		if (baselineApps.length)
			throw new Error(
				`refusing an already-running product instance: ${product.executable}`,
			);
		launchWatcher = watchNewWindowsProduct(
			product.executable,
			baselineApps,
			(started) => {
				app = started;
				if (!observer)
					observer = createProcessObserver(
						{ pid: started.pid },
						{
							explicitRootIdentity: started,
							snapshotter: windowsSnapshot,
							pollIntervalMs: 50,
						},
					);
				safeEvent("product-process-pre-session", started);
			},
			(error) => cleanupErrors.push(error),
		);
		const driverPort = await verifyPortsReleased([
			runtimeConfig.port,
			runtimeConfig.nativePort,
		]);
		if (driverPort.length)
			throw new Error(
				`refusing to attach to occupied tauri-driver port: ${driverPort.join("; ")}`,
			);
		driver = spawn(
			runtimeConfig.tauriDriver,
			windowsTauriDriverArgs(runtimeConfig),
			{
				stdio: "pipe",
				env: {
					...process.env,
					FORGEAX_PROJECT_ROOT: projectRoot,
					WEBVIEW2_USER_DATA_FOLDER: join(
						projectRoot,
						".forgeax",
						"native-webview2-profile",
					),
				},
			},
		);
		if (!driver.pid) throw new Error("spawned tauri-driver has no PID");
		const capturedDriverIdentity = await waitFor(
			"tauri-driver creation identity",
			Math.min(deadline, Date.now() + 5_000),
			() =>
				windowsProcessesForPid(driver!.pid!).find(
					(value) => value.pid === driver!.pid,
				),
		);
		driverIdentity = capturedDriverIdentity;
		const jobAfterDriverSpawn = jobEvidence?.snapshot();
		if (
			!jobAfterDriverSpawn?.some(
				(value) =>
					value.pid === capturedDriverIdentity.pid &&
					value.startedAt === capturedDriverIdentity.startedAt,
			) ||
			initialJobBaseline?.some(
				(value) =>
					value.pid === capturedDriverIdentity.pid &&
					value.startedAt === capturedDriverIdentity.startedAt,
			)
		)
			throw new Error(
				"spawned tauri-driver identity is not a new member of this smoke Job",
			);
		driver.stdout.on("data", (value) => safeLog("driver.stdout.log", value));
		driver.stderr.on("data", (value) => safeLog("driver.stderr.log", value));
		await waitFor(
			"tauri-driver status",
			Math.min(deadline, Date.now() + 20_000),
			async () => {
				if (
					driver!.exitCode !== null ||
					!driverIdentity ||
					!live(driverIdentity)
				)
					throw new Error(
						"new tauri-driver identity exited or changed before readiness",
					);
				const response = await fetch(
					`http://127.0.0.1:${runtimeConfig.port}/status`,
					{
						signal: AbortSignal.timeout(
							Math.min(5_000, Math.max(1, deadline - Date.now())),
						),
					},
				);
				if (response.ok) {
					assertWindowsListenerOwnedByDriver(
						runtimeConfig.port,
						driverIdentity,
					);
					assertWindowsListenerOwnedByDriver(
						runtimeConfig.nativePort,
						driverIdentity,
					);
				}
				return response.ok ? true : undefined;
			},
		);
		driverJobBaseline = jobEvidence?.snapshot();
		browser = await withinDeadline(
			"WebView2 session creation",
			deadline,
			remote({
				protocol: "http",
				hostname: "127.0.0.1",
				port: runtimeConfig.port,
				path: "/",
				connectionRetryCount: 0,
				connectionRetryTimeout: Math.min(
					30_000,
					Math.max(1, deadline - Date.now()),
				),
				capabilities: {
					...windowsWebView2Capabilities(product),
					"tauri:options": { application: product.executable },
				} as any,
			}),
		);
		event("webdriver-session", {
			id: browser.sessionId,
			capabilities: browser.capabilities,
		});
		app = await waitFor(
			"Windows product process",
			Math.min(deadline, Date.now() + 15_000),
			() => launchWatcher?.take(),
		);
		if (!observer)
			observer = createProcessObserver(
				{ pid: app.pid },
				{
					explicitRootIdentity: app,
					snapshotter: windowsSnapshot,
					pollIntervalMs: 50,
				},
			);
		const readyRuntimeState = await waitFor(
			"Windows bundled runtime state",
			Math.min(deadline, Date.now() + 120_000),
			() => {
				const value = runtimeState(projectRoot, app!.pid);
				if (value) observedState = value;
				return value?.readiness?.ready === true ? value : undefined;
			},
		);
		runtime = requireRuntimeContract(readyRuntimeState);
		if (typeof readyRuntimeState.publicOrigin !== "string")
			throw new Error("validated Windows runtime state has no publicOrigin");
		const runtimeIdentities = runtime.pids
			.map((pid) => windowsSnapshot().find((value) => value.pid === pid))
			.filter((value): value is ProcessSnapshot => value !== undefined)
			.map((value) => ({ pid: value.pid, startedAt: value.startedAt }));
		if (runtimeIdentities.length !== runtime.pids.length)
			throw new Error(
				"Windows runtime state named an absent process before cleanup evidence could be established",
			);
		const observed = observer.observeStateRoots(runtimeIdentities);
		if (observed.errors.length)
			throw new Error(
				`Windows runtime identities were not observed through product ancestry: ${observed.errors.join("; ")}`,
			);
		const before = await withinDeadline(
			"WebView2 initial source",
			deadline,
			browser.getPageSource(),
		);
		const control = await browser.$(`aria/${DASHBOARD_CONTROL}`);
		if (
			!(await withinDeadline(
				"Dashboard control visibility",
				deadline,
				Promise.resolve(control.isDisplayed()),
			))
		)
			throw new Error(
				"WebView2 could not expose an interactable Dashboard control",
			);
		await withinDeadline(
			"Dashboard control click",
			deadline,
			Promise.resolve(control.click()),
		);
		const after = await withinDeadline(
			"WebView2 Dashboard result",
			deadline,
			browser.getPageSource(),
		);
		validateWindowsNativeInteraction(before, after);
		event("webview2-interaction", {
			sourceBytes: before.length,
			sourceAfterBytes: after.length,
			app,
			runtime,
		});
		const preview = await runWindowsNativePreviewScenario(
			browser as any,
			previewFixture,
			deadline,
			readyRuntimeState.publicOrigin,
		);
		safeEvent("webview2-preview", preview);
		closeMainWindow(app);
		await waitFor(
			"Windows product normal exit",
			Math.min(deadline, Date.now() + 25_000),
			() => (!live(app!) ? true : undefined),
		);
		const postQuit = await observer.verify(
			Math.min(deadline, Date.now() + 25_000),
		);
		if (postQuit.errors.length || postQuit.liveMembers.length)
			throw new Error(
				`Windows product observer retained identities after Quit: ${[...postQuit.errors, ...postQuit.liveMembers.map((value) => `${value.pid}:${value.startedAt}`)].join("; ")}`,
			);
		const retained = await waitForPortsReleasedUntil(
			runtime.ports,
			Math.min(deadline, Date.now() + 25_000),
		);
		if (retained.length)
			throw new Error(
				`Windows runtime ports remained bound: ${retained.join("; ")}`,
			);
		if (!jobEvidence || !driverJobBaseline)
			throw new Error(
				"Windows native product ownership evidence was not initialized before driver spawn",
			);
		jobEvidence.assertCleaned(driverJobBaseline);
		event("verdict-before-driver-teardown", {
			outcome: "passed",
			app,
			ownership: "outer Job Object PID+creation identity evidence",
		});
		succeeded = true;
	} catch (error) {
		primary = error;
		try {
			event("verdict-before-driver-teardown", {
				outcome: "failed",
				error: error instanceof Error ? error.message : String(error),
			});
		} catch (eventError) {
			cleanupErrors.push(
				eventError instanceof Error
					? eventError
					: new Error(String(eventError)),
			);
		}
	} finally {
		const cleanupDeadline = Date.now() + NATIVE_CLEANUP_BUDGET_MS;
		if (!app) {
			const watched = launchWatcher?.take();
			if (watched) app = watched;
		}
		if (!app && product)
			try {
				const found = windowsProcesses(product.executable);
				if (found.length === 1) app = found[0];
				else if (found.length > 1)
					cleanupErrors.push(
						new Error("ambiguous Windows product process after failed session"),
					);
			} catch (error) {
				cleanupErrors.push(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		if (app && !observer)
			try {
				observer = createProcessObserver(
					{ pid: app.pid },
					{
						explicitRootIdentity: app,
						snapshotter: windowsSnapshot,
						pollIntervalMs: 50,
					},
				);
			} catch (error) {
				cleanupErrors.push(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		if (app)
			try {
				const recovered = runtimeState(projectRoot, app.pid);
				if (recovered) observedState = recovered;
			} catch (error) {
				cleanupErrors.push(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		if (app)
			try {
				if (live(app)) {
					closeMainWindow(app);
					await waitFor(
						"fallback Windows product exit",
						Math.min(cleanupDeadline, Date.now() + 25_000),
						() => (!live(app!) ? true : undefined),
					);
				}
			} catch (error) {
				cleanupErrors.push(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		if (observer) {
			try {
				const evidence = await observer.verify(
					Math.min(cleanupDeadline, Date.now() + 25_000),
				);
				if (evidence.errors.length || evidence.liveMembers.length)
					cleanupErrors.push(
						new Error(
							`Windows fallback observer retained identities: ${[...evidence.errors, ...evidence.liveMembers.map((value) => value.pid)].join("; ")}`,
						),
					);
			} catch (error) {
				cleanupErrors.push(
					error instanceof Error ? error : new Error(String(error)),
				);
			} finally {
				observer.stop();
			}
		}
		if (runtime || observedState)
			try {
				const ports = runtime?.ports ?? partialRuntimePorts(observedState);
				const retained = await waitForPortsReleasedUntil(
					ports,
					Math.min(cleanupDeadline, Date.now() + 25_000),
				);
				if (retained.length)
					cleanupErrors.push(
						new Error(
							`Windows fallback retained runtime ports: ${retained.join("; ")}`,
						),
					);
			} catch (error) {
				cleanupErrors.push(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		if (jobEvidence && driverJobBaseline)
			try {
				jobEvidence.assertCleaned(driverJobBaseline);
			} catch (error) {
				cleanupErrors.push(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		if (launchWatcher) launchWatcher.stop();
		if (browser)
			try {
				await withinDeadline(
					"WebView2 driver teardown",
					cleanupDeadline,
					browser.deleteSession(),
				);
			} catch (error) {
				cleanupErrors.push(
					error instanceof Error ? error : new Error(String(error)),
				);
				safeEvent("driver-teardown-failure", String(error));
			}
		if (driver && driver.exitCode === null) {
			if (!driver.kill())
				cleanupErrors.push(new Error("could not stop tauri-driver"));
			else
				await Promise.race([
					new Promise<void>((done) => driver!.once("exit", done)),
					sleep(Math.max(1, Math.min(5_000, cleanupDeadline - Date.now()))),
				]);
			if (driver.exitCode === null)
				cleanupErrors.push(
					new Error("tauri-driver did not exit after SIGTERM"),
				);
		}
		if (jobEvidence && initialJobBaseline)
			try {
				jobEvidence.assertCleaned(initialJobBaseline);
			} catch (error) {
				cleanupErrors.push(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		if (previewFixture)
			try {
				previewFixture.cleanup();
			} catch (error) {
				cleanupErrors.push(
					error instanceof Error ? error : new Error(String(error)),
				);
			}
	}
	if (!succeeded || primary || cleanupErrors.length)
		throw new AggregateError(
			[...(primary ? [primary] : []), ...cleanupErrors],
			"Windows native smoke failed or cleanup was incomplete",
		);
	return directory;
}
