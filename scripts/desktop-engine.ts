import { existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function startDesktopServices<T>(actions: {
	startEngine: () => Promise<T>;
	waitForEngine: () => Promise<void>;
	startServer: () => Promise<T>;
}) {
	const engine = await actions.startEngine();
	await actions.waitForEngine();
	// Server boot restores the active game by sending Engine HTTP requests.
	// Keep that recovery loop away from Vite's temporary TCP port checks.
	const server = await actions.startServer();
	return { engine, server };
}

export async function probeDesktopEngine(url: string, readyFile: string) {
	// Vite binds temporary raw TCP listeners while checking its port. Sending
	// HTTP to one leaves unread data and can block its server.close callback.
	// Only probe HTTP after Vite's own listen promise has completed.
	if (!existsSync(readyFile))
		return {
			ready: false,
			url,
			error: "Engine listener initialization is pending",
		};
	try {
		const response = await fetch(url, {
			redirect: "manual",
			signal: AbortSignal.timeout(1_000),
		});
		await response.body?.cancel();
		return {
			ready: response.status >= 200 && response.status < 400,
			url,
			status: response.status,
		};
	} catch (error) {
		return {
			ready: false,
			url,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function startDesktopEngine(
	engineRoot: string,
	readyFile: string,
) {
	console.info("[desktop-engine] loading Vite");
	const { createServer } = await import(
		pathToFileURL(
			createRequire(join(engineRoot, "package.json")).resolve("vite"),
		).href
	);
	console.info("[desktop-engine] creating server");
	const server = await createServer({
		root: engineRoot,
		configLoader: "native",
	});
	console.info("[desktop-engine] initializing listener");
	await server.listen();
	writeFileSync(readyFile, "listening\n");
	console.info("[desktop-engine] listener ready");
	server.printUrls();
	return server;
}

if (import.meta.main) {
	const readyFile = process.argv[2];
	if (!readyFile) throw new Error("Engine listener readiness file is required");
	await startDesktopEngine(process.cwd(), readyFile);
}
