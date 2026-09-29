export {};

const grandchild = Bun.spawn(
	[process.execPath, "-e", "setInterval(() => {}, 1_000)"],
	{
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		windowsHide: true,
	},
);

process.stdout.write(
	`${JSON.stringify({
		code: "desktop-windows-job-pids",
		childPid: process.pid,
		grandchildPid: grandchild.pid,
	})}\n`,
);
await grandchild.exited;
