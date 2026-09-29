import { afterEach, expect, test } from "bun:test";
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
import { lintWorkspaceCandidateAgainstPackedGraph } from "./web-dependency-inputs";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

test("workspace lint reinstalls its declared dependency before type checking", () => {
	const root = mkdtempSync(join(tmpdir(), "ide-web-lint-graph-"));
	roots.push(root);
	const dependency = join(root, "dependency");
	const workspace = join(root, "workspace");
	mkdirSync(dependency);
	mkdirSync(workspace);
	writeFileSync(
		join(dependency, "package.json"),
		JSON.stringify({
			name: "@forgeax/app-shell",
			version: "0.104.0",
			type: "module",
			exports: { "./application": "./application.js" },
		}),
	);
	writeFileSync(
		join(dependency, "application.js"),
		"export const answer = 'candidate';\n",
	);
	const original = JSON.stringify({
		name: "@forgeax/interface",
		version: "0.9.5",
		type: "module",
		dependencies: { "@forgeax/app-shell": `file:${dependency}` },
		scripts: {
			lint: "bun -e \"import { answer } from '@forgeax/app-shell/application'; if (answer !== 'candidate') process.exit(1)\"",
		},
	});
	writeFileSync(join(workspace, "package.json"), original);
	const stale = join(workspace, "node_modules/@forgeax/app-shell");
	mkdirSync(stale, { recursive: true });
	writeFileSync(
		join(stale, "application.js"),
		"export const answer = 'stale';\n",
	);
	writeFileSync(
		join(stale, "package.json"),
		JSON.stringify({
			name: "@forgeax/app-shell",
			version: "0.103.0",
			type: "module",
			exports: { "./application": "./application.js" },
		}),
	);
	lintWorkspaceCandidateAgainstPackedGraph(
		{
			name: "@forgeax/interface",
			repository: "ForgeaX-Games/forgeax-interface",
			revision: "a".repeat(40),
			path: workspace,
			mode: "workspace",
			primary: true,
		},
		[],
	);
	expect(readFileSync(join(workspace, "package.json"), "utf8")).toBe(original);
	expect(readFileSync(join(stale, "application.js"), "utf8")).toContain(
		"candidate",
	);
	expect(existsSync(join(workspace, "bun.lock"))).toBe(false);
});
