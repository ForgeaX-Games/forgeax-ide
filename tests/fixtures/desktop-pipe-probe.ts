import { closeSync } from "node:fs";
import { writeDesktopPipe } from "../../scripts/desktop-pipe";

const blocked = process.argv[2] === "blocked";
const payload = Buffer.alloc(blocked ? 1024 * 1024 : 512 * 1024, 97);
const child = Bun.spawn(
	[
		"python3",
		"-c",
		blocked
			? "import time; time.sleep(30)"
			: 'import os,time; time.sleep(.1); data=b""\nwhile True:\n chunk=os.read(3,8192)\n if not chunk: break\n data+=chunk\nprint(len(data),sum(data))',
	],
	{ stdio: ["ignore", "pipe", "pipe", "pipe"] },
);
const fd = child.stdio[3] as number;
try {
	let error: string | undefined;
	try {
		await writeDesktopPipe(fd, payload, blocked ? 50 : 10_000);
	} catch (cause) {
		error = cause instanceof Error ? cause.message : String(cause);
	} finally {
		closeSync(fd);
	}
	if (blocked) child.kill();
	const code = await child.exited;
	const output = (await new Response(child.stdout).text()).trim();
	console.log(JSON.stringify({ code, output, error }));
} finally {
	if (child.exitCode === null) {
		child.kill();
		await child.exited;
	}
}
