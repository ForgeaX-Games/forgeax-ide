import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "vitest";
import {
	probeDesktopEngine,
	startDesktopEngine,
	startDesktopServices,
} from "../../scripts/desktop-engine";

test("server startup recovery cannot issue requests before the Engine listener is ready", async () => {
	let releaseEngine!: () => void;
	const ready = new Promise<void>((resolve) => {
		releaseEngine = resolve;
	});
	const started: string[] = [];
	const startup = startDesktopServices({
		startEngine: async () => {
			started.push("engine");
			return "engine-child";
		},
		waitForEngine: () => ready,
		startServer: async () => {
			started.push("server");
			return "server-child";
		},
	});
	try {
		await sleep(0);
		expect(started).toEqual(["engine"]);
	} finally {
		releaseEngine();
	}
	expect(await startup).toEqual({
		engine: "engine-child",
		server: "server-child",
	});
	expect(started).toEqual(["engine", "server"]);
});

test("failed Engine readiness prevents starting the server recovery loop", async () => {
	let serverStarts = 0;
	await expect(
		startDesktopServices({
			startEngine: async () => "engine",
			waitForEngine: async () => {
				throw new Error("Engine startup deadline exceeded");
			},
			startServer: async () => {
				serverStarts += 1;
				return "server";
			},
		}),
	).rejects.toThrow("Engine startup deadline exceeded");
	expect(serverStarts).toBe(0);
});

test("HTTP readiness never connects to the temporary port reservation before Engine listen completes", async () => {
	const directory = mkdtempSync(join(tmpdir(), "desktop-engine-startup-"));
	const readyFile = join(directory, "listening");
	let connections = 0;
	const sockets = new Set<import("node:net").Socket>();
	const server = createServer((socket) => {
		connections += 1;
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		// Vite temporarily binds a raw TCP server before starting HTTP. It does
		// not consume requests; server.close waits if a readiness probe connects.
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as import("node:net").AddressInfo).port;
	try {
		expect(
			(await probeDesktopEngine(`http://127.0.0.1:${port}/`, readyFile)).ready,
		).toBe(false);
		expect(connections).toBe(0);
		await new Promise<void>((resolve) => server.close(() => resolve()));
		const http = createHttpServer((_request, response) => {
			response.writeHead(302, { Location: "/preview/" });
			response.end();
		});
		await new Promise<void>((resolve, reject) => {
			http.once("error", reject);
			http.listen(port, "127.0.0.1", resolve);
		});
		try {
			writeFileSync(readyFile, "listening\n");
			expect(
				await probeDesktopEngine(`http://127.0.0.1:${port}/`, readyFile),
			).toMatchObject({ ready: true, status: 302 });
		} finally {
			await new Promise<void>((resolve, reject) => {
				http.close((error) => (error ? reject(error) : resolve()));
				http.closeAllConnections();
			});
		}
	} finally {
		for (const socket of sockets) socket.destroy();
		server.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("packaged Engine starter publishes readiness only after the actual Vite listener is serving", async () => {
	const directory = mkdtempSync(join(tmpdir(), "desktop-engine-vite-"));
	const readyFile = join(directory, "listening");
	mkdirSync(join(directory, "node_modules"));
	symlinkSync(
		join(import.meta.dirname, "../../node_modules/vite"),
		join(directory, "node_modules/vite"),
		"junction",
	);
	writeFileSync(join(directory, "package.json"), '{"type":"module"}');
	writeFileSync(join(directory, "index.html"), "<html>ready</html>");
	// Exercise native Vite loading without requiring Node's optional TS loader.
	writeFileSync(
		join(directory, "vite.config.mjs"),
		'export default { server: { host: "127.0.0.1", port: 0 }, logLevel: "silent" };',
	);
	try {
		expect(existsSync(readyFile)).toBe(false);
		const server = await startDesktopEngine(directory, readyFile);
		try {
			expect(existsSync(readyFile)).toBe(true);
			const address = server.httpServer.address();
			expect(
				(
					await probeDesktopEngine(
						`http://127.0.0.1:${address.port}/`,
						readyFile,
					)
				).ready,
			).toBe(true);
		} finally {
			await server.close();
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
