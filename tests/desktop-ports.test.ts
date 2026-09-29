import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, test } from "vitest";
import {
	DESKTOP_ENGINE_BASE_PORT,
	DESKTOP_GUARD_BASE_PORT,
	DESKTOP_MAX_PORT_OFFSET,
	DESKTOP_SERVER_BASE_PORT,
	desktopPortsForOffset,
	isDesktopPortBindConflict,
	reserveDesktopPorts,
} from "../scripts/desktop-ports";

const occupied: Server[] = [];

function occupy(port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		occupied.push(server);
		(
			server as Server & {
				once(event: "error", listener: (error: Error) => void): void;
			}
		).once("error", reject);
		server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
	});
}

async function closeServer(server: Server): Promise<void> {
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function reserveAfterProcessExit(attempts = 50) {
	let lastError: unknown;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			return await reserveDesktopPorts("0");
		} catch (error) {
			lastError = error;
			await sleep(Math.min(2 ** attempt, 50));
		}
	}
	throw lastError;
}

afterEach(async () => {
	await Promise.all(occupied.splice(0).map(closeServer));
});

describe("desktop port offsets", () => {
	test("derives the server, engine, and guard ports from one offset", () => {
		expect(desktopPortsForOffset(7)).toEqual({
			offset: 7,
			server: DESKTOP_SERVER_BASE_PORT + 7,
			engine: DESKTOP_ENGINE_BASE_PORT + 7,
			guard: DESKTOP_GUARD_BASE_PORT + 7,
		});
	});

	test("scans the next offset when any paired port is occupied", async () => {
		for (const portName of ["guard", "server", "engine"] as const) {
			await occupy(desktopPortsForOffset(0)[portName]);
			const lease = await reserveDesktopPorts();
			try {
				expect(lease.offset).toBeGreaterThan(0);
				expect(lease.server).toBe(DESKTOP_SERVER_BASE_PORT + lease.offset);
				expect(lease.engine).toBe(DESKTOP_ENGINE_BASE_PORT + lease.offset);
				expect(lease.guard).toBe(DESKTOP_GUARD_BASE_PORT + lease.offset);
			} finally {
				await lease.release();
				await closeServer(occupied.pop()!);
			}
		}
	});

	test("honors an explicit offset only when all three ports are available", async () => {
		for (const portName of ["guard", "server", "engine"] as const) {
			await occupy(desktopPortsForOffset(9)[portName]);
			await expect(reserveDesktopPorts("9")).rejects.toThrow(
				"no desktop server/engine/guard port set is available for offset 9",
			);
			await closeServer(occupied.pop()!);
		}
	});

	test("rejects invalid offsets before attempting to bind", async () => {
		await expect(
			reserveDesktopPorts(String(DESKTOP_MAX_PORT_OFFSET + 1)),
		).rejects.toThrow(
			`must be an integer between 0 and ${DESKTOP_MAX_PORT_OFFSET}`,
		);
		await expect(reserveDesktopPorts("auto")).rejects.toThrow(
			"must be an integer",
		);
	});

	test("keeps the guard after service reservations are released", async () => {
		const first = await reserveDesktopPorts("0");
		await first.releaseReservations();
		await expect(reserveDesktopPorts("0")).rejects.toThrow(
			"no desktop server/engine/guard port set is available for offset 0",
		);

		await first.release();
		const second = await reserveDesktopPorts("0");
		await second.release();
		await second.release();
	});

	test("classifies only EADDRINUSE as a scan continuation", () => {
		expect(isDesktopPortBindConflict({ code: "EADDRINUSE" })).toBe(true);
		for (const code of ["EMFILE", "ENFILE", "EACCES", "EPERM", "UNKNOWN"]) {
			expect(isDesktopPortBindConflict({ code })).toBe(false);
		}
	});

	test("lets the OS reclaim a guard held by a terminated launcher", async () => {
		const modulePath = join(import.meta.dirname, "../scripts/desktop-ports.ts");
		const child = spawn(
			process.execPath,
			[
				"--experimental-strip-types",
				"-e",
				`
        const { reserveDesktopPorts } = await import(${JSON.stringify(modulePath)});
        await reserveDesktopPorts('0');
        console.log('READY');
        setInterval(() => {}, 1_000);
      `,
			],
			{
				cwd: join(import.meta.dirname, ".."),
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const childExited = once(child, "exit").then(
			([code]) => code as number | null,
		);

		try {
			const reader = (
				Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
			).getReader();
			const decoder = new TextDecoder();
			let output = "";
			const deadline = Date.now() + 5_000;
			while (!output.includes("READY") && Date.now() < deadline) {
				const { done, value } = await reader.read();
				if (done) break;
				output += decoder.decode(value, { stream: true });
			}
			reader.releaseLock();
			expect(output).toContain("READY");
			await expect(reserveDesktopPorts("0")).rejects.toThrow();

			child.kill("SIGKILL");
			await childExited;
			const lease = await reserveAfterProcessExit();
			await lease.release();
		} finally {
			if (child.exitCode === null) {
				child.kill("SIGKILL");
				await childExited;
			}
		}
	});
});
