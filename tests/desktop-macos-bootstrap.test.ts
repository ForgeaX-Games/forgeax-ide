import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";

for (const scenario of [
	"ready",
	"intel",
	"old-os",
	"xcode-incomplete",
] as const) {
	test(`Mac bootstrap validates ${scenario} before downloads or source mutation`, () => {
		const root = mkdtempSync(join(tmpdir(), "ide-mac-bootstrap-"));
		const ide = join(root, "studio/packages/ide");
		const bin = join(root, "bin");
		const log = join(root, "commands");
		const write = (name: string, value: string) => {
			const path = join(root, name);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, value);
			chmodSync(path, 0o755);
		};
		try {
			write(
				"studio/packages/ide/.ci/materialize-toolchain-inputs.sh",
				'#!/bin/bash\necho materialize >> "$BOOTSTRAP_TEST_LOG"\nexit 77\n',
			);
			copyFileSync(
				new URL("../.ci/desktop-env.sh", import.meta.url),
				join(ide, ".ci/desktop-env.sh"),
			);
			write(
				"bin/uname",
				`#!/bin/bash\nif [ "$1" = -s ]; then echo Darwin; else echo ${scenario === "intel" ? "x86_64" : "arm64"}; fi\n`,
			);
			write(
				"bin/sw_vers",
				`#!/bin/bash\necho ${scenario === "old-os" ? "12.7" : "15.6"}\n`,
			);
			for (const command of [
				"python3",
				"git",
				"xcrun",
				"xcodebuild",
				"node",
				"curl",
			]) {
				const exit =
					command === "xcodebuild" && scenario === "xcode-incomplete"
						? 'if [ "$1" = -checkFirstLaunchStatus ]; then exit 1; fi\n'
						: "";
				write(
					`bin/${command}`,
					`#!/bin/bash\necho '${command}' "$@" >> "$BOOTSTRAP_TEST_LOG"\n${exit}`,
				);
			}
			const result = spawnSync(
				"/bin/bash",
				[
					"-c",
					'source "$1" bootstrap',
					"test",
					join(ide, ".ci/desktop-env.sh"),
				],
				{
					encoding: "utf8",
					env: {
						...process.env,
						PATH: `${bin}:/usr/bin:/bin`,
						BOOTSTRAP_TEST_LOG: log,
					},
				},
			);
			const commands = readFileSync(log, "utf8");
			expect(result.status).toBe(scenario === "ready" ? 77 : 1);
			expect(commands.includes("materialize")).toBe(scenario === "ready");
			expect(commands).not.toContain("node");
			expect(commands).not.toContain("curl");
			if (scenario === "ready")
				expect(commands).toContain("xcodebuild -checkFirstLaunchStatus");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
