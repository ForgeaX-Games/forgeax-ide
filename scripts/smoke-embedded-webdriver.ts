#!/usr/bin/env bun

import { remote } from "webdriverio";

const port = Number(process.env.TAURI_WEBDRIVER_PORT ?? "4445");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
	throw new Error("TAURI_WEBDRIVER_PORT must be a valid TCP port");
}

const address = `http://127.0.0.1:${port}`;
try {
	const response = await fetch(`${address}/status`, {
		signal: AbortSignal.timeout(3_000),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
} catch (error) {
	throw new Error(
		`Embedded WebDriver is unavailable at ${address}. Start "bun run dev:desktop:webdriver" in another terminal first.`,
		{ cause: error },
	);
}

const browser = await remote({
	hostname: "127.0.0.1",
	port,
	logLevel: "warn",
	capabilities: {},
});

try {
	await browser.waitUntil(
		async () =>
			browser.execute(() => {
				const root = document.getElementById("root");
				return (
					document.readyState === "complete" &&
					Boolean(root?.firstElementChild) &&
					"__TAURI_INTERNALS__" in window
				);
			}),
		{
			timeout: 30_000,
			interval: 500,
			timeoutMsg:
				"The hidden Tauri WebView did not render its root within 30 seconds",
		},
	);
	console.info("Embedded WebDriver reached the hidden ForgeaX Studio WebView");
} finally {
	await browser.deleteSession();
}
