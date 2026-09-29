#!/usr/bin/env bun

import {
	closeSync,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { connect as netConnect, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { probeDesktopEngine, startDesktopServices } from "./desktop-engine";
import {
	desktopExecutablePath,
	normalizeWindowsDevicePath,
} from "./desktop-environment";
import { writeDesktopPipe } from "./desktop-pipe";
import {
	DESKTOP_ENGINE_BASE_PORT,
	DESKTOP_SERVER_BASE_PORT,
	type DesktopPortLease,
	reserveDesktopPorts,
} from "./desktop-ports";
import {
	assessDesktopTeardown,
	DESKTOP_TASKKILL_TIMEOUT_MS,
	desktopProcessTreePlan,
	desktopSpawnOptions,
	executeDesktopProcessTreePlan,
	type ProcessTreeTaskkillOperation,
} from "./desktop-process-tree";
import {
	assertDesktopEngineConfigImportClosure,
	desktopStableAgentHostDirectory,
	desktopStableAgentHostSocket,
	materializeDesktopEngineRootFiles,
} from "./desktop-runtime-layout";
import { initializeWindowsJobObject } from "./desktop-windows-job";

const STARTUP_TIMEOUT_MS = 120_000;
const GUARDIAN_SHUTDOWN_GRACE_MS = 10_000;
const STATE_WRITE_ATTEMPTS = 5;
const STATE_WRITE_RETRY_CODES = new Set(["EPERM", "EBUSY"]);
const MAX_TARGET_ENV_BYTES = 1 << 20;
const LOADER_ENV_KEYS = new Set([
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH",
	"DYLD_FRAMEWORK_PATH",
	"DYLD_FALLBACK_LIBRARY_PATH",
]);
const GUARDIAN_CONTROL_ENV_KEYS = new Set([
	"FORGEAX_RUNTIME_GUARDIAN_PATH",
	"FORGEAX_RUNTIME_GUARDIAN_TARGET_ENV_FD",
]);

type ServiceProbe = {
	ready: boolean;
	url: string;
	status?: number;
	error?: string;
};
type RuntimeStatus = "starting" | "ready" | "failed" | "stopping" | "stopped";

const resourceRoot = resolve(
	normalizeWindowsDevicePath(requiredEnv("FORGEAX_RESOURCE_ROOT")),
);
const projectRoot = resolve(requiredEnv("FORGEAX_PROJECT_ROOT"));
const stateFile = resolve(requiredEnv("FORGEAX_RUNTIME_STATE_FILE"));
const runtimeBaseDirectory = join(projectRoot, ".forgeax", "runtime");
const runtimeDirectory = join(
	runtimeBaseDirectory,
	`desktop-prod-${process.pid}`,
);
const engineReadyFile = join(runtimeDirectory, "engine-listening");
const startedAt = new Date().toISOString();
const children = new Map<string, Bun.Subprocess>();
// POSIX service processes are direct children of a guardian. Their guardian
// PID is the only teardown authority; no PID/PGID is read from runtime state.
let runtimeGuardianPath = "";
let portLease: DesktopPortLease | undefined;
let portOffset = 0;
let serverPort = DESKTOP_SERVER_BASE_PORT;
let enginePort = DESKTOP_ENGINE_BASE_PORT;
let publicOrigin = `http://127.0.0.1:${serverPort}`;
let agentHostSocket = "";
let status: RuntimeStatus = "starting";
let readiness: Record<string, ServiceProbe> | undefined;
let failure: string | undefined;
let stopping = false;

function requiredEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
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
		`unsupported desktop runtime platform: ${process.platform}/${process.arch}`,
	);
}

function writeState(): void {
	const document = {
		schemaVersion: 1,
		profile: "desktop-prod",
		status,
		launcherPid: process.pid,
		startedAt,
		updatedAt: new Date().toISOString(),
		publicOrigin,
		resourceRoot,
		projectRoot,
		portOffset,
		managedPorts: { server: serverPort, engine: enginePort },
		servicePids: Object.fromEntries(
			[...children].map(([name, child]) => [name, child.pid]),
		),
		...(readiness
			? {
					readiness: {
						ready: Object.values(readiness).every((item) => item.ready),
						checkedAt: new Date().toISOString(),
						services: readiness,
					},
				}
			: {}),
		...(failure ? { error: failure } : {}),
	};
	mkdirSync(dirname(stateFile), { recursive: true });
	const temporary = `${stateFile}.${process.pid}.tmp`;
	for (let attempt = 1; attempt <= STATE_WRITE_ATTEMPTS; attempt += 1) {
		try {
			writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`);
			renameSync(temporary, stateFile);
			return;
		} catch (error) {
			const code =
				error && typeof error === "object" && "code" in error
					? String(error.code)
					: "";
			if (
				process.platform !== "win32" ||
				!STATE_WRITE_RETRY_CODES.has(code) ||
				attempt === STATE_WRITE_ATTEMPTS
			) {
				throw error;
			}
			Atomics.wait(
				new Int32Array(new SharedArrayBuffer(4)),
				0,
				0,
				25 * 2 ** (attempt - 1),
			);
		}
	}
}

function prepareRuntimeDirectory(): void {
	mkdirSync(runtimeBaseDirectory, { recursive: true });
	// The path is launcher-owned (PID-qualified), so a previous crashed
	// launcher with a reused PID can only remove its own disposable runtime.
	rmSync(runtimeDirectory, { recursive: true, force: true });
	mkdirSync(runtimeDirectory, { recursive: true });
}

function cleanupRuntimeDirectory(): void {
	if (dirname(runtimeDirectory) !== runtimeBaseDirectory) {
		throw new Error(
			`refusing to clean runtime path outside launcher runtime base: ${runtimeDirectory}`,
		);
	}
	rmSync(runtimeDirectory, { recursive: true, force: true });
}

function replaceJunction(path: string, target: string): void {
	rmSync(path, { recursive: true, force: true });
	symlinkSync(resolve(target), path, "junction");
}

function materializeNodeModules(source: string, destination: string): void {
	rmSync(destination, { recursive: true, force: true });
	mkdirSync(destination, { recursive: true });
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		if (entry.name === ".vite" || entry.name === ".vite-temp") continue;
		const input = realpathSync(join(source, entry.name));
		const output = join(destination, entry.name);
		if (statSync(input).isDirectory()) symlinkSync(input, output, "junction");
		else copyFileSync(input, output);
	}
}

function materializeEngineWorkspace(): string {
	const source = join(resourceRoot, "engine");
	const destination = join(runtimeDirectory, "engine");
	for (const required of ["src", "node_modules/vite/bin/vite.js"]) {
		if (!existsSync(join(source, required)))
			throw new Error(
				`packaged engine resource is missing: engine/${required}`,
			);
	}
	mkdirSync(destination, { recursive: true });
	materializeDesktopEngineRootFiles(source, destination);
	for (const entry of ["src", "public"]) {
		const input = join(source, entry);
		const output = join(destination, entry);
		rmSync(output, { recursive: true, force: true });
		if (existsSync(input))
			cpSync(input, output, {
				recursive: true,
				dereference: true,
				force: true,
			});
	}
	mkdirSync(join(projectRoot, ".forgeax", "games"), { recursive: true });
	materializeNodeModules(
		join(source, "node_modules"),
		join(destination, "node_modules"),
	);
	for (const entry of ["forgeax-editor-assets", "forgeax-engine-assets"]) {
		replaceJunction(join(destination, entry), join(source, entry));
	}
	// The engine workspace must not inherit another launcher's runtime state.
	// Games are the one intentional shared project surface.
	mkdirSync(join(destination, ".forgeax"), { recursive: true });
	replaceJunction(
		join(destination, ".forgeax", "games"),
		join(projectRoot, ".forgeax", "games"),
	);
	rmSync(join(destination, "shared-assets"), { recursive: true, force: true });
	rmSync(join(destination, "engine-assets"), { recursive: true, force: true });
	assertDesktopEngineConfigImportClosure(destination);
	return destination;
}

function sanitizedGuardianEnvironment(
	env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(env).filter(
			([key]) =>
				!LOADER_ENV_KEYS.has(key) && !GUARDIAN_CONTROL_ENV_KEYS.has(key),
		),
	);
}

async function spawn(
	name: string,
	command: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	options: { targetEnv?: NodeJS.ProcessEnv } = {},
): Promise<Bun.Subprocess> {
	const targetEnv =
		process.platform === "win32" ? undefined : options.targetEnv;
	const guardedCommand =
		process.platform === "win32"
			? command
			: [
					runtimeGuardianPath,
					"--grace-ms",
					"3000",
					...(targetEnv ? ["--target-env-fd", "3"] : []),
					"--",
					...command,
				];
	if (process.platform !== "win32" && !runtimeGuardianPath) {
		throw new Error("POSIX runtime guardian path was not initialized");
	}
	const streams = targetEnv
		? {
				stdio: ["pipe", "inherit", "inherit", "pipe"] as [
					"pipe",
					"inherit",
					"inherit",
					"pipe",
				],
			}
		: {
				stdin:
					process.platform === "win32"
						? ("ignore" as const)
						: ("pipe" as const),
				stdout: "inherit" as const,
				stderr: "inherit" as const,
			};
	const child = Bun.spawn(guardedCommand, {
		cwd,
		env: targetEnv ? sanitizedGuardianEnvironment(env) : env,
		// Keeping this pipe open is the guardian owner-death channel. The
		// guardian forwards bytes to the target and treats only EOF as owner
		// death; target stdin EPIPE is not used for this decision.
		...streams,
		...(process.platform === "win32"
			? desktopSpawnOptions(process.platform)
			: { detached: false }),
	});
	children.set(name, child);
	writeState();
	if (targetEnv) {
		const envFd = child.stdio[3];
		if (typeof envFd !== "number") {
			child.kill("SIGTERM");
			throw new Error(
				`POSIX runtime guardian target environment pipe is unavailable for ${name}`,
			);
		}
		const payload = Buffer.from(JSON.stringify(targetEnv));
		if (payload.byteLength > MAX_TARGET_ENV_BYTES) {
			closeSync(envFd);
			child.kill("SIGTERM");
			throw new Error(
				`POSIX runtime guardian target environment exceeds ${MAX_TARGET_ENV_BYTES} bytes`,
			);
		}
		try {
			await writeDesktopPipe(envFd, payload);
		} finally {
			closeSync(envFd);
		}
	}
	return child;
}

function liveChildren(): Bun.Subprocess[] {
	return [...children.values()].filter((child) => child.exitCode === null);
}

async function waitForChildren(
	timeoutMs: number,
): Promise<{ completed: boolean; error?: string }> {
	const pending = liveChildren();
	if (pending.length === 0) return { completed: true };
	try {
		const completed = await Promise.race([
			Promise.all(pending.map((child) => child.exited)).then(() => true),
			Bun.sleep(timeoutMs).then(() => false),
		]);
		return { completed };
	} catch (error) {
		return {
			completed: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function taskkillOperation(
	args: readonly string[],
): ProcessTreeTaskkillOperation {
	const taskkill = Bun.spawn(["taskkill", ...args], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
		windowsHide: true,
	});
	const result = Promise.all([
		taskkill.exited,
		taskkill.stderr
			? new Response(taskkill.stderr).text()
			: Promise.resolve(""),
	]).then(([exitCode, stderr]) => ({ exitCode, stderr }));
	let terminated = false;
	return {
		result,
		terminate: () => {
			if (terminated || taskkill.exitCode !== null) return;
			terminated = true;
			taskkill.kill("SIGKILL");
		},
	};
}

function windowsProcessTreeExecutor(): Parameters<
	typeof executeDesktopProcessTreePlan
>[1] {
	return {
		signal: (pid, signal) => {
			const child = [...children.values()].find(
				(candidate) => candidate.pid === pid,
			);
			if (!child)
				throw new Error(
					`desktop runtime direct child ${pid} is no longer managed`,
				);
			child.kill(signal);
		},
		taskkill: taskkillOperation,
	};
}

/** Ask only an authoritative direct guardian to close its owned target group. */
function requestPosixGuardianShutdown(): void {
	for (const child of liveChildren()) {
		try {
			child.kill("SIGTERM");
		} catch (error) {
			console.error(
				`[desktop-runtime] failed to signal guardian ${child.pid}:`,
				error,
			);
		}
	}
}

async function probe(
	url: string,
	redirect: RequestRedirect = "follow",
): Promise<ServiceProbe> {
	try {
		const response = await fetch(url, {
			redirect,
			signal: AbortSignal.timeout(1_000),
		});
		await response.body?.cancel();
		const ready =
			response.ok ||
			(redirect === "manual" &&
				response.status >= 300 &&
				response.status < 400);
		return { ready, url, status: response.status };
	} catch (error) {
		return {
			ready: false,
			url,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function probeAgentHost(): Promise<ServiceProbe> {
	const url = `unix:${agentHostSocket}`;
	return new Promise((resolveProbe) => {
		let socket: Socket | undefined;
		let settled = false;
		let pending = "";
		const finish = (result: ServiceProbe): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket?.destroy();
			resolveProbe(result);
		};
		const timer = setTimeout(
			() => finish({ ready: false, url, error: "agent-host ping timeout" }),
			1_000,
		);
		try {
			socket = netConnect(agentHostSocket);
			socket.once("connect", () => {
				socket?.write(
					`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`,
				);
			});
			socket.on("data", (chunk) => {
				pending += chunk.toString("utf8");
				const lines = pending.split(/\r?\n/);
				pending = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const response = JSON.parse(line) as {
							id?: unknown;
							result?: unknown;
							error?: { message?: string };
						};
						if (response.id !== 1) continue;
						if (response.error)
							finish({
								ready: false,
								url,
								error: response.error.message ?? "agent-host ping failed",
							});
						else finish({ ready: true, url });
						return;
					} catch {
						finish({
							ready: false,
							url,
							error: "agent-host returned invalid ping response",
						});
						return;
					}
				}
			});
			socket.once("error", (error) =>
				finish({ ready: false, url, error: error.message }),
			);
			socket.once("close", () =>
				finish({
					ready: false,
					url,
					error: "agent-host socket closed before ping response",
				}),
			);
		} catch (error) {
			finish({
				ready: false,
				url,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
}

async function waitForAgentHostReadiness(child: Bun.Subprocess): Promise<void> {
	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (child.exitCode !== null)
			throw new Error(
				`packaged runtime service agent-host exited before readiness (${child.exitCode})`,
			);
		const agentHost = await probeAgentHost();
		readiness = { agentHost };
		writeState();
		if (agentHost.ready) return;
		await Bun.sleep(250);
	}
	throw new Error(
		`packaged agent host did not become ready within ${STARTUP_TIMEOUT_MS / 1_000} seconds`,
	);
}

async function waitForEngineReadiness(deadline: number): Promise<void> {
	while (Date.now() < deadline) {
		const engine = await probeDesktopEngine(
			`http://127.0.0.1:${enginePort}/`,
			engineReadyFile,
		);
		readiness = { ...readiness, engine };
		writeState();
		const exitedService = [...children.entries()].find(
			([, child]) => child.exitCode !== null,
		);
		if (exitedService)
			throw new Error(
				`packaged runtime service ${exitedService[0]} exited before Engine readiness`,
			);
		if (engine.ready) return;
		await Bun.sleep(250);
	}
	throw new Error(
		`packaged Engine did not become ready within ${STARTUP_TIMEOUT_MS / 1_000} seconds`,
	);
}

async function waitForReadiness(deadline: number): Promise<void> {
	while (Date.now() < deadline) {
		const [server, engine, agentHost] = await Promise.all([
			probe(`${publicOrigin}/api/health`),
			// Loading /preview/ starts Vite's full dependency transformation. The
			// root redirect is the lightweight listener/readiness boundary; release
			// smoke owns the real /preview/ request and scene validation.
			probeDesktopEngine(`http://127.0.0.1:${enginePort}/`, engineReadyFile),
			process.platform === "win32"
				? Promise.resolve(undefined)
				: probeAgentHost(),
		]);
		readiness = {
			server,
			interface: server,
			engine,
			...(agentHost ? { agentHost } : {}),
		};
		writeState();
		const exitedService = [...children.entries()].find(
			([, child]) => child.exitCode !== null,
		);
		if (exitedService) {
			throw new Error(
				`packaged runtime service ${exitedService[0]} exited before readiness`,
			);
		}
		if (
			server.ready &&
			engine.ready &&
			(process.platform === "win32" || agentHost?.ready)
		)
			return;
		await Bun.sleep(250);
	}
	throw new Error(
		`packaged runtime did not become ready within ${STARTUP_TIMEOUT_MS / 1_000} seconds`,
	);
}

async function stop(exitCode: number, persistState = true): Promise<never> {
	if (stopping) await new Promise(() => {});
	stopping = true;
	const teardownFailures: string[] = [];
	let forced = false;
	if (status !== "failed") status = "stopping";
	const recordFailure = (stage: string, error: unknown): void => {
		const detail = error instanceof Error ? error.message : String(error);
		teardownFailures.push(`${stage}: ${detail}`);
		console.error(`[desktop-runtime] ${stage}:`, error);
	};

	if (persistState) {
		try {
			writeState();
		} catch (error) {
			recordFailure("failed to persist stopping state", error);
		}
	}

	const remainingGroups: number[] = [];
	if (process.platform === "win32") {
		const gracefulPids = liveChildren().map((child) => child.pid);
		try {
			const failures = await executeDesktopProcessTreePlan(
				desktopProcessTreePlan("win32", gracefulPids, "SIGTERM"),
				windowsProcessTreeExecutor(),
			);
			for (const treeFailure of failures)
				recordFailure(
					`failed to terminate runtime tree (${treeFailure.action.kind})`,
					treeFailure.error,
				);
		} catch (error) {
			recordFailure("failed to plan graceful runtime tree teardown", error);
		}
		const gracefulWait = await waitForChildren(GUARDIAN_SHUTDOWN_GRACE_MS);
		if (gracefulWait.error)
			recordFailure("child teardown wait failed", gracefulWait.error);
		forced = liveChildren().length > 0;
		if (forced) {
			const forcedPids = liveChildren().map((child) => child.pid);
			try {
				const failures = await executeDesktopProcessTreePlan(
					desktopProcessTreePlan("win32", forcedPids, "SIGKILL"),
					windowsProcessTreeExecutor(),
					{ taskkillTimeoutMs: DESKTOP_TASKKILL_TIMEOUT_MS },
				);
				for (const treeFailure of failures)
					recordFailure(
						`failed to force-terminate runtime tree (${treeFailure.action.kind})`,
						treeFailure.error,
					);
			} catch (error) {
				recordFailure("failed to plan forced runtime tree teardown", error);
			}
			const forcedWait = await waitForChildren(GUARDIAN_SHUTDOWN_GRACE_MS);
			if (forcedWait.error)
				recordFailure("forced child teardown wait failed", forcedWait.error);
		}
	} else {
		// Guardian PIDs are direct-child handles, not workload PGIDs. The
		// guardian owns SIGKILL of its target group; this process only sends TERM
		// and waits for guardian closure, never a negative PID or SIGKILL.
		requestPosixGuardianShutdown();
		const gracefulWait = await waitForChildren(GUARDIAN_SHUTDOWN_GRACE_MS);
		if (gracefulWait.error)
			recordFailure("guardian teardown wait failed", gracefulWait.error);
		forced = liveChildren().length > 0;
		if (forced)
			recordFailure(
				"POSIX runtime guardian did not exit within its bounded grace period",
				[...children]
					.filter(([, child]) => child.exitCode === null)
					.map(([name]) => name)
					.join(", "),
			);
	}

	const childrenLive = liveChildren().length > 0;
	if (childrenLive)
		recordFailure(
			"direct runtime child is still alive",
			[...children]
				.filter(([, child]) => child.exitCode === null)
				.map(([name]) => name)
				.join(", "),
		);
	const groupsLive = remainingGroups.length > 0;
	if (groupsLive)
		recordFailure(
			"runtime process group is still alive",
			remainingGroups.join(", "),
		);
	const processTreeClosed = !childrenLive && !groupsLive;
	if (processTreeClosed) {
		try {
			await portLease?.release();
			portLease = undefined;
		} catch (error) {
			recordFailure(
				"failed to release desktop port lease during teardown",
				error,
			);
		}
	}

	const assessment = assessDesktopTeardown({
		forced,
		childrenLive,
		groupsLive,
		failures: teardownFailures,
		exitCode,
		existingFailure: failure,
	});
	if (assessment.cleanupRuntimeDirectory) {
		try {
			cleanupRuntimeDirectory();
		} catch (error) {
			recordFailure(
				"failed to clean launcher runtime directory during teardown",
				error,
			);
		}
	}

	const finalAssessment = assessDesktopTeardown({
		forced,
		childrenLive,
		groupsLive,
		failures: teardownFailures,
		exitCode,
		existingFailure: failure,
	});
	status = finalAssessment.status;
	if (finalAssessment.error) failure = finalAssessment.error;
	try {
		writeState();
	} catch (error) {
		recordFailure("failed to persist terminal teardown state", error);
		status = "failed";
		failure = [
			...(failure ? [failure] : []),
			teardownFailures.at(-1) ?? "terminal state write failed",
		].join("; ");
	}
	process.exit(
		status === "failed"
			? finalAssessment.exitCode === 0
				? 1
				: finalAssessment.exitCode
			: finalAssessment.exitCode,
	);
}

async function main(): Promise<void> {
	await initializeWindowsJobObject();
	mkdirSync(projectRoot, { recursive: true });
	prepareRuntimeDirectory();
	rmSync(stateFile, { force: true });
	const ports = await reserveDesktopPorts();
	portLease = ports;
	portOffset = ports.offset;
	serverPort = ports.server;
	enginePort = ports.engine;
	publicOrigin = `http://127.0.0.1:${serverPort}`;
	const stableAgentHostDirectory = desktopStableAgentHostDirectory(
		projectRoot,
		portOffset,
	);
	mkdirSync(stableAgentHostDirectory, { recursive: true });
	agentHostSocket = desktopStableAgentHostSocket(projectRoot, portOffset);
	writeState();
	const { triple, extension } = targetTriple();
	const server = join(
		resourceRoot,
		"sidecars",
		`forgeax-server-${triple}${extension}`,
	);
	if (!existsSync(server))
		throw new Error(`packaged server sidecar is missing: ${server}`);
	if (process.platform !== "win32") {
		runtimeGuardianPath = join(
			resourceRoot,
			"sidecars",
			`runtime-guardian-${triple}${extension}`,
		);
		if (
			!existsSync(runtimeGuardianPath) ||
			!statSync(runtimeGuardianPath).isFile() ||
			(statSync(runtimeGuardianPath).mode & 0o111) === 0
		) {
			throw new Error(
				`packaged runtime guardian is missing: ${runtimeGuardianPath}`,
			);
		}
	}
	const serverRuntime = join(resourceRoot, "server-runtime");
	if (!existsSync(serverRuntime))
		throw new Error(
			`packaged server native runtime is missing: ${serverRuntime}`,
		);
	const serverPreload = join(serverRuntime, "native-preload.mjs");
	if (!existsSync(serverPreload))
		throw new Error(
			`packaged server native preload is missing: ${serverPreload}`,
		);
	const agentHost = join(serverRuntime, "agent-host.mjs");
	if (!existsSync(agentHost))
		throw new Error(`packaged agent host is missing: ${agentHost}`);
	const coreServe = join(serverRuntime, "forgeax-core-serve.mjs");
	if (!existsSync(coreServe))
		throw new Error(
			`packaged forgeax-core serve entry is missing: ${coreServe}`,
		);
	const engineRoot = materializeEngineWorkspace();
	const runtimeSecret = crypto.randomUUID();
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: desktopExecutablePath(),
		NODE_ENV: "production",
		FORGEAX_STARTUP_PROFILE: "desktop-prod",
		FORGEAX_RESOURCE_ROOT: resourceRoot,
		FORGEAX_PRODUCT_ROOT: join(resourceRoot, "product"),
		FORGEAX_ENGINE_RESOURCE_ROOT: join(resourceRoot, "engine"),
		FORGEAX_ENGINE_WORKSPACE_ROOT: engineRoot,
		FORGEAX_VITE_CACHE_ROOT: join(engineRoot, ".vite"),
		FORGEAX_COMMANDS_DIR: join(serverRuntime, "commands"),
		FORGEAX_STATIC_BUILTIN_COMMANDS: "1",
		FORGEAX_GAME_CHARTER_PATH: join(serverRuntime, "assets", "game-charter.md"),
		FORGEAX_PROJECT_ROOT: projectRoot,
		FORGEAX_SERVER_HOST: "127.0.0.1",
		FORGEAX_SERVER_PORT: String(serverPort),
		FORGEAX_SERVER_URL: publicOrigin,
		FORGEAX_INTERFACE_PORT: String(serverPort),
		FORGEAX_HMR_CLIENT_PORT: String(serverPort),
		FORGEAX_SERVE_SPA: "1",
		FORGEAX_ENGINE_HOST: "127.0.0.1",
		FORGEAX_ENGINE_PORT: String(enginePort),
		FORGEAX_ENGINE_URL: `http://127.0.0.1:${enginePort}`,
		FORGEAX_GAMES_URL_PREFIX: "host-games",
		FORGEAX_DDC_BUILD_CACHE_ROOT: join(
			runtimeDirectory,
			".forgeax",
			"ddc",
			"build",
		),
		FORGEAX_DDC_PROJECT_ROOT: join(
			runtimeDirectory,
			".forgeax",
			"ddc",
			"unbound",
		),
		FORGEAX_RUNTIME_SCOPE_SECRET: runtimeSecret,
		FORGEAX_AGENT_HOST_SOCK: agentHostSocket,
		FORGEAX_AGENT_HOST_ENTRY: agentHost,
		FORGEAX_CORE_SERVE_ENTRY: coreServe,
		FORGEAX_NPC_BRAIN_DATA_DIR: join(runtimeDirectory, "npc-brain"),
		FORGEAX_NPC_BRAIN_AUTH_TOKEN: runtimeSecret,
	};
	await ports.releaseReservations();
	if (process.platform !== "win32") {
		const agentHostChild = await spawn(
			"agent-host",
			[process.execPath, "run", agentHost],
			serverRuntime,
			{
				...env,
				FORGEAX_AGENT_HOST_EXTERNAL_ONLY: "1",
				FORGEAX_RUNTIME_GUARDIAN_PATH: runtimeGuardianPath,
			},
			{
				targetEnv: {
					...env,
					FORGEAX_AGENT_HOST_EXTERNAL_ONLY: "1",
					FORGEAX_RUNTIME_GUARDIAN_PATH: runtimeGuardianPath,
				},
			},
		);
		await waitForAgentHostReadiness(agentHostChild);
	}
	const startupDeadline = Date.now() + STARTUP_TIMEOUT_MS;
	const { engine: engineChild, server: serverChild } =
		await startDesktopServices({
			startEngine: () =>
				spawn(
					"engine",
					[
						process.execPath,
						"run",
						join(resourceRoot, "runtime/engine-runtime.mjs"),
						engineReadyFile,
					],
					engineRoot,
					env,
				),
			waitForEngine: () => waitForEngineReadiness(startupDeadline),
			startServer: () =>
				spawn("server", [server], serverRuntime, {
					...env,
					...(process.platform !== "win32"
						? { FORGEAX_AGENT_HOST_EXTERNAL_ONLY: "1" }
						: {}),
					NODE_PATH: join(serverRuntime, "node_modules"),
					// Bun splits BUN_OPTIONS on spaces and does not decode percent-encoded file
					// URLs. Resolve the preload from the server cwd so an app bundle such as
					// "ForgeaX Studio.app" remains launchable.
					BUN_OPTIONS: "--preload=./native-preload.mjs",
					FORGEAX_BUN_EXECUTABLE: process.execPath,
				}),
		});
	await waitForReadiness(startupDeadline);
	status = "ready";
	writeState();
	await ports.release();
	portLease = undefined;
	const agentHostChild =
		process.platform === "win32" ? undefined : children.get("agent-host");
	const exited = await Promise.race([
		serverChild.exited.then((code) => `server exited with ${code}`),
		engineChild.exited.then((code) => `engine exited with ${code}`),
		...(agentHostChild
			? [agentHostChild.exited.then((code) => `agent-host exited with ${code}`)]
			: []),
	]);
	throw new Error(exited);
}

process.once("SIGINT", () => void stop(130));
process.once("SIGTERM", () => void stop(143));

async function listenForShutdown(): Promise<void> {
	const decoder = new TextDecoder();
	let pending = "";
	const reader = Bun.stdin.stream().getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			pending += decoder.decode(value, { stream: true });
			const lines = pending.split(/\r?\n/);
			pending = lines.pop() ?? "";
			if (lines.includes("shutdown")) {
				await stop(0);
				return;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

void listenForShutdown();

main().catch(async (error) => {
	if (stopping) return;
	failure = error instanceof Error ? error.message : String(error);
	status = "failed";
	try {
		writeState();
	} catch (stateError) {
		console.error(
			"[desktop-runtime] failed to persist terminal failure state:",
			stateError,
		);
	}
	console.error(`[desktop-runtime] ${failure}`);
	await stop(1, false);
});
