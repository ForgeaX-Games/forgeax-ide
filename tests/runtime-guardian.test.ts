import {
	type ChildProcessWithoutNullStreams,
	execFileSync,
	spawn,
} from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, test, vi } from "vitest";

const root = join(import.meta.dirname, "..");
const fixture = join(
	import.meta.dirname,
	"fixtures/runtime-guardian-target.ts",
);
const guardian =
	process.env.FORGEAX_RUNTIME_GUARDIAN_BIN?.trim() ||
	join(root, "src-tauri/target/debug/runtime-guardian");

const bunExecutable = execFileSync("bun", ["-p", "process.execPath"], {
	encoding: "utf8",
}).trim();
type GuardianProcess = ChildProcessWithoutNullStreams;
function ownerStdin(child: GuardianProcess) {
	return child.stdin;
}

function spawnGuardian(mode: string, graceMs = 150): GuardianProcess {
	if (process.platform === "win32")
		throw new Error("runtime guardian integration tests are POSIX-only");
	if (!existsSync(guardian))
		throw new Error(`runtime guardian binary is missing: ${guardian}`);
	return spawn(
		guardian,
		["--grace-ms", String(graceMs), "--", bunExecutable, "run", fixture, mode],
		{
			stdio: "pipe",
		},
	) as GuardianProcess;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function readLine(stream: Readable): Promise<string> {
	return (await readUntil(stream, "\n")).split("\n")[0]!;
}

async function readUntil(stream: Readable, expected: string): Promise<string> {
	let output = "";
	for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
		output += chunk.toString();
		if (output.includes(expected)) return output;
	}
	throw new Error(
		`fixture closed before output ${JSON.stringify(expected)} (received=${JSON.stringify(output)})`,
	);
}

async function waitForGone(pid: number): Promise<void> {
	await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), {
		timeout: 2_000,
		interval: 25,
	});
}

const guardianAvailable = process.platform !== "win32" && existsSync(guardian);

describe.skipIf(!guardianAvailable)("POSIX runtime guardian", () => {
	test("releases the internal barrier and transparently forwards stdin/stdout", async () => {
		const child = spawnGuardian("transparent");
		const exited = once(child, "exit").then(([code]) => code as number | null);
		ownerStdin(child).write("guardian-transparent-✓");
		expect(await readUntil(child.stdout, "guardian-transparent-✓")).toContain(
			"guardian-transparent-✓",
		);
		ownerStdin(child).end();
		const code = await exited;
		const stderr = await text(child.stderr);
		expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
	});

	test("owner stdin EOF closes target and its background descendant", async () => {
		const child = spawnGuardian("descendant");
		const exited = once(child, "exit").then(([code]) => code as number | null);
		const line = await readLine(child.stdout);
		const descendantPid = Number(line.split(" ")[1]);
		expect(Number.isInteger(descendantPid)).toBe(true);
		ownerStdin(child).end();
		await exited;
		await waitForGone(descendantPid);
	});

	test("target leader exit kills a remaining background descendant before reap", async () => {
		const child = spawnGuardian("exit-with-descendant");
		const exited = once(child, "exit").then(([code]) => code as number | null);
		const line = await readLine(child.stdout);
		const descendantPid = Number(line.split(" ")[1]);
		expect(Number.isInteger(descendantPid)).toBe(true);
		await exited;
		await waitForGone(descendantPid);
	});

	test("rechecks an EPERM race and preserves a naturally exiting target status", async () => {
		const child = spawnGuardian("ignore-term-exit", 0);
		const exited = once(child, "exit").then(([code]) => code as number | null);
		const line = await readLine(child.stdout);
		const descendantPid = Number(line.split(" ")[1]);
		expect(Number.isInteger(descendantPid)).toBe(true);
		ownerStdin(child).end();
		expect(await exited).toBe(23);
		await waitForGone(descendantPid);
	});

	test("SIGTERM closes the target group through the guardian", async () => {
		const child = spawnGuardian("descendant");
		const exited = once(child, "exit").then(([code]) => code as number | null);
		const line = await readLine(child.stdout);
		const descendantPid = Number(line.split(" ")[1]);
		child.kill("SIGTERM");
		await exited;
		await waitForGone(descendantPid);
	});

	test("target stdin EPIPE does not masquerade as owner EOF", async () => {
		const child = spawnGuardian("close-stdin");
		const exited = once(child, "exit").then(([code]) => code as number | null);
		expect(await readLine(child.stdout)).toBe("READY");
		ownerStdin(child).write("owner-is-still-alive");
		await sleep(100);
		const stderr = child.exitCode === null ? "" : await text(child.stderr);
		expect({ exitCode: child.exitCode, stderr }).toEqual({
			exitCode: null,
			stderr: "",
		});
		ownerStdin(child).end();
		await exited;
	});

	test("passes an explicit bounded target environment through the inherited fd", async () => {
		const directory = mkdtempSync(join(tmpdir(), "runtime-guardian-env-"));
		const envPath = join(directory, "target-env.json");
		writeFileSync(
			envPath,
			JSON.stringify({
				PATH: "/usr/bin:/bin",
				FORGEAX_FIXTURE: "target-env-ok",
			}),
		);
		const command = [
			"exec 3<",
			shellQuote(envPath),
			"; exec ",
			shellQuote(guardian),
			" --grace-ms 150 --target-env-fd 3 -- ",
			shellQuote(bunExecutable),
			" run ",
			shellQuote(fixture),
			" env",
		].join("");
		const child = spawn("/bin/sh", ["-c", command], {
			stdio: "pipe",
		}) as GuardianProcess;
		const exited = once(child, "exit").then(([code]) => code as number | null);
		const output = await readLine(child.stdout);
		ownerStdin(child).end();
		const code = await exited;
		expect(output).toBe("target-env-ok");
		expect(code).toBe(0);
		rmSync(directory, { recursive: true, force: true });
	});

	test("resolves a target without a slash using the target PATH", async () => {
		const directory = mkdtempSync(join(tmpdir(), "runtime-guardian-path-"));
		const envPath = join(directory, "target-env.json");
		writeFileSync(
			envPath,
			JSON.stringify({
				PATH: "/usr/bin:/bin",
				FORGEAX_FIXTURE: "path-resolved",
			}),
		);
		const command = [
			"exec 3<",
			shellQuote(envPath),
			"; exec ",
			shellQuote(guardian),
			" --grace-ms 150 --target-env-fd 3 -- printenv FORGEAX_FIXTURE",
		].join("");
		const child = spawn("/bin/sh", ["-c", command], {
			stdio: "pipe",
		}) as GuardianProcess;
		const exited = once(child, "exit").then(([code]) => code as number | null);
		const output = await readLine(child.stdout);
		ownerStdin(child).end();
		const code = await exited;
		expect(output).toBe("path-resolved");
		expect(code).toBe(0);
		rmSync(directory, { recursive: true, force: true });
	});

	test("rejects invalid target environment before forking the target", async () => {
		const directory = mkdtempSync(
			join(tmpdir(), "runtime-guardian-invalid-env-"),
		);
		const envPath = join(directory, "target-env.json");
		const markerPath = join(directory, "target-started");
		writeFileSync(envPath, '{"PATH":');
		const target = `printf started > ${shellQuote(markerPath)}`;
		const command = [
			"exec 3<",
			shellQuote(envPath),
			"; exec ",
			shellQuote(guardian),
			" --grace-ms 150 --target-env-fd 3 -- /bin/sh -c ",
			shellQuote(target),
		].join("");
		const child = spawn("/bin/sh", ["-c", command], {
			stdio: "pipe",
		}) as GuardianProcess;
		const exited = once(child, "exit").then(([code]) => code as number | null);
		const [code, stderr] = await Promise.all([exited, text(child.stderr)]);
		expect(code).toBe(64);
		expect(stderr).toContain("target environment");
		expect(existsSync(markerPath)).toBe(false);
		rmSync(directory, { recursive: true, force: true });
	});
});
