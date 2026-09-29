#!/usr/bin/env bun

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { desktopAgentHostSocket } from "./desktop-environment";

const STARTUP_TIMEOUT_MS = 120_000;

function extendedWindowsPath(value: string): string {
	return value.startsWith("\\\\?\\") ? value : `\\\\?\\${value}`;
}

function argument(name: string): string | undefined {
	const index = Bun.argv.indexOf(name);
	return index >= 0 ? Bun.argv[index + 1] : undefined;
}

async function freePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("failed to allocate an isolated TCP port"));
				return;
			}
			server.close((error) =>
				error ? reject(error) : resolvePort(address.port),
			);
		});
	});
}

async function collect(
	stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	const reader = stream.getReader();
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			length += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	const output = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return output;
}

async function terminateProcessTree(child: Bun.Subprocess): Promise<void> {
	if (child.exitCode !== null) return;
	if (process.platform === "win32") {
		await Bun.spawn(["taskkill.exe", "/PID", String(child.pid), "/T", "/F"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		}).exited;
	} else {
		child.kill("SIGTERM");
	}
	await Promise.race([child.exited, Bun.sleep(5_000)]);
	if (child.exitCode === null) child.kill("SIGKILL");
}

async function smokePackagedFxt(
	bun: string,
	entry: string,
	projectRoot: string,
): Promise<void> {
	const child = Bun.spawn([bun, "run", entry], {
		cwd: dirname(entry),
		env: {
			...process.env,
			FORGEAX_PROJECT_ROOT: projectRoot,
			FORGEAX_FXT_EXPOSE: "echo",
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stderr = collect(child.stderr);
	const reader = child.stdout.getReader();
	const request = `${JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "desktop-smoke", version: "1" },
		},
	})}\n`;
	child.stdin.write(new TextEncoder().encode(request));
	child.stdin.end();
	let responseText = "";
	try {
		const response = await Promise.race([
			reader.read(),
			Bun.sleep(10_000).then(() => {
				throw new Error("packaged fxt initialize timed out");
			}),
		]);
		if (response.done || !response.value)
			throw new Error("packaged fxt closed before initialize response");
		responseText = new TextDecoder().decode(response.value).trim();
		const responseBody = JSON.parse(responseText) as {
			id?: number;
			result?: { serverInfo?: { name?: string } };
			error?: unknown;
		};
		if (
			responseBody.id !== 1 ||
			responseBody.result?.serverInfo?.name !== "fxt" ||
			responseBody.error
		) {
			throw new Error(
				`packaged fxt returned an invalid initialize response: ${responseText}`,
			);
		}
	} catch (error) {
		await terminateProcessTree(child);
		const stderrText = new TextDecoder().decode(await stderr);
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\n${stderrText}`,
		);
	} finally {
		reader.releaseLock();
	}
	await child.exited;
	if (child.exitCode !== 0) {
		throw new Error(
			`packaged fxt exited with code ${child.exitCode}: ${new TextDecoder().decode(await stderr)}`,
		);
	}
}

if (process.platform !== "win32" || process.arch !== "x64") {
	throw new Error(
		`Windows compiled-sidecar smoke requires win32/x64; current host is ${process.platform}/${process.arch}`,
	);
}

const ideRoot = resolve(import.meta.dir, "..");
const resources = resolve(
	argument("--resources") ?? join(ideRoot, "src-tauri/resources"),
);
const serverRuntime = join(resources, "server-runtime");
const server = join(
	resources,
	"sidecars/forgeax-server-x86_64-pc-windows-msvc.exe",
);
const bun = join(resources, "sidecars/bun-x86_64-pc-windows-msvc.exe");
const projectRoot = mkdtempSync(
	join(tmpdir(), "forgeax-windows-compiled-sidecar-"),
);
const serverPort = await freePort();
const enginePort = await freePort();
const origin = `http://127.0.0.1:${serverPort}`;
const runtimeSecret = crypto.randomUUID();
const toolsServerEntry = join(serverRuntime, "assets/forgeax-tools-server.mjs");

await smokePackagedFxt(bun, toolsServerEntry, projectRoot);

const env: NodeJS.ProcessEnv = {
	...process.env,
	PATH: `${dirname(bun)};${process.env.PATH ?? ""}`,
	NODE_ENV: "production",
	NODE_PATH: join(serverRuntime, "node_modules"),
	BUN_OPTIONS: "--preload=./native-preload.mjs",
	FORGEAX_BUN_EXECUTABLE: bun,
	FORGEAX_STARTUP_PROFILE: "desktop-prod",
	FORGEAX_RESOURCE_ROOT: resources,
	FORGEAX_PRODUCT_ROOT: join(resources, "product"),
	FORGEAX_BRAND_DIR: join(resources, "brand"),
	FORGEAX_PROJECT_ROOT: projectRoot,
	FORGEAX_SERVER_HOST: "127.0.0.1",
	FORGEAX_SERVER_PORT: String(serverPort),
	FORGEAX_SERVER_URL: origin,
	FORGEAX_INTERFACE_PORT: String(serverPort),
	FORGEAX_HMR_CLIENT_PORT: String(serverPort),
	FORGEAX_SERVE_SPA: "1",
	FORGEAX_ENGINE_HOST: "127.0.0.1",
	FORGEAX_ENGINE_PORT: String(enginePort),
	FORGEAX_ENGINE_URL: `http://127.0.0.1:${enginePort}`,
	FORGEAX_ENGINE_RESOURCE_ROOT: join(resources, "engine"),
	FORGEAX_ENGINE_WORKSPACE_ROOT: join(projectRoot, ".engine-runtime"),
	FORGEAX_VITE_CACHE_ROOT: join(projectRoot, ".engine-runtime/.vite"),
	FORGEAX_GAMES_URL_PREFIX: "host-games",
	FORGEAX_RUNTIME_SCOPE_SECRET: runtimeSecret,
	FORGEAX_AGENT_HOST_SOCK: desktopAgentHostSocket(projectRoot),
	FORGEAX_AGENT_HOST_ENTRY: join(serverRuntime, "agent-host.mjs"),
	FORGEAX_COMMANDS_DIR: join(serverRuntime, "commands"),
	FORGEAX_NPC_BRAIN_DATA_DIR: join(projectRoot, ".forgeax/runtime/npc-brain"),
	FORGEAX_NPC_BRAIN_AUTH_TOKEN: runtimeSecret,
	FORGEAX_TOOLS_SERVER_ENTRY: toolsServerEntry,
};

const child = Bun.spawn([server], {
	cwd: serverRuntime,
	env,
	stdin: "ignore",
	stdout: "pipe",
	stderr: "pipe",
});
const stdout = collect(child.stdout);
const stderr = collect(child.stderr);
let healthStatus: number | undefined;
let healthBody = "";
let failure: unknown;

try {
	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (child.exitCode !== null)
			throw new Error(
				`compiled server exited before health readiness with code ${child.exitCode}`,
			);
		try {
			const response = await fetch(`${origin}/api/health`, {
				signal: AbortSignal.timeout(1_000),
			});
			healthStatus = response.status;
			healthBody = await response.text();
			if (response.ok) break;
		} catch {
			// Connection refusal is expected while the real compiled server starts.
		}
		await Bun.sleep(200);
	}
	if (!healthStatus || healthStatus < 200 || healthStatus >= 300) {
		throw new Error(
			`compiled server did not become healthy within ${STARTUP_TIMEOUT_MS / 1_000} seconds`,
		);
	}
} catch (error) {
	failure = error;
} finally {
	await terminateProcessTree(child);
}

const [stdoutBytes, stderrBytes] = await Promise.all([stdout, stderr]);
const decoder = new TextDecoder();
const stdoutText = decoder.decode(stdoutBytes);
const stderrText = decoder.decode(stderrBytes);
if (failure) {
	console.error("--- compiled server stdout ---");
	console.error(stdoutText);
	console.error("--- compiled server stderr ---");
	console.error(stderrText);
	console.error(
		JSON.stringify(
			{
				resources,
				server,
				bun,
				projectRoot,
				serverPort,
				enginePort,
				healthStatus,
				healthBody,
			},
			null,
			2,
		),
	);
	rmSync(projectRoot, { recursive: true, force: true });
	throw failure;
}

// Tauri returns resource_dir() through the Win32 extended-length namespace.
// Exercise the assembled launcher with that exact input as well as the direct
// compiled server above, otherwise CI can pass while the installed app fails
// before the preload is evaluated.
const runtimeStateFile = join(
	projectRoot,
	".forgeax/runtime/windows-packaged-smoke.json",
);
const runtimeChild = Bun.spawn(
	[
		bun,
		"run",
		extendedWindowsPath(join(resources, "runtime/local-runtime.mjs")),
		"--profile",
		"desktop-prod",
	],
	{
		env: {
			...process.env,
			FORGEAX_STARTUP_PROFILE: "desktop-prod",
			FORGEAX_RESOURCE_ROOT: extendedWindowsPath(resources),
			FORGEAX_PROJECT_ROOT: projectRoot,
			FORGEAX_RUNTIME_STATE_FILE: runtimeStateFile,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	},
);
const runtimeStdout = collect(runtimeChild.stdout);
const runtimeStderr = collect(runtimeChild.stderr);
let runtimeState: Record<string, unknown> | undefined;
let packagedCommandCount = 0;
let packagedAgentCount = 0;
let runtimeFailure: unknown;
try {
	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (runtimeChild.exitCode !== null) {
			throw new Error(
				`packaged runtime exited before readiness with code ${runtimeChild.exitCode}`,
			);
		}
		if (existsSync(runtimeStateFile)) {
			runtimeState = JSON.parse(
				readFileSync(runtimeStateFile, "utf8"),
			) as Record<string, unknown>;
			if (runtimeState.status === "failed") {
				throw new Error(
					`packaged runtime failed: ${String(runtimeState.error ?? "unknown error")}`,
				);
			}
			if (runtimeState.status === "ready") break;
		}
		await Bun.sleep(200);
	}
	if (runtimeState?.status !== "ready") {
		throw new Error(
			`packaged runtime did not become ready within ${STARTUP_TIMEOUT_MS / 1_000} seconds`,
		);
	}
	const runtimeOrigin = String(runtimeState.publicOrigin ?? "");
	const commandsResponse = await fetch(`${runtimeOrigin}/api/commands`);
	const commandsBody = (await commandsResponse.json()) as {
		commands?: Array<{ name?: string }>;
	};
	if (
		!commandsResponse.ok ||
		!commandsBody.commands?.some((command) => command.name === "list_agents")
	) {
		throw new Error(
			`packaged runtime did not register list_agents: HTTP ${commandsResponse.status}`,
		);
	}
	const commandImportErrors = commandsBody.commands.filter((command) =>
		command.name?.startsWith("_error:"),
	);
	if (commandImportErrors.length > 0) {
		throw new Error(
			`packaged runtime command imports failed: ${commandImportErrors.map((command) => command.name).join(", ")}`,
		);
	}
	packagedCommandCount = commandsBody.commands.length;
	const listAgentsResponse = await fetch(
		`${runtimeOrigin}/api/commands/list_agents/query`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				args: ["windows-packaged-smoke-missing-session"],
			}),
		},
	);
	const listAgentsBody = (await listAgentsResponse.json()) as {
		result?: { ok?: boolean; error?: string };
	};
	if (!listAgentsResponse.ok || listAgentsBody.result?.ok !== true) {
		throw new Error(
			`packaged runtime list_agents query failed: ${listAgentsBody.result?.error ?? `HTTP ${listAgentsResponse.status}`}`,
		);
	}
	const agentsResponse = await fetch(`${runtimeOrigin}/api/agents`);
	const agentsBody = (await agentsResponse.json()) as {
		agents?: unknown[];
		error?: string;
	};
	if (!agentsResponse.ok || !agentsBody.agents?.length) {
		throw new Error(
			`packaged runtime did not load brand agents: ${agentsBody.error ?? `HTTP ${agentsResponse.status}`}`,
		);
	}
	packagedAgentCount = agentsBody.agents.length;
} catch (error) {
	runtimeFailure = error;
} finally {
	await terminateProcessTree(runtimeChild);
}

const [runtimeStdoutBytes, runtimeStderrBytes] = await Promise.all([
	runtimeStdout,
	runtimeStderr,
]);
if (runtimeFailure) {
	console.error("--- packaged runtime stdout ---");
	console.error(decoder.decode(runtimeStdoutBytes));
	console.error("--- packaged runtime stderr ---");
	console.error(decoder.decode(runtimeStderrBytes));
	console.error(
		JSON.stringify(
			{ resources, projectRoot, runtimeStateFile, runtimeState },
			null,
			2,
		),
	);
	rmSync(projectRoot, { recursive: true, force: true });
	throw runtimeFailure;
}

console.log(
	JSON.stringify(
		{
			code: "IDE_WINDOWS_COMPILED_SIDECAR_SMOKE_OK",
			resources,
			server,
			bun,
			projectRoot,
			serverPort,
			enginePort,
			healthStatus,
			healthBody,
			stdoutBytes: stdoutBytes.byteLength,
			stderrBytes: stderrBytes.byteLength,
			packagedRuntimeStatus: runtimeState?.status,
			packagedCommandCount,
			packagedAgentCount,
			packagedRuntimeStdoutBytes: runtimeStdoutBytes.byteLength,
			packagedRuntimeStderrBytes: runtimeStderrBytes.byteLength,
		},
		null,
		2,
	),
);
rmSync(projectRoot, { recursive: true, force: true });
