import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const ideRoot = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(ideRoot, path), "utf8");

test("embedded WebDriver stays opt-in, hidden, and out of release configuration", () => {
	const packageJson = JSON.parse(read("package.json"));
	const productionConfig = JSON.parse(read("src-tauri/tauri.conf.json"));
	const webdriverConfig = JSON.parse(
		read("src-tauri/tauri.webdriver.conf.json"),
	);
	const cargoToml = read("src-tauri/Cargo.toml");
	const rustShell = read("src-tauri/src/lib.rs");

	expect(packageJson.scripts["dev:desktop:webdriver"]).toContain(
		"--features embedded-webdriver",
	);
	expect(packageJson.scripts["dev:desktop:webdriver"]).toContain(
		"tauri.webdriver.conf.json",
	);
	expect(webdriverConfig.app.windows[0].visible).toBe(false);
	expect(webdriverConfig.app.security.capabilities).toContain(
		"main-capability",
	);
	expect(webdriverConfig.app.security.capabilities).toContain(
		"remote-webview-capability",
	);
	expect(webdriverConfig.app.security.capabilities).toContainEqual({
		identifier: "embedded-webdriver-test-capability",
		windows: ["main"],
		permissions: ["wdio-webdriver:default"],
	});
	expect(JSON.stringify(productionConfig)).not.toContain("wdio-webdriver");
	expect(cargoToml).toContain(
		'embedded-webdriver = ["dep:tauri-plugin-wdio-webdriver"]',
	);
	expect(cargoToml).toMatch(
		/tauri-plugin-wdio-webdriver = \{[^\n]*optional = true/,
	);
	expect(rustShell).toContain(
		'compile_error!("embedded-webdriver is test-only and must not be built in release mode")',
	);
});
