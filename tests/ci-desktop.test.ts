import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "vitest";
import {
	desktopCiMacosApp,
	desktopCiStages,
	desktopCiTarget,
	installDesktopCiBrowser,
	runDesktopCi,
} from "../scripts/ci-desktop";

const manifest = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
test("public CI commands share one runner and obsolete entry is removed", () => {
	expect(manifest.scripts["ci:desktop"]).toBe("bun run scripts/ci-desktop.ts");
	for (const stage of desktopCiStages)
		expect(manifest.scripts[`ci:desktop:${stage}`]).toBe(
			`bun run scripts/ci-desktop.ts ${stage}`,
		);
	expect(existsSync(new URL("../.ci/desktop.ts", import.meta.url))).toBe(false);
	expect(existsSync(new URL("../.ci/run-desktop.ts", import.meta.url))).toBe(
		false,
	);
});

test("verification installs the browser selected by the final workspace, even when a bootstrap browser exists", async () => {
	const root = mkdtempSync(join(tmpdir(), "ide-final-browser-"));
	try {
		const pkg = join(root, "node_modules/playwright-core");
		mkdirSync(pkg, { recursive: true });
		const oldBrowser = join(root, "chromium-bootstrap");
		const selectedBrowser = join(root, "chromium-final");
		writeFileSync(oldBrowser, "old browser");
		writeFileSync(
			join(pkg, "package.json"),
			JSON.stringify({
				name: "playwright-core",
				type: "module",
				exports: { ".": "./index.js", "./package.json": "./package.json" },
			}),
		);
		writeFileSync(
			join(pkg, "index.js"),
			`export const chromium = { executablePath: () => ${JSON.stringify(selectedBrowser)} };`,
		);
		writeFileSync(
			join(pkg, "cli.js"),
			`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(selectedBrowser)}, 'final browser');`,
		);
		expect(
			await installDesktopCiBrowser(root, (cli) => {
				const result = spawnSync(process.execPath, [
					cli,
					"install",
					"chromium",
				]);
				if (result.status !== 0) throw new Error("browser installation failed");
			}),
		).toBe(selectedBrowser);
		expect(readFileSync(selectedBrowser, "utf8")).toBe("final browser");
		rmSync(selectedBrowser);
		await expect(installDesktopCiBrowser(root, () => {})).rejects.toThrow(
			"did not produce the selected browser",
		);
		await expect(
			installDesktopCiBrowser(root, () => {
				throw new Error("download failed");
			}),
		).rejects.toThrow("download failed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
test("CI waits for prepare, install, build and verify before archiving", async () => {
	const completed: string[] = [];
	await runDesktopCi(async (stage) => {
		await sleep(1);
		completed.push(stage);
	});
	expect(completed).toEqual([
		"prepare",
		"install",
		"build",
		"verify",
		"archive",
	]);
});
for (const failure of desktopCiStages) {
	test(`CI preserves ${failure} failure and never runs later stages`, async () => {
		const visited: string[] = [];
		const error = new Error(failure);
		await expect(
			runDesktopCi(async (stage) => {
				visited.push(stage);
				if (stage === failure) throw error;
			}),
		).rejects.toBe(error);
		expect(visited).toEqual(
			desktopCiStages.slice(0, desktopCiStages.indexOf(failure) + 1),
		);
	});
}
test("platform selection requires native Linux deb or Apple Silicon dmg", () => {
	expect(desktopCiTarget("linux", "x64")).toMatchObject({
		platform: "linux-x64",
		triple: "x86_64-unknown-linux-gnu",
		bundles: "deb",
	});
	expect(desktopCiTarget("darwin", "arm64", "macos-arm64")).toMatchObject({
		platform: "macos-arm64",
		triple: "aarch64-apple-darwin",
		bundles: "dmg",
	});
	expect(() => desktopCiTarget("darwin", "x64")).toThrow("not enabled");
	expect(() => desktopCiTarget("darwin", "x64", "macos-arm64")).toThrow(
		"requires a native build host",
	);
	expect(() => desktopCiTarget("linux", "x64", "macos-arm64")).toThrow(
		"requires a native build host",
	);
	expect(() => desktopCiTarget("win32", "x64")).toThrow("not enabled");
	expect(() => desktopCiTarget("linux", "arm64")).toThrow("unsupported");
});

test("Mac verification refuses missing or ambiguous app bundles", () => {
	const root = mkdtempSync(join(tmpdir(), "ide-macos-bundle-"));
	const triple = "aarch64-apple-darwin";
	const directory = join(
		root,
		"src-tauri/target",
		triple,
		"release/bundle/macos",
	);
	try {
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, "stray.app"), "not an app directory");
		expect(() => desktopCiMacosApp(root, triple)).toThrow("exactly one");
		const app = join(directory, "ForgeaX Studio.app");
		mkdirSync(app);
		expect(desktopCiMacosApp(root, triple)).toBe(app);
		mkdirSync(join(directory, "Old.app"));
		expect(() => desktopCiMacosApp(root, triple)).toThrow("exactly one");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
