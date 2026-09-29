import { type ChildProcess, spawn } from "node:child_process";

const grandchild: ChildProcess = spawn(
	"/bin/sh",
	["-c", 'trap "" TERM; printf "READY\\n"; while :; do sleep 1; done'],
	{
		stdio: ["ignore", "pipe", "ignore"],
	},
);
const grandchildStdout = grandchild.stdout;
if (!grandchildStdout) throw new Error("grandchild stdout pipe is unavailable");

await new Promise<void>((resolve, reject) => {
	const onData = (chunk: Buffer): void => {
		if (!chunk.toString().includes("READY\n")) return;
		grandchildStdout.off("data", onData);
		grandchild.off("exit", onExit);
		resolve();
	};
	const onExit = (): void => {
		grandchildStdout.off("data", onData);
		reject(new Error("grandchild exited before becoming signal-ready"));
	};
	grandchildStdout.on("data", onData);
	grandchild.once("exit", onExit);
});

// The parent treats this line as permission to signal the process group. Arm
// the handler first so a fast parent cannot terminate us between the write and
// listener registration.
process.once("SIGTERM", () => process.exit(0));
process.stdout.write(
	`${JSON.stringify({
		code: "desktop-posix-process-group-pids",
		leaderPid: process.pid,
		grandchildPid: grandchild.pid,
	})}\n`,
);

await new Promise<void>(() => {});
