import { join } from "node:path";
import { initializeWindowsJobObject } from "../../scripts/desktop-windows-job";

await initializeWindowsJobObject();
const child = Bun.spawn(
	[
		process.execPath,
		"run",
		join(import.meta.dirname, "desktop-windows-job-child.ts"),
	],
	{
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	},
);

async function readProtocolLine(
	stream: ReadableStream<Uint8Array>,
	timeoutMs: number,
): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	let timer: ReturnType<typeof setTimeout> | undefined;
	const readLine = async (): Promise<string> => {
		while (true) {
			const result = await reader.read();
			if (result.done)
				throw new Error("child exited before sending PID protocol");
			buffered += decoder.decode(result.value, { stream: true });
			const newline = buffered.indexOf("\n");
			if (newline >= 0) return buffered.slice(0, newline);
		}
	};
	try {
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error("timed out waiting for child PID protocol")),
				timeoutMs,
			);
		});
		return await Promise.race([readLine(), timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		await reader.cancel();
		reader.releaseLock();
	}
}

async function readStderr(): Promise<string> {
	const reader = child.stderr!.getReader();
	const decoder = new TextDecoder();
	let output = "";
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) return output;
			output += decoder.decode(result.value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
}

try {
	const line = await readProtocolLine(child.stdout!, 5_000);
	const message = JSON.parse(line) as {
		code?: unknown;
		childPid?: unknown;
		grandchildPid?: unknown;
	};
	if (message.code !== "desktop-windows-job-pids")
		throw new Error("child sent an unknown PID protocol code");
	if (
		!Number.isSafeInteger(message.childPid) ||
		!Number.isSafeInteger(message.grandchildPid)
	) {
		throw new Error("child sent invalid PIDs");
	}
	process.stdout.write(`${JSON.stringify(message)}\n`);
} catch (error) {
	const stderr = await Promise.race([
		readStderr(),
		Bun.sleep(1_000).then(() => ""),
	]);
	console.error(
		`[desktop-windows-job-launcher] failed: ${error instanceof Error ? error.message : String(error)}; child stderr: ${stderr.trim() || "(empty)"}`,
	);
	child.kill("SIGKILL");
	await child.exited;
	process.exitCode = 1;
}

await child.exited;
