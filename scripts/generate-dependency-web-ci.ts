#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as YAML from "yaml";
import inventory from "../product/direct-dependencies.json";

const IDE_REPOSITORY = "ForgeaX-Games/forgeax-ide";

export function webWorkflow(): Record<string, any> {
	const repositories = [
		...new Set([
			IDE_REPOSITORY,
			...Object.values(inventory.packages).map((value) => value.repository),
		]),
	];
	if (
		repositories.some(
			(repository) => !/^ForgeaX-Games\/forgeax-[a-z-]+$/.test(repository),
		)
	)
		throw new Error("Invalid repository in direct dependency inventory");
	const base: any = YAML.parse(
		readFileSync(new URL("../.ci/web.yml", import.meta.url), "utf8"),
	);
	base.name = "ForgeaX IDE Web";
	base.desc = "统一校验 IDE 与直接依赖 PR，运行 Web 测试、构建并回写原 PR。";
	base.on = [
		{ manual: "enabled" },
		...repositories.map((repository) => ({
			"repo-name": repository,
			type: "github",
			mr: {
				name:
					repository === IDE_REPOSITORY
						? "GitHub 触发"
						: repository.replace("ForgeaX-Games/forgeax-", "") + " PR",
				"target-branches": ["main"],
				action: ["open", "reopen", "push-update"],
			},
		})),
	];
	base.variables.IDE_SOURCE_SHA.props.description =
		"留空使用 IDE main；联调时填完整 IDE commit SHA；IDE PR 使用事件 SHA";
	base.variables.DEPENDENCY_REPOSITORY = {
		value: IDE_REPOSITORY,
		"allow-modify-at-startup": true,
		props: {
			type: "selector",
			label: "构建仓库",
			description: "手动选择 IDE 或依赖仓库；PR 自动使用事件中的目标仓库",
			options: repositories.map((repository) => ({
				id: repository,
				label: repository.replace("ForgeaX-Games/forgeax-", ""),
			})),
		},
	};
	base.variables.DEPENDENCY_SOURCE_SHA = {
		value: "",
		"allow-modify-at-startup": true,
		props: {
			type: "vuex-input",
			description: "手动构建依赖时必填完整 commit SHA；PR 自动使用事件 SHA",
		},
	};
	base.variables.IDE_WEB_COMPANIONS = {
		value: "[]",
		"allow-modify-at-startup": true,
		props: {
			type: "vuex-textarea",
			description:
				"可选联调候选 JSON 数组：repository、revision、可选 pullRequest",
		},
	};
	const job = base.stages[0].jobs.source_preflight;
	job.steps = job.steps.filter(
		(step: any) => !step.name?.startsWith("拉取 npm 候选 "),
	);
	const steps = job.steps;
	const buildIndex = steps.findIndex(
		(step: any) => step.name === "固定版本并准备 Web",
	);
	if (buildIndex < 0) throw new Error("Missing shared Web build step");
	steps.splice(
		buildIndex,
		0,
		...Object.entries(inventory.packages)
			.filter(([, value]) => value.mode === "npm")
			.map(([name, value]) => ({
				name: "拉取 npm 候选 " + name,
				checkout: { "repo-name": value.repository },
				with: {
					refName: "main",
					localPath:
						"forgeax-studio/.forgeax/ide-web-candidates/" + name.slice(9),
				},
			})),
	);
	steps.find((step: any) => step.name === "固定版本并准备 Web").run =
		[
			"set -eu",
			// These hook variables survive later checkouts; BK_CI_GIT_REPO_NAME does not.
			'event_repository="${BK_CI_HOOK_TARGET_REPO_NAME:-}"',
			'event_revision="${BK_REPO_GIT_WEBHOOK_MR_SOURCE_COMMIT:-}"',
			'if [ -n "$event_repository$event_revision" ]; then',
			'  test -n "$event_repository" && test -n "$event_revision" || { echo "Incomplete PR repository/source SHA event" >&2; exit 1; }',
			'  source_repository="$event_repository"',
			"else",
			'  source_repository="${DEPENDENCY_REPOSITORY:-ForgeaX-Games/forgeax-ide}"',
			"fi",
			'case "$source_repository" in',
			"  " + repositories.join("|") + ") ;;",
			'  *) echo "Unsupported source repository: $source_repository" >&2; exit 1 ;;',
			"esac",
			"unset BLUEKING_DEPENDENCY_REPOSITORY BLUEKING_DEPENDENCY_REVISION",
			'if [ "$source_repository" = ForgeaX-Games/forgeax-ide ]; then',
			"  ide_revision=\"$(node -e \"const s=process.env.BK_REPO_GIT_WEBHOOK_MR_SOURCE_COMMIT||process.env.IDE_SOURCE_SHA||'';if(s&&!/^[a-f0-9]{40}$/.test(s))throw new Error('IDE_SOURCE_SHA must be a full commit SHA');process.stdout.write(s)\")\"",
			"else",
			'  dependency_revision="$(node -e "const s=process.env.BK_REPO_GIT_WEBHOOK_MR_SOURCE_COMMIT||process.env.DEPENDENCY_SOURCE_SHA;if(!s||!/^[a-f0-9]{40}$/.test(s))throw new Error(\'A dependency PR event or DEPENDENCY_SOURCE_SHA is required\');process.stdout.write(s)")"',
			"  ide_revision=\"$(node -e \"const s=process.env.IDE_SOURCE_SHA||'';if(s&&!/^[a-f0-9]{40}$/.test(s))throw new Error('IDE_SOURCE_SHA must be a full commit SHA');process.stdout.write(s)\")\"",
			'  export BLUEKING_DEPENDENCY_REPOSITORY="$source_repository"',
			'  export BLUEKING_DEPENDENCY_REVISION="$dependency_revision"',
			'  echo "::set-variable name=DEPENDENCY_SOURCE_SHA::$dependency_revision"',
			"fi",
			'if [ -z "$ide_revision" ]; then',
			"  git -C forgeax-studio/packages/ide fetch origin refs/heads/main",
			'  ide_revision="$(git -C forgeax-studio/packages/ide rev-parse FETCH_HEAD)"',
			"else",
			'  git -C forgeax-studio/packages/ide fetch origin "$ide_revision"',
			'  test "$(git -C forgeax-studio/packages/ide rev-parse FETCH_HEAD)" = "$ide_revision"',
			"fi",
			'git -C forgeax-studio/packages/ide checkout --detach "$ide_revision"',
			'test "$(git -C forgeax-studio/packages/ide rev-parse HEAD)" = "$ide_revision"',
			'export IDE_SOURCE_SHA="$ide_revision"',
			'export BLUEKING_IDE_REVISION="$ide_revision"',
			'echo "::set-variable name=DEPENDENCY_REPOSITORY::$source_repository"',
			'echo "::set-variable name=IDE_SOURCE_SHA::$ide_revision"',
			"BLUEKING_WEB_PHASE=prepare bash forgeax-studio/packages/ide/.ci/web.sh",
		].join("\n") + "\n";
	return base;
}

export function serializeWorkflow(workflow: Record<string, any>): string {
	return YAML.stringify(workflow, { lineWidth: 0 });
}

export function generateWebCi(ide: string): string {
	const directory = join(ide, ".ci");
	mkdirSync(directory, { recursive: true });
	const output = join(directory, "web.yml");
	writeFileSync(
		output,
		"# Generated by scripts/generate-dependency-web-ci.ts; one shared pipeline for IDE and dependency PRs.\n" +
			serializeWorkflow(webWorkflow()),
	);
	return output;
}

if (import.meta.main) {
	if (Bun.argv[2])
		throw new Error(
			"Usage: bun scripts/generate-dependency-web-ci.ts (no arguments)",
		);
	console.log(generateWebCi(resolve(import.meta.dirname, "..")));
}
