import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleDesktopOrchestratorKits } from "../../scripts/bundle-desktop-orchestrator-kits";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
test("bundled kit keeps loader entry paths and runs without its source tree", async () => {
	const root = mkdtempSync(join(tmpdir(), "desktop-kits-"));
	roots.push(root);
	const source = join(root, "source");
	const output = join(root, "output");
	mkdirSync(join(source, "workspace/tools"), { recursive: true });
	writeFileSync(join(source, "shared.ts"), "export const value = 42;");
	writeFileSync(
		join(source, "workspace/condition.ts"),
		"export { value as default } from '../shared';",
	);
	writeFileSync(
		join(source, "workspace/tools/read_file.ts"),
		"export { value as default } from '../../shared';",
	);
	await bundleDesktopOrchestratorKits(source, output);
	rmSync(source, { recursive: true });
	expect((await import(join(output, "workspace/condition.ts"))).default).toBe(
		42,
	);
	expect(
		(await import(join(output, "workspace/tools/read_file.ts"))).default,
	).toBe(42);
});
