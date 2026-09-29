import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { build } from "vite";
import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import inventory from "../product/direct-dependencies.json";
import { forgeaxImports } from "../scripts/check-direct-dependencies";
import {
	serializeWorkflow,
	webWorkflow,
} from "../scripts/generate-dependency-web-ci";
import { IDE_RUNTIME_DEDUPE } from "../scripts/vite-runtime-contract";
import {
	assertRevision,
	dependencyInputsFromParameters,
	dependencyOrder,
	isIntegratedRevision,
	lintWorkspaceCandidates,
	packCandidate,
	validateDependencyInputs,
	verifyInstalledCandidates,
	withOverrides,
} from "../scripts/web-dependency-inputs";

const sha = "a".repeat(40);
const primary = { repository: "ForgeaX-Games/forgeax-chat", revision: sha };
const inputs = {
	schemaVersion: 1 as const,
	ide: { repository: "ForgeaX-Games/forgeax-ide", revision: sha },
	companions: [],
};

test("joint inputs reject moving refs, duplicate repositories and arbitrary checkouts", () => {
	expect(validateDependencyInputs(inputs, primary)).toEqual(inputs);
	for (const revision of [
		"main",
		"HEAD",
		"abc123",
		"../other",
		"A".repeat(40),
	]) {
		expect(() =>
			validateDependencyInputs(
				{ ...inputs, ide: { ...inputs.ide, revision } },
				primary,
			),
		).toThrow();
	}
	expect(() =>
		validateDependencyInputs({ ...inputs, companions: [primary] }, primary),
	).toThrow("Duplicate");
	expect(() =>
		validateDependencyInputs(
			{
				...inputs,
				companions: [{ repository: "OtherOrg/repo", revision: sha }],
			},
			primary,
		),
	).toThrow("Unsupported");
	expect(() =>
		validateDependencyInputs(
			{
				...inputs,
				companions: [
					{
						repository: "ForgeaX-Games/forgeax-types",
						revision: sha,
						pullRequest: -1,
					},
				],
			},
			primary,
		),
	).toThrow("pull request");
});

test("dependency inputs use the resolved IDE checkout and optional startup companions", () => {
	expect(
		dependencyInputsFromParameters(primary, { BLUEKING_IDE_REVISION: sha }),
	).toEqual(inputs);
	const companion = {
		repository: "ForgeaX-Games/forgeax-types",
		revision: sha,
		pullRequest: 3,
	};
	expect(
		dependencyInputsFromParameters(primary, {
			BLUEKING_IDE_REVISION: sha,
			IDE_WEB_COMPANIONS: JSON.stringify([companion]),
		}).companions,
	).toEqual([companion]);
	expect(() =>
		dependencyInputsFromParameters(primary, {
			BLUEKING_IDE_REVISION: sha,
			IDE_WEB_COMPANIONS: "invalid",
		}),
	).toThrow("JSON array");
	expect(() =>
		dependencyInputsFromParameters(primary, {
			BLUEKING_IDE_REVISION: sha,
			IDE_WEB_COMPANIONS: "{}",
		}),
	).toThrow();
	expect(() =>
		dependencyInputsFromParameters(primary, {
			BLUEKING_IDE_REVISION: sha,
			IDE_WEB_COMPANIONS: JSON.stringify([primary]),
		}),
	).toThrow("Duplicate");
	expect(() => dependencyInputsFromParameters(primary, {})).toThrow(
		"immutable",
	);
});

test("dependency discovery reads real static, type and dynamic imports, excluding comments and text", () => {
	expect(
		forgeaxImports(
			"source.ts",
			`
    // import { x } from '@forgeax/comment';
    const example = "import { x } from '@forgeax/example'";
    import type { T } from '@forgeax/types/artifact-summary';
    export { x } from '@forgeax/app-shell/application';
    const dynamic = import('@forgeax/chat/runtime');
    type Imported = import('@forgeax/types/page').Page;
  `,
		),
	).toEqual([
		"@forgeax/app-shell/application",
		"@forgeax/chat/runtime",
		"@forgeax/types/artifact-summary",
		"@forgeax/types/page",
	]);
});

test("npm candidates build dependencies first and reject cycles", () => {
	const items = [{ name: "shell" }, { name: "types" }];
	expect(
		dependencyOrder(items, (item) => (item.name === "shell" ? ["types"] : [])),
	).toEqual([items[1]!, items[0]!]);
	expect(() =>
		dependencyOrder(items, (item) =>
			item.name === "shell" ? ["types"] : ["shell"],
		),
	).toThrow("Cyclic");
});

test("workspace candidate lint runs only supported PR sources and propagates failures", () => {
	const candidates = [
		{
			name: "@forgeax/chat",
			repository: "ForgeaX-Games/forgeax-chat",
			revision: sha,
			path: "/chat",
			mode: "workspace",
			primary: true,
		},
		{
			name: "@forgeax/dashboard",
			repository: "ForgeaX-Games/forgeax-dashboard",
			revision: sha,
			path: "/dashboard",
			mode: "workspace",
			primary: false,
		},
		{
			name: "@forgeax/interface",
			repository: "ForgeaX-Games/forgeax-interface",
			revision: sha,
			path: "/interface",
			mode: "workspace",
			primary: false,
		},
		{
			name: "@forgeax/settings",
			repository: "ForgeaX-Games/forgeax-settings",
			revision: sha,
			path: "/settings",
			mode: "workspace",
			primary: false,
		},
		{
			name: "@forgeax/editor",
			repository: "ForgeaX-Games/forgeax-editor",
			revision: sha,
			path: "/editor",
			mode: "workspace",
			primary: false,
		},
		{
			name: "@forgeax/app-shell",
			repository: "ForgeaX-Games/forgeax-app-shell",
			revision: sha,
			path: "/shell",
			mode: "npm",
			primary: false,
		},
	];
	const executed: string[] = [];
	lintWorkspaceCandidates(candidates, (candidate) =>
		executed.push(candidate.repository),
	);
	expect(executed).toEqual([
		"ForgeaX-Games/forgeax-chat",
		"ForgeaX-Games/forgeax-dashboard",
		"ForgeaX-Games/forgeax-interface",
		"ForgeaX-Games/forgeax-settings",
	]);
	expect(() =>
		lintWorkspaceCandidates(candidates, () => {
			throw new Error("candidate lint failed");
		}),
	).toThrow("candidate lint failed");
});

test("one shared pipeline covers IDE and every external dependency without path filters", () => {
	const repositories = new Set(
		Object.values(inventory.packages).map((value) => value.repository),
	);
	expect(repositories.size).toBe(11);
	const workflow = webWorkflow();
	const serialized = serializeWorkflow(workflow);
	expect(parseYaml(serialized)).toEqual(workflow);
	expect(serialized).toContain("run: |");
	const triggers = workflow.on.filter((item: any) => item.mr);
	expect(new Set(triggers.map((item: any) => item["repo-name"]))).toEqual(
		repositories,
	);
	expect(triggers).toHaveLength(repositories.size);
	for (const trigger of triggers) {
		expect(trigger.mr.action).toEqual(["open", "reopen", "push-update"]);
		expect(trigger.mr["target-branches"]).toEqual(["main"]);
		expect(trigger.mr.paths).toBeUndefined();
	}
	expect(workflow.on.filter((item: any) => item.manual)).toEqual([
		{ manual: "enabled" },
	]);
	expect(workflow.variables.DEPENDENCY_REPOSITORY.value).toBe(
		"ForgeaX-Games/forgeax-ide",
	);
	expect(workflow.variables.IDE_SOURCE_SHA.value).toBe("");
	expect(workflow.variables.DEPENDENCY_SOURCE_SHA.value).toBe("");
	expect(workflow.variables.IDE_WEB_COMPANIONS.value).toBe("[]");
	const steps = workflow.stages[0].jobs.source_preflight.steps;
	expect(
		steps
			.filter((step: any) => step.name.startsWith("拉取 npm 候选 "))
			.map((step: any) => step.name)
			.sort(),
	).toEqual(
		Object.entries(inventory.packages)
			.filter(([, entry]) => entry.mode === "npm")
			.map(([name]) => `拉取 npm 候选 ${name}`)
			.sort(),
	);
	const script = steps.find(
		(step: any) => step.name === "固定版本并准备 Web",
	).run;
	expect(script).toContain("BK_REPO_GIT_WEBHOOK_MR_SOURCE_COMMIT");
	expect(script).toContain("BK_CI_HOOK_TARGET_REPO_NAME");
	expect(script).not.toContain("BK_CI_GIT_REPO_NAME");
	expect(script).toContain('BLUEKING_IDE_REVISION="$ide_revision"');
	expect(script).not.toContain("ide-web-inputs.json");
	expect(script).not.toContain("ide-web-source");
	expect(script).toContain(".ci/web.sh");
});

function run(path: string, args: string[], command = "bun"): string {
	const result = spawnSync(command, args, { cwd: path, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout.trim();
}

test("workspace lint sees original source manifests and propagates genuine failures", () => {
	const root = mkdtempSync(join(tmpdir(), "ide-workspace-lint-"));
	try {
		mkdirSync(join(root, "dependency"));
		writeFileSync(
			join(root, "dependency/package.json"),
			JSON.stringify({ name: "lint-dependency", version: "1.0.0" }),
		);
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify(
				{
					name: "lint-fixture",
					scripts: { lint: "bun lint.ts" },
					dependencies: { "lint-dependency": "file:./dependency" },
				},
				null,
				"\t",
			) + "\n",
		);
		run(root, ["install", "--ignore-scripts"]);
		const manifest = readFileSync(join(root, "package.json"), "utf8");
		const lock = readFileSync(join(root, "bun.lock"), "utf8");
		writeFileSync(
			join(root, "lint.ts"),
			[
				"import { readFileSync } from 'node:fs';",
				"import { strictEqual } from 'node:assert';",
				`strictEqual(readFileSync('package.json', 'utf8'), ${JSON.stringify(manifest)}, 'lint must inspect the source manifest');`,
				`strictEqual(readFileSync('bun.lock', 'utf8'), ${JSON.stringify(lock)}, 'lint must inspect the source lockfile');`,
			].join("\n"),
		);
		const candidate = {
			name: "lint-fixture",
			repository: "ForgeaX-Games/forgeax-interface",
			revision: sha,
			path: root,
			mode: "workspace",
			primary: true,
		};
		const modulePath = new URL(
			"../scripts/web-dependency-inputs.ts",
			import.meta.url,
		).href;
		const lint = () =>
			run(root, [
				"-e",
				`import { lintWorkspaceCandidateAgainstPackedGraph } from ${JSON.stringify(modulePath)}; lintWorkspaceCandidateAgainstPackedGraph(${JSON.stringify(candidate)}, []);`,
			]);
		expect(lint).not.toThrow();
		writeFileSync(
			join(root, "lint.ts"),
			"throw new Error('genuine source lint failure');",
		);
		expect(lint).toThrow("genuine source lint failure");
		expect(readFileSync(join(root, "package.json"), "utf8")).toBe(manifest);
		expect(readFileSync(join(root, "bun.lock"), "utf8")).toBe(lock);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a same-version PR tarball replaces the installed package and a broken export fails a real Web bundle", async () => {
	const root = mkdtempSync(join(tmpdir(), "ide-candidate-"));
	const source = join(root, "source");
	const consumer = join(root, "consumer");
	const artifacts = join(root, "artifacts");
	try {
		for (const path of [source, consumer, artifacts]) mkdirSync(path);
		writeFileSync(
			join(source, "package.json"),
			JSON.stringify({
				name: "@forgeax/app-shell",
				version: "1.0.0",
				type: "module",
				packageManager:
					"bun@" +
					execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(),
				exports: { "./application": { import: "./dist/application.js" } },
				files: ["dist"],
				scripts: { build: "bun build.ts" },
			}),
		);
		writeFileSync(
			join(source, "build.ts"),
			"import {mkdirSync,copyFileSync} from 'node:fs'; mkdirSync('dist',{recursive:true}); copyFileSync('source.js','dist/application.js');",
		);
		writeFileSync(
			join(source, "source.js"),
			"export const answer = 'candidate';",
		);
		run(source, ["install", "--ignore-scripts"]);
		run(source, ["init", "-q"], "git");
		run(source, ["add", "."], "git");
		run(
			source,
			[
				"-c",
				"user.name=CI Fixture",
				"-c",
				"user.email=ci@example.invalid",
				"commit",
				"-qm",
				"candidate",
			],
			"git",
		);
		const revision = run(source, ["rev-parse", "HEAD"], "git");
		const candidate = {
			name: "@forgeax/app-shell",
			repository: "ForgeaX-Games/forgeax-app-shell",
			revision,
			path: source,
			mode: "npm",
			primary: true,
		};
		expect(() =>
			assertRevision(source, { ...candidate, revision: sha }),
		).toThrow("differs");
		const packed = packCandidate(candidate, artifacts, {});
		const old = join(consumer, "node_modules/@forgeax/app-shell");
		mkdirSync(old, { recursive: true });
		writeFileSync(
			join(old, "package.json"),
			JSON.stringify({ name: candidate.name, version: "1.0.0" }),
		);
		expect(() => verifyInstalledCandidates(consumer, [packed])).toThrow(
			"registry/stale",
		);
		writeFileSync(
			join(consumer, "package.json"),
			JSON.stringify({
				name: "consumer",
				dependencies: { [candidate.name]: packed.tarball },
			}),
		);
		run(consumer, ["install", "--ignore-scripts"]);
		verifyInstalledCandidates(consumer, [packed]);
		const installedEntry = join(
			consumer,
			"node_modules",
			candidate.name,
			"dist/application.js",
		);
		const candidateBytes = readFileSync(installedEntry);
		writeFileSync(
			installedEntry,
			"export const answer = 'stale same-SHA build';",
		);
		expect(() => verifyInstalledCandidates(consumer, [packed])).toThrow(
			"payload differs",
		);
		writeFileSync(installedEntry, candidateBytes);
		verifyInstalledCandidates(consumer, [packed]);
		const manifestBefore = readFileSync(join(consumer, "package.json"), "utf8");
		const lockBefore = readFileSync(join(consumer, "bun.lock"), "utf8");
		expect(() =>
			withOverrides(consumer, { [candidate.name]: packed.tarball }, () => {
				throw new Error("build failed");
			}),
		).toThrow("build failed");
		expect(readFileSync(join(consumer, "package.json"), "utf8")).toBe(
			manifestBefore,
		);
		expect(readFileSync(join(consumer, "bun.lock"), "utf8")).toBe(lockBefore);
		const entry = join(consumer, "entry.ts");
		writeFileSync(
			entry,
			"export { answer } from '@forgeax/app-shell/application';",
		);
		const bundle = () =>
			build({
				root: consumer,
				configFile: false,
				logLevel: "silent",
				resolve: { dedupe: [...IDE_RUNTIME_DEDUPE] },
				build: {
					write: false,
					minify: false,
					lib: { entry, formats: ["iife"], name: "Fixture" },
				},
			});
		const output: any = await bundle();
		const chunk = (Array.isArray(output) ? output : [output])
			.flatMap((entry: any) => entry.output)
			.find((entry: any) => entry.type === "chunk");
		expect(runInNewContext(chunk.code + "\nFixture").answer).toBe("candidate");
		writeFileSync(
			entry,
			"export { removedPublicApi } from '@forgeax/app-shell/application';",
		);
		await expect(bundle()).rejects.toThrow("removedPublicApi");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30000);

test("required gate refuses an unmerged companion and detects a moving PR using real git refs", () => {
	const root = mkdtempSync(join(tmpdir(), "ide-joint-refs-"));
	try {
		run(root, ["init", "-qb", "main"], "git");
		writeFileSync(join(root, "value.txt"), "base");
		run(root, ["add", "."], "git");
		const commit = () =>
			run(
				root,
				[
					"-c",
					"user.name=CI Fixture",
					"-c",
					"user.email=ci@example.invalid",
					"commit",
					"-qam",
					"change",
				],
				"git",
			);
		commit();
		run(root, ["checkout", "-qb", "feature"], "git");
		writeFileSync(join(root, "value.txt"), "candidate");
		commit();
		const revision = run(root, ["rev-parse", "HEAD"], "git");
		run(root, ["update-ref", "refs/pull/1/head", revision], "git");
		const ref = {
			repository: "ForgeaX-Games/forgeax-chat",
			revision,
			pullRequest: 1,
		};
		expect(isIntegratedRevision(root, ref, root)).toBe(false);
		run(root, ["update-ref", "refs/heads/main", revision], "git");
		expect(isIntegratedRevision(root, ref, root)).toBe(true);
		run(root, ["update-ref", "refs/pull/1/head", revision + "^"], "git");
		expect(() => isIntegratedRevision(root, ref, root)).toThrow("moved");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
