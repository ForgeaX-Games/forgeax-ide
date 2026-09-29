import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	desktopEngineViteConfigBundleArgs,
	desktopRuntimeControllerBundleArgs,
} from "../../scripts/desktop-engine-vite-config";

test("packaged controller retains host dependencies and module-relative assets without source checkout", () => {
	const root = mkdtempSync(join(tmpdir(), "desktop-controller-"));
	const source = join(root, "editor");
	const staged = join(root, "resources/engine");
	const run = (args: string[]) => {
		const result = spawnSync(process.execPath, args, {
			encoding: "utf8",
			cwd: args[0] === "build" ? dirname(args[1]!) : root,
		});
		expect(result.stderr).not.toContain("error:");
		if (result.status !== 0)
			throw new Error(`${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
		return result.stdout.trim();
	};
	try {
		mkdirSync(join(source, "scripts/host"), { recursive: true });
		mkdirSync(join(source, "packages/play/src"), { recursive: true });
		mkdirSync(join(staged, "src"), { recursive: true });
		writeFileSync(
			join(source, "scripts/host/validation.ts"),
			`import { readFileSync } from 'node:fs'; export const readAsset = () => readFileSync(new URL('../asset.txt', import.meta.url), 'utf8');`,
		);
		const controller = join(
			source,
			"packages/play/src/runtime-scope-controller.ts",
		);
		writeFileSync(
			controller,
			`export { readAsset } from '../../../scripts/host/validation';`,
		);
		run(
			desktopRuntimeControllerBundleArgs(
				controller,
				join(staged, "src/runtime-scope-controller.mjs"),
			),
		);
		writeFileSync(join(staged, "asset.txt"), "packaged-asset");
		writeFileSync(
			join(staged, "vite.config.ts"),
			`export { readAsset } from './src/runtime-scope-controller.mjs';`,
		);
		run(
			desktopEngineViteConfigBundleArgs(
				join(staged, "vite.config.ts"),
				join(staged, "vite.config.mjs"),
			),
		);
		rmSync(source, { recursive: true, force: true });
		writeFileSync(
			join(staged, "verify.mjs"),
			`import { readAsset } from './vite.config.mjs'; console.log(readAsset());`,
		);
		expect(run([join(staged, "verify.mjs")])).toBe("packaged-asset");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
