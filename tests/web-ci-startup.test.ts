import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import {
	generateWebCi,
	webWorkflow,
} from "../scripts/generate-dependency-web-ci";

function git(root: string, ...args: string[]): string {
	const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}

test("one workflow routes each PR by hook repository and defaults the IDE to current main", () => {
	const root = mkdtempSync(join(tmpdir(), "ide-web-startup-"));
	const studio = join(root, "forgeax-studio");
	const ide = join(studio, "packages/ide");
	try {
		mkdirSync(join(ide, ".ci"), { recursive: true });
		writeFileSync(
			join(ide, ".ci/web.sh"),
			[
				"set -eu",
				"node -e 'console.log(JSON.stringify({phase:process.env.BLUEKING_WEB_PHASE,ide:process.env.IDE_SOURCE_SHA,resolved:process.env.BLUEKING_IDE_REVISION,dependency:process.env.BLUEKING_DEPENDENCY_REVISION,repository:process.env.BLUEKING_DEPENDENCY_REPOSITORY}))'",
			].join("\n") + "\n",
		);
		git(ide, "init", "-qb", "main");
		git(ide, "remote", "add", "origin", ide);
		const commit = () => {
			git(ide, "add", ".");
			git(
				ide,
				"-c",
				"user.name=CI Fixture",
				"-c",
				"user.email=ci@example.invalid",
				"commit",
				"-qm",
				"fixture",
			);
			return git(ide, "rev-parse", "HEAD");
		};
		const baseline = commit();
		git(ide, "checkout", "-qb", "feature");
		writeFileSync(join(ide, "candidate.txt"), "candidate");
		const candidate = commit();
		const workflow = webWorkflow();
		function start(params: NodeJS.ProcessEnv = {}) {
			const script = workflow.stages[0].jobs.source_preflight.steps.find(
				(step: any) => step.name === "固定版本并准备 Web",
			).run;
			const result = spawnSync("bash", ["-c", script], {
				cwd: root,
				encoding: "utf8",
				env: {
					...process.env,
					BK_CI_HOOK_TARGET_REPO_NAME: "",
					BK_REPO_GIT_WEBHOOK_MR_SOURCE_COMMIT: "",
					IDE_SOURCE_SHA: "",
					DEPENDENCY_REPOSITORY: "",
					DEPENDENCY_SOURCE_SHA: "",
					BLUEKING_DEPENDENCY_REPOSITORY: "",
					BLUEKING_DEPENDENCY_REVISION: "",
					...params,
				},
			});
			if (result.status !== 0) throw new Error(result.stderr);
			const prepared = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
			expect(prepared.phase).toBe("prepare");
			const persisted = Object.fromEntries(
				[
					...result.stdout.matchAll(/^::set-variable name=([^:]+)::(.*)$/gm),
				].map((match) => [match[1], match[2]]),
			);
			const buildStep = workflow.stages[0].jobs.source_preflight.steps.find(
				(step: any) => step.name === "测试并构建 Web",
			);
			// BlueKing stores set-variable output in the variables context; its
			// RunScript plugin does not export those names into later shells.
			const boundEnvironment = Object.fromEntries(
				Object.entries(buildStep.env ?? {}).map(([name, expression]) => {
					const variable = /^\$\{\{ variables\.([A-Z_]+) \}\}$/.exec(
						String(expression),
					)?.[1];
					if (!variable)
						throw new Error(`Unexpected CI binding: ${expression}`);
					return [name, persisted[variable] ?? params[variable] ?? ""];
				}),
			);
			const built = spawnSync("bash", ["-c", buildStep.run], {
				cwd: root,
				encoding: "utf8",
				env: {
					...process.env,
					IDE_SOURCE_SHA: "",
					DEPENDENCY_REPOSITORY: "",
					DEPENDENCY_SOURCE_SHA: "",
					...boundEnvironment,
				},
			});
			if (built.status !== 0) throw new Error(built.stderr);
			const receipt = JSON.parse(built.stdout.trim().split("\n").at(-1)!);
			expect(receipt).toEqual({ ...prepared, phase: "build" });
			expect(git(ide, "rev-parse", "HEAD")).toBe(receipt.ide);
			expect(receipt.resolved).toBe(receipt.ide);
			return receipt;
		}
		const dependencySha = "b".repeat(40);
		const repository = "ForgeaX-Games/forgeax-chat";
		for (const trigger of workflow.on.filter(
			(item: any) =>
				item.mr && item["repo-name"] !== "ForgeaX-Games/forgeax-ide",
		)) {
			expect(
				start({
					BK_CI_HOOK_TARGET_REPO_NAME: trigger["repo-name"],
					BK_REPO_GIT_WEBHOOK_MR_SOURCE_COMMIT: dependencySha,
					BK_CI_GIT_REPO_NAME: "ForgeaX-Games/forgeax-ide",
					DEPENDENCY_REPOSITORY: "ignored/manual-value",
					DEPENDENCY_SOURCE_SHA: candidate,
				}),
			).toMatchObject({
				ide: baseline,
				dependency: dependencySha,
				repository: trigger["repo-name"],
			});
		}
		expect(
			start({
				DEPENDENCY_REPOSITORY: repository,
				DEPENDENCY_SOURCE_SHA: dependencySha,
				IDE_SOURCE_SHA: candidate,
			}),
		).toMatchObject({
			ide: candidate,
			dependency: dependencySha,
			repository,
		});
		git(ide, "update-ref", "refs/heads/main", candidate);
		expect(
			start({
				DEPENDENCY_REPOSITORY: repository,
				DEPENDENCY_SOURCE_SHA: dependencySha,
			}).ide,
		).toBe(candidate);
		expect(() => start({ DEPENDENCY_REPOSITORY: repository })).toThrow(
			"DEPENDENCY_SOURCE_SHA",
		);
		expect(() =>
			start({
				DEPENDENCY_REPOSITORY: repository,
				DEPENDENCY_SOURCE_SHA: dependencySha,
				IDE_SOURCE_SHA: "main",
			}),
		).toThrow("full commit SHA");
		expect(() =>
			start({
				DEPENDENCY_REPOSITORY: "OtherOrg/repo",
				DEPENDENCY_SOURCE_SHA: dependencySha,
			}),
		).toThrow("Unsupported");
		expect(() =>
			start({ BK_REPO_GIT_WEBHOOK_MR_SOURCE_COMMIT: dependencySha }),
		).toThrow("Incomplete PR");
		expect(() => start({ BK_CI_HOOK_TARGET_REPO_NAME: repository })).toThrow(
			"Incomplete PR",
		);
		expect(start().ide).toBe(candidate);
		expect(start({ IDE_SOURCE_SHA: baseline }).ide).toBe(baseline);
		const idePr = start({
			BK_CI_HOOK_TARGET_REPO_NAME: "ForgeaX-Games/forgeax-ide",
			BK_REPO_GIT_WEBHOOK_MR_SOURCE_COMMIT: candidate,
			IDE_SOURCE_SHA: baseline,
			DEPENDENCY_REPOSITORY: repository,
			BLUEKING_DEPENDENCY_REPOSITORY: repository,
			BLUEKING_DEPENDENCY_REVISION: dependencySha,
		});
		expect(idePr.ide).toBe(candidate);
		expect(idePr).not.toHaveProperty("repository");
		expect(idePr).not.toHaveProperty("dependency");

		const output = generateWebCi(ide);
		expect(output).toBe(join(ide, ".ci/web.yml"));
		expect(readdirSync(join(studio, "packages"))).toEqual(["ide"]);
		const first = readFileSync(output, "utf8");
		generateWebCi(ide);
		expect(readFileSync(output, "utf8")).toBe(first);
		expect(parseYaml(first)).toEqual(workflow);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30000);
