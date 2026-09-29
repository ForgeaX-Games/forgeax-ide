#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { chromium } from "playwright-core";

const ideRoot = resolve(import.meta.dirname, "..");
const port = Number(process.env.IDE_PRODUCTION_SMOKE_PORT ?? "19899");
const baseUrl = `http://127.0.0.1:${port}/`;
const distRoot = join(ideRoot, "src-tauri/resources/interface/dist");
const unavailableMessage =
	"@forgeax/engine-wgpu-wasm is unavailable in the source-integrated IDE bundle";

function walkFiles(directory) {
	return readdirSync(directory).flatMap((name) => {
		const path = join(directory, name);
		return statSync(path).isDirectory() ? walkFiles(path) : [path];
	});
}

function assertDesktopWgpuBundle() {
	const files = walkFiles(distRoot);
	const scripts = files.filter((path) => path.endsWith(".js"));
	const unavailableChunk = scripts.find((path) =>
		readFileSync(path, "utf8").includes(unavailableMessage),
	);
	if (unavailableChunk) {
		throw new Error(
			`IDE_DESKTOP_WGPU_UNAVAILABLE_SHIM_PRESENT: ${unavailableChunk}`,
		);
	}
	const wasm = files.find((path) => /wgpu_wasm_bg-[^/\\]+\.wasm$/.test(path));
	if (!wasm || statSync(wasm).size < 1_000_000) {
		throw new Error("IDE_DESKTOP_WGPU_WASM_MISSING");
	}
	const wasmName = wasm.split(sep).at(-1);
	const module = scripts.find((path) => {
		const source = readFileSync(path, "utf8");
		return source.includes(wasmName) && source.includes("ensureReady");
	});
	if (!module) throw new Error("IDE_DESKTOP_WGPU_MODULE_MISSING");
	return `/${relative(distRoot, module).split(sep).join("/")}`;
}

function browserExecutable() {
	const candidates = (
		process.platform === "win32"
			? [
					process.env.IDE_BROWSER_EXECUTABLE,
					join(
						process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
						"Microsoft",
						"Edge",
						"Application",
						"msedge.exe",
					),
					join(
						process.env.ProgramFiles ?? "C:\\Program Files",
						"Microsoft",
						"Edge",
						"Application",
						"msedge.exe",
					),
					join(
						process.env.ProgramFiles ?? "C:\\Program Files",
						"Google",
						"Chrome",
						"Application",
						"chrome.exe",
					),
					join(
						process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
						"Google",
						"Chrome",
						"Application",
						"chrome.exe",
					),
				]
			: [
					process.env.IDE_BROWSER_EXECUTABLE,
					"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
				]
	).filter(Boolean);
	const executable = candidates.find(existsSync);
	if (!executable)
		throw new Error(
			"IDE_BROWSER_EXECUTABLE must point to a Chromium-compatible browser",
		);
	return executable;
}

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
	throw new Error("IDE_PRODUCTION_SMOKE_PORT must be a valid TCP port");
}

const desktopWgpuModulePath = assertDesktopWgpuBundle();

const contentTypes = {
	".html": "text/html",
	".js": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".wasm": "application/wasm",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
};
const indexPath = resolve(distRoot, "index.html");
const server = createServer(async (request, response) => {
	try {
		const pathname = decodeURIComponent(
			new URL(request.url ?? "/", baseUrl).pathname,
		);
		const candidate = resolve(distRoot, `.${pathname}`);
		if (candidate !== distRoot && !candidate.startsWith(`${distRoot}${sep}`)) {
			response.writeHead(403).end();
			return;
		}
		const path = pathname === "/" || !extname(pathname) ? indexPath : candidate;
		const bytes = await readFile(path);
		response.writeHead(200, {
			"Content-Type": contentTypes[extname(path)] ?? "application/octet-stream",
		});
		response.end(bytes);
	} catch {
		response.writeHead(404).end();
	}
});
await new Promise((resolveListen, reject) => {
	server.once("error", reject);
	server.listen(port, "127.0.0.1", resolveListen);
});

let browser;
try {
	const executablePath = browserExecutable();
	console.log(
		JSON.stringify({ code: "IDE_PRODUCTION_BUNDLE_BROWSER", executablePath }),
	);
	browser = await chromium.launch({
		executablePath,
		headless: true,
		timeout: 30_000,
	});
	const page = await browser.newPage({
		viewport: { width: 1440, height: 900 },
	});
	const pageErrors = [];
	const consoleErrors = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	// The production shell intentionally keeps project EventSource streams open.
	// Readiness is the mounted root, not a network-idle state that cannot settle.
	await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
	await page
		.locator("#root > *")
		.first()
		.waitFor({ state: "visible", timeout: 30_000 });
	await page.evaluate(async (modulePath) => {
		const module = await import(modulePath);
		if (typeof module.ensureReady !== "function")
			throw new Error("desktop WGPU module does not export ensureReady");
		const wasm = await module.ensureReady();
		if (typeof wasm.RhiWgpuInstance?.create !== "function") {
			throw new Error("desktop WGPU module did not initialize its RHI surface");
		}
	}, desktopWgpuModulePath);
	console.log(
		JSON.stringify({
			code: "IDE_DESKTOP_WGPU_SMOKE_OK",
			modulePath: desktopWgpuModulePath,
		}),
	);
	const visibleText = (await page.locator("#root").innerText()).trim();
	if (!visibleText) throw new Error("production bundle mounted an empty root");
	if (pageErrors.length > 0)
		throw new Error(`production bundle page errors:\n${pageErrors.join("\n")}`);
	console.log(
		JSON.stringify({
			code: "IDE_PRODUCTION_BUNDLE_SMOKE_OK",
			rootMounted: true,
			consoleErrorCount: consoleErrors.length,
		}),
	);
} finally {
	try {
		await browser?.close();
	} finally {
		await new Promise((resolveClose, reject) => {
			server.close((error) => (error ? reject(error) : resolveClose()));
			server.closeAllConnections();
		});
		console.log(JSON.stringify({ code: "IDE_PRODUCTION_BUNDLE_CLEANUP_OK" }));
	}
}
