#!/usr/bin/env bun

import { writeSync } from "node:fs";

const mode = process.argv[2];

if (mode === "env") {
	process.stdout.write(`${process.env.FORGEAX_FIXTURE ?? ""}\n`);
	process.exit(0);
} else if (mode === "transparent") {
	process.on("SIGTERM", () => process.exit(0));
	const reader = Bun.stdin.stream().getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		writeSync(1, value);
	}
	setInterval(() => {}, 1_000);
} else if (mode === "close-stdin") {
	process.stdin.destroy();
	process.stdout.write("READY\n");
	setInterval(() => {}, 1_000);
} else if (mode === "descendant" || mode === "exit-with-descendant") {
	const descendant = Bun.spawn(
		[process.execPath, "-e", "setInterval(() => {}, 1000)"],
		{
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		},
	);
	process.stdout.write(`READY ${descendant.pid}\n`);
	if (mode === "exit-with-descendant") setTimeout(() => process.exit(0), 25);
	else setInterval(() => {}, 1_000);
} else if (mode === "ignore-term-exit") {
	const descendant = Bun.spawn(
		[process.execPath, "-e", "setInterval(() => {}, 1000)"],
		{
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		},
	);
	process.on("SIGTERM", () => {});
	process.stdout.write(`READY ${descendant.pid}\n`);
	setTimeout(() => process.exit(23), 10);
} else {
	throw new Error(`unknown runtime guardian fixture mode: ${mode}`);
}
