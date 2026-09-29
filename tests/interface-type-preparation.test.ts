import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { scripts } from "../package.json";

for (const exitCode of [0, 7]) {
	test(`Interface type preparation executes its producer and propagates exit ${exitCode}`, () => {
		const root = mkdtempSync(join(tmpdir(), "ide-interface-types-"));
		try {
			const ide = join(root, "ide");
			const producer = join(root, "interface");
			mkdirSync(ide);
			mkdirSync(producer);
			writeFileSync(
				join(ide, "package.json"),
				JSON.stringify({
					scripts: {
						"prepare:interface-types": scripts["prepare:interface-types"],
						"prepare:app-shell": "bun -e 'process.exit(0)'",
					},
				}),
			);
			writeFileSync(
				join(producer, "package.json"),
				JSON.stringify({
					scripts: {
						"build:package": "bun build.ts",
					},
				}),
			);
			writeFileSync(
				join(producer, "build.ts"),
				`import { writeFileSync } from "node:fs"; writeFileSync('producer-ran', 'yes'); process.exit(${exitCode});`,
			);
			const result = spawnSync("bun", ["run", "prepare:interface-types"], {
				cwd: ide,
				encoding: "utf8",
			});
			expect(existsSync(join(producer, "producer-ran"))).toBe(true);
			expect(result.status).toBe(exitCode);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}
