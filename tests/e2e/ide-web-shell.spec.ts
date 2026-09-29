import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { text } from "node:stream/consumers";
import { chromium } from "playwright-core";
import { expect, test, vi } from "vitest";

const ideRoot = resolve(import.meta.dirname, "../..");

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((done, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", done);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing test server port");
	await new Promise<void>((done, reject) =>
		server.close((error) => (error ? reject(error) : done())),
	);
	return address.port;
}

test("opens the product shell with unavailable services and survives a fresh page reload", async ({
	onTestFinished,
}) => {
	const executablePath =
		process.env.IDE_BROWSER_EXECUTABLE ?? chromium.executablePath();
	if (!existsSync(executablePath)) {
		throw new Error(
			"E2E requires Chromium. Run `bun x playwright-core install chromium` or set IDE_BROWSER_EXECUTABLE to a browser executable.",
		);
	}
	const browser = await chromium.launch({ executablePath, headless: true });
	onTestFinished(() => browser.close());
	// Keep this browser test independent of any developer server and game data.
	const backend = createHttpServer((_request, response) => {
		response.writeHead(503, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: "Test service unavailable" }));
	});
	await new Promise<void>((done, reject) => {
		backend.once("error", reject);
		backend.listen(0, "127.0.0.1", done);
	});
	onTestFinished(
		() =>
			new Promise<void>((done, reject) => {
				backend.close((error) => (error ? reject(error) : done()));
				backend.closeAllConnections();
			}),
	);
	const backendAddress = backend.address();
	if (!backendAddress || typeof backendAddress === "string")
		throw new Error("Missing backend port");
	const port = await freePort();
	const baseUrl = `http://127.0.0.1:${port}/`;
	const artifacts = resolve(ideRoot, "test-results/web-shell");
	mkdirSync(artifacts, { recursive: true });
	const server = spawn(
		process.execPath,
		[
			resolve(ideRoot, "node_modules/vite/bin/vite.js"),
			"--configLoader",
			"runner",
			"--host",
			"127.0.0.1",
			"--port",
			String(port),
			"--strictPort",
		],
		{
			cwd: ideRoot,
			env: {
				...process.env,
				FORGEAX_INTEGRATION_ROOT: resolve(ideRoot, "../.."),
				FORGEAX_SERVER_PORT: String(backendAddress.port),
				FORGEAX_ENGINE_PORT: String(backendAddress.port),
			},
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		},
	);
	const exited = once(server, "exit");
	const stdout = text(server.stdout!);
	const stderr = text(server.stderr!);
	onTestFinished(async () => {
		if (process.platform === "win32") {
			if (server.exitCode === null && server.signalCode === null) {
				const killer = spawn(
					"taskkill",
					["/PID", String(server.pid), "/T", "/F"],
					{
						stdio: "ignore",
						timeout: 5_000,
					},
				);
				if ((await once(killer, "exit"))[0] !== 0)
					throw new Error("E2E server tree cleanup failed");
			}
		} else {
			try {
				server.pid !== undefined && process.kill(-server.pid, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		}
		await exited;
		writeFileSync(
			resolve(artifacts, "server.log"),
			`${await stdout}\n${await stderr}`,
		);
	});
	const page = await browser.newPage({
		viewport: { width: 1440, height: 900 },
	});
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	let passed = false;
	onTestFinished(async () => {
		writeFileSync(
			resolve(artifacts, "result.json"),
			JSON.stringify({ passed, pageErrors: errors }, null, 2),
		);
		await page.screenshot({
			path: resolve(artifacts, "page.png"),
			timeout: 5_000,
		});
	});
	await vi.waitUntil(
		async () => {
			if (server.exitCode !== null || server.signalCode !== null)
				throw new Error(
					`IDE server exited ${server.exitCode ?? server.signalCode}: ${await stderr}`,
				);
			try {
				const response = await fetch(baseUrl, {
					signal: AbortSignal.timeout(1_000),
				});
				await response.body?.cancel();
				return response.ok;
			} catch {
				return false;
			}
		},
		{ timeout: 30_000, interval: 100 },
	);
	await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
	const shell = page.locator(".studio-shell");
	await shell.waitFor({ state: "visible", timeout: 60_000 });
	expect((await shell.innerText()).trim()).not.toBe("");
	expect(await page.locator(".studio-main-dock").count()).toBe(1);
	await page.reload({ waitUntil: "domcontentloaded" });
	await shell.waitFor({ state: "visible", timeout: 30_000 });
	expect(await page.locator(".studio-main-dock").count()).toBe(1);
	expect(errors).toEqual([]);
	passed = true;
});
