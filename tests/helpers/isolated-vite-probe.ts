import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";
import type {
	ReadableStream,
	ReadableStreamDefaultReader,
} from "node:stream/web";
export async function runIsolatedViteProbe(
	command: string[],
	timeoutMs: number,
	completionMarker?: string,
): Promise<string> {
	// Give the probe its own process group and deadline so cleanup cannot stop
	// the test runner's shared esbuild service.
	const child = spawn(command[0]!, command.slice(1), {
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
		env: { ...process.env, FORGEAX_VITE_CONTRACT_PROBE: "1" },
	});
	const pid = child.pid;
	const exited = once(child, "exit").then(([code]) => code as number | null);
	let complete: (() => void) | undefined;
	const completion = new Promise<{ completed: true }>((resolve) => {
		complete = () => resolve({ completed: true });
	});
	const stdoutReader = (
		Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
	).getReader();
	const stderrReader = (
		Readable.toWeb(child.stderr!) as ReadableStream<Uint8Array>
	).getReader();
	async function read(
		reader: ReadableStreamDefaultReader<Uint8Array>,
	): Promise<string> {
		const decoder = new TextDecoder();
		let text = "";
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) return text + decoder.decode();
			text += decoder.decode(chunk.value, { stream: true });
			if (
				reader === stdoutReader &&
				completionMarker !== undefined &&
				text
					.split("\n")
					.slice(0, -1)
					.some((line) => line.startsWith(completionMarker))
			)
				complete?.();
		}
	}
	const output = read(stdoutReader);
	const error = read(stderrReader);
	let timedOut = false;
	let completed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stdout: string | undefined;
	let primaryFailure: unknown;
	try {
		const outcome = await Promise.race([
			completion,
			Promise.all([exited, output, error]).then(([code, stdout, stderr]) => ({
				code,
				stdout,
				stderr,
			})),
			new Promise<{ timedOut: true }>((resolve) => {
				timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
			}),
		]);
		if ("timedOut" in outcome) {
			timedOut = true;
			throw new Error(`Vite probe exceeded ${timeoutMs}ms`);
		}
		if ("completed" in outcome) {
			completed = true;
		} else {
			if (outcome.code !== 0)
				throw new Error(`Vite probe exited ${outcome.code}: ${outcome.stderr}`);
			stdout = outcome.stdout;
		}
	} catch (cause) {
		primaryFailure = cause;
	}
	if (timer !== undefined) clearTimeout(timer);
	// The shader probe publishes its result only after verifying HTTP responses
	// and closing Vite. Checker workers can still keep Node's exit pending;
	// after that explicit completion record, reap the owned process group.
	// All other probes must exit successfully themselves.
	let treeFailure: unknown;
	try {
		if (process.platform === "win32") {
			if (
				pid !== undefined &&
				child.exitCode === null &&
				child.signalCode === null
			) {
				const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
					stdio: "ignore",
					timeout: 2_000,
					killSignal: "SIGKILL",
				});
				if ((await once(killer, "exit"))[0] !== 0)
					throw new Error("Could not reap Vite probe process tree");
			}
		} else if (completed || timedOut || child.exitCode === null) {
			try {
				if (pid !== undefined) process.kill(-pid, "SIGKILL");
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
			}
		}
	} catch (cause) {
		treeFailure = cause;
	}
	let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
	let cleanupFailure: unknown;
	try {
		await Promise.race([
			Promise.all([exited, output, error]),
			new Promise<never>((_, reject) => {
				cleanupTimer = setTimeout(() => {
					// Windows cannot safely taskkill a reused PID after the leader
					// exited. Stop waiting on inherited pipes and report the failure.
					void stdoutReader.cancel().catch(() => {});
					void stderrReader.cancel().catch(() => {});
					reject(new Error("Vite probe cleanup exceeded 2000ms"));
				}, 2_000);
			}),
		]);
	} catch (cause) {
		cleanupFailure = cause;
	} finally {
		if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
	}
	if (cleanupFailure !== undefined) throw cleanupFailure;
	if (treeFailure !== undefined) throw treeFailure;
	if (timedOut)
		throw new Error(
			`Vite probe exceeded ${timeoutMs}ms\n${await output}\n${await error}`,
		);
	if (primaryFailure !== undefined) throw primaryFailure;
	if (completed) stdout = await output;
	if (stdout === undefined)
		throw new Error("Vite probe completed without stdout");
	return stdout;
}
