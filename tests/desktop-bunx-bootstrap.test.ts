import { execFileSync, spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, test } from "vitest";

test("the native desktop Bun bootstrap exposes bunx in a sanitized PATH", async () => {
	const bootstrap = await readFile(
		new URL("../.ci/desktop-env.sh", import.meta.url),
		"utf8",
	);
	expect(bootstrap).toContain(
		'desktop_bunx_binary="$desktop_native_tools/node_modules/@oven/$desktop_bun_package/bin/bunx"',
	);
	expect(bootstrap).toContain('ln -sf bun "$desktop_bunx_binary"');
	expect(bootstrap).toContain(
		'cp -f "$desktop_bun_binary" "$desktop_bunx_binary"',
	);
	const directory = mkdtempSync(join(tmpdir(), "forgeax-ide-bunx-"));
	const bin = join(directory, "bin");
	const extension = process.platform === "win32" ? ".exe" : "";
	const bun = join(bin, `bun${extension}`);
	const bunx = join(bin, `bunx${extension}`);
	try {
		mkdirSync(bin);
		if (process.platform === "win32") {
			copyFileSync(
				execFileSync("bun", ["-p", "process.execPath"], {
					encoding: "utf8",
				}).trim(),
				bun,
			);
			copyFileSync(bun, bunx);
		} else {
			symlinkSync(
				execFileSync("bun", ["-p", "process.execPath"], {
					encoding: "utf8",
				}).trim(),
				bun,
			);
			symlinkSync("bun", bunx);
		}
		const result = spawnSync(bunx, ["--version"], {
			encoding: "utf8",
			env: { PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin` },
		});
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe(
			execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(),
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
