import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";

const workflow = parseYaml(
	readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
) as any;
const desktopWorkflow = parseYaml(
	readFileSync(
		new URL("../.github/workflows/desktop.yml", import.meta.url),
		"utf8",
	),
) as any;

describe("IDE product CI workflow", () => {
	test("GitHub and BlueKing run the shared Web gate", () => {
		const web = readFileSync(new URL("../.ci/web.sh", import.meta.url), "utf8");
		expect(web).toContain("bun run check:web");
		expect(web).toContain(
			"bun packages/ide/scripts/install-web-source-workspace.ts",
		);
		expect(web).not.toContain(
			"bun scripts/ci/install-ide-integration-workspace.ts",
		);
		const synchronizedPackages =
			web.match(/submodule update --init --recursive ([\s\S]*?)\n\n/)?.[1] ??
			"";
		for (const name of ["server", "orchestrator", "agent-host"]) {
			expect(synchronizedPackages).toContain(`packages/${name}`);
		}
		expect(web).not.toContain("--bin runtime-guardian");
		expect(web.indexOf("bun run check:web")).toBeLessThan(
			web.indexOf("tar -czf"),
		);
		for (const command of [
			"bun run lint",
			"bun run typecheck",
			"bun run test",
			"bun run build:web",
		]) {
			expect(web).not.toContain(command);
			expect(
				workflow.jobs.product.steps.some((step: any) => step.run === command),
			).toBe(false);
		}
		expect(
			workflow.jobs.product.steps.filter(
				(step: any) => step.run === "bun run lint",
			),
		).toEqual([]);
		const blueking = parseYaml(
			readFileSync(new URL("../.ci/web.yml", import.meta.url), "utf8"),
		) as any;
		const ideTrigger = blueking.on.find(
			(trigger: any) => trigger["repo-name"] === "ForgeaX-Games/forgeax-ide",
		);
		expect(ideTrigger.mr["target-branches"]).toEqual(["main"]);
		expect(blueking.on.find((trigger: any) => trigger.manual)?.manual).toBe(
			"enabled",
		);
		expect(blueking.variables.IDE_SOURCE_SHA.value).toBe("");
		expect(Object.keys(blueking.stages[0].jobs)).toEqual(["source_preflight"]);
		const desktop = parseYaml(
			readFileSync(new URL("../.ci/desktop.yml", import.meta.url), "utf8"),
		) as any;
		expect(Object.keys(desktop.stages[0].jobs)).toEqual([
			"linux_x64",
			"macos_arm64",
		]);
		expect(desktop.on.mr).toEqual(ideTrigger.mr);
		expect(desktop.on["repo-name"]).toBe(ideTrigger["repo-name"]);
		expect(desktop.on.type).toBe(ideTrigger.type);
		const desktopSteps = desktop.stages[0].jobs.linux_x64.steps;
		const desktopRun = desktopSteps.find(
			(step: any) => step.name === "固定 PR 版本并准备桌面环境",
		).run as string;
		const desktopBootstrap = readFileSync(
			new URL("../.ci/desktop-env.sh", import.meta.url),
			"utf8",
		);
		expect(desktopBootstrap.indexOf("apt-get install -y nodejs")).toBeLessThan(
			desktopBootstrap.indexOf("materialize-toolchain-inputs.sh"),
		);
		expect(
			desktopBootstrap.indexOf("materialize-toolchain-inputs.sh"),
		).toBeLessThan(desktopBootstrap.indexOf("toolchain-versions.cjs"));
		expect(desktopRun).not.toContain("materialize-toolchain-inputs.sh");
		expect(desktopRun).toContain("desktop-env.sh bootstrap");
		expect(
			desktopSteps.find((step: any) => step.name === "执行桌面 CI").run,
		).toContain("bun run ci:desktop linux-x64");
		expect(
			desktopSteps.find((step: any) => step.name === "归档 Linux 安装包").with
				.filePath,
		).toBe("forgeax-studio/packages/ide/blueking-artifacts/linux-x64/*");
		const steps = blueking.stages[0].jobs.source_preflight.steps;
		const run = steps.find(
			(step: any) => step.name === "固定版本并准备 Web",
		).run;
		expect(run).toContain("BK_REPO_GIT_WEBHOOK_MR_SOURCE_COMMIT");
		expect(run).toContain("bash forgeax-studio/packages/ide/.ci/web.sh");
		expect(workflow.on.pull_request).toBeUndefined();
		expect(desktopWorkflow.on).toEqual({
			push: { branches: ["main"] },
			workflow_dispatch: null,
		});
	});

	test("installs exact toolchain sources only after immutable Engine materialization", () => {
		for (const job of [workflow.jobs.product, desktopWorkflow.jobs.desktop]) {
			const steps = job.steps as any[];
			const index = (name: string) =>
				steps.findIndex((step) => step.name === name);
			expect(index("Authorize private package inputs")).toBeLessThan(
				index("Materialize immutable toolchain inputs"),
			);
			expect(index("Materialize immutable toolchain inputs")).toBeLessThan(
				index("Resolve exact desktop toolchain"),
			);
			for (const name of [
				"Setup Node",
				"Setup wasm-pack",
				"Install Rust toolchain",
			])
				expect(index("Resolve exact desktop toolchain")).toBeLessThan(
					index(name),
				);
			const node = steps[index("Setup Node")];
			expect(node.with["node-version"]).toBe(
				"${{ steps.desktop-toolchain.outputs.node }}",
			);
			const wasm = steps[index("Setup wasm-pack")];
			expect(wasm.with.tool).toBe(
				"wasm-pack@${{ steps.desktop-toolchain.outputs.wasmPack }}",
			);
			const rust = steps[index("Install Rust toolchain")];
			expect(rust.with.toolchain).toBe(
				"${{ steps.desktop-toolchain.outputs.rust }}",
			);
		}
	});

	test("delegates runtime preparation and checks together to the IDE gate", () => {
		const steps = workflow.jobs.product.steps as any[];
		expect(steps.filter((step) => step.run === "bun run check:web")).toEqual([
			{
				name: "Check and build Web",
				"working-directory": "forgeax-studio/packages/ide",
				run: "bun run check:web",
			},
		]);
		expect(
			steps.some((step) => step.run?.includes("--bin runtime-guardian")),
		).toBe(false);
	});
});

describe("IDE integration install diagnostics", () => {
	for (const [name, job, installCommand] of [
		[
			"product",
			workflow.jobs.product,
			"bun packages/ide/scripts/install-web-source-workspace.ts",
		],
	] as const) {
		test(`${name} limits diagnostics to its declared integration install step`, () => {
			const steps = job.steps as any[];
			const install = steps.find(
				(step) => step.name === "Install Studio integration workspace",
			);

			expect(install).toEqual({
				name: "Install Studio integration workspace",
				"working-directory": "forgeax-studio",
				env: {
					FORGEAX_IDE_INSTALL_DIAGNOSTICS: "1",
					BUN_INSTALL_CACHE_DIR:
						"${{ runner.temp }}/ide-integration-bun-cache-${{ github.job }}-${{ github.run_id }}-${{ github.run_attempt }}",
				},
				run: installCommand,
			});
			expect(job.env).not.toHaveProperty("FORGEAX_IDE_INSTALL_DIAGNOSTICS");
			expect(
				steps.filter(
					(step) => step.env?.FORGEAX_IDE_INSTALL_DIAGNOSTICS !== undefined,
				),
			).toEqual([install]);
		});
	}
});

describe("Desktop packaging contract", () => {
	test("BlueKing transports verified caches before building and saves only after successful checks", () => {
		for (const [profile, buildName, kinds] of [
			["web", "测试并构建 Web", ["downloads", "shader", "cargo"]],
			["desktop", "执行桌面 CI", ["downloads", "shader", "wasm", "cargo"]],
		] as const) {
			const pipeline = parseYaml(
				readFileSync(new URL(`../.ci/${profile}.yml`, import.meta.url), "utf8"),
			) as any;
			const job = Object.values(pipeline.stages[0].jobs)[0] as any;
			const steps = job.steps as any[];
			const build = steps.findIndex((step) => step.name === buildName);
			const restore = steps.findIndex((step) => step.id === "cache_restore");
			const save = steps.findIndex((step) => step.id === "cache_save");
			expect(restore).toBeLessThan(build);
			expect(save).toBeGreaterThan(build);
			expect(job.env.FORGEAX_CI_CACHE_PROFILE).toBe(profile);
			for (const kind of kinds) {
				const download = steps.findIndex(
					(step) => step.id === `cache_download_${kind}`,
				);
				expect(download).toBeLessThan(restore);
				expect(steps[download].with.srcPaths).toBe(
					`/forgeax-ide/cache/v2/${profile}/` +
						"${{ steps.cache_keys.outputs." +
						kind +
						" }}.tar.gz",
				);
				expect(steps[download]["continue-on-error"]).toBe(true);
			}
			expect(steps[build]["continue-on-error"]).toBeUndefined();
			expect(
				steps.find((step) => step.id === "cache_upload").with,
			).toMatchObject({ repoName: "custom", enableMD5Checksum: true });
			// BlueKing evaluates `if` as a raw expression; interpolation wrappers
			// produce a runtime parser error and silently skip cache uploads.
			expect(steps.find((step) => step.id === "cache_upload").if).toBe(
				"steps.cache_save.outputs.upload == 'true'",
			);
			expect(steps.at(-1).with.repoName).toBe("pipeline");
			expect(steps.at(-1)["continue-on-error"]).toBeUndefined();
		}
	});

	test("Mac job checks native architecture and restores all four cache layers", () => {
		const desktop = parseYaml(
			readFileSync(new URL("../.ci/desktop.yml", import.meta.url), "utf8"),
		) as any;
		const job = desktop.stages[0].jobs.macos_arm64;
		expect(job["runs-on"]).toEqual({
			"pool-name": "macos-macOS15.6",
			"hw-spec": "Macmini-5",
			xcode: "16.2",
		});
		const steps = job.steps as any[];
		expect(steps[0].run).toContain('test "$(uname -m)" = arm64');
		const build = steps.findIndex((step) => step.name === "执行桌面 CI");
		const restore = steps.findIndex((step) => step.id === "mac_cache_restore");
		const save = steps.findIndex((step) => step.id === "mac_cache_save");
		expect(restore).toBeLessThan(build);
		expect(save).toBeGreaterThan(build);
		for (const kind of ["downloads", "shader", "wasm", "cargo"]) {
			const download = steps.findIndex(
				(step) => step.id === `mac_cache_download_${kind}`,
			);
			expect(download).toBeLessThan(restore);
			expect(steps[download].with.srcPaths).toContain(
				`steps.mac_cache_keys.outputs.${kind}`,
			);
		}
		for (const id of [
			"mac_cache_keys",
			"mac_cache_restore",
			"mac_cache_save",
		]) {
			expect(steps.find((step) => step.id === id).run).toContain(
				"source forgeax-studio/packages/ide/.ci/desktop-env.sh",
			);
		}
		expect(steps[build].run).toContain("bun run ci:desktop macos-arm64");
		expect(steps.find((step) => step.id === "mac_cache_upload").if).toBe(
			"steps.mac_cache_save.outputs.upload == 'true'",
		);
		expect(steps.at(-1).with.filePath).toBe(
			"forgeax-studio/packages/ide/blueking-artifacts/macos-arm64/*",
		);
	});

	test("GitHub has one job-scoped Git credential for checkout and recursive inputs", () => {
		const steps = desktopWorkflow.jobs.desktop.steps as any[];
		const checkouts = steps.filter((step) =>
			step.uses?.startsWith("actions/checkout@"),
		);
		expect(checkouts).toHaveLength(2);
		expect(
			checkouts.every((step) => step.with["persist-credentials"] === false),
		).toBe(true);
		const authorize = steps.find(
			(step) => step.name === "Authorize private package inputs",
		).run;
		expect(desktopWorkflow.jobs.desktop.env?.GIT_CONFIG_GLOBAL).toBeUndefined();
		expect(steps[0].run).toContain(
			"GIT_CONFIG_GLOBAL=$RUNNER_TEMP/ide-desktop-",
		);
		expect(steps[0].run).toContain('>> "$GITHUB_ENV"');
		expect(authorize).toContain("umask 077");
		expect(authorize).toContain("chmod 600");
		expect(authorize).not.toContain("GIT_CONFIG_COUNT");
		expect(
			steps.find((step) => step.name === "Remove job Git credentials"),
		).toMatchObject({ if: "always()", run: 'rm -f -- "$GIT_CONFIG_GLOBAL"' });
	});

	test("BlueKing ensures Git LFS before any job checks out recursive sources", () => {
		const blueking = parseYaml(
			readFileSync(new URL("../.ci/web.yml", import.meta.url), "utf8"),
		) as any;
		const desktop = parseYaml(
			readFileSync(new URL("../.ci/desktop.yml", import.meta.url), "utf8"),
		) as any;
		for (const job of [
			...Object.values(blueking.stages[0].jobs),
			...Object.values(desktop.stages[0].jobs),
		] as any[]) {
			const checkoutIndex = job.steps.findIndex((step: any) => step.checkout);
			const bootstrapIndex = job.steps.findIndex((step: any) =>
				step.run?.includes("git lfs version"),
			);
			expect(bootstrapIndex).toBeGreaterThanOrEqual(0);
			expect(bootstrapIndex).toBeLessThan(checkoutIndex);
		}
	});

	test("both providers delegate all project stages to the same public command", () => {
		const steps = desktopWorkflow.jobs.desktop.steps as any[];
		const desktop = parseYaml(
			readFileSync(new URL("../.ci/desktop.yml", import.meta.url), "utf8"),
		) as any;
		const native = desktop.stages[0].jobs.linux_x64.steps;
		expect(desktopWorkflow.jobs.desktop["runs-on"]).toEqual([
			"self-hosted",
			"Linux",
			"X64",
			"heavy",
		]);
		for (const [platform, pipeline] of [
			["linux-x64", steps],
			["linux-x64", native],
			["macos-arm64", desktop.stages[0].jobs.macos_arm64.steps],
		] as const) {
			const commands = pipeline
				.filter((step: any) => step.run)
				.map((step: any) => step.run)
				.join("\n");
			expect(commands.match(/bun run ci:desktop/g)).toHaveLength(1);
			for (const forbidden of [
				"bun install",
				"build:desktop",
				"desktop.ts ",
				"submodule update",
				"smoke:",
				"playwright-core/cli.js",
				"ci-integration-input.ts",
			]) {
				expect(commands).not.toContain(forbidden);
			}
			expect(
				pipeline.some(
					(step: any) =>
						step["continue-on-error"] && !step.id?.match(/^(mac_)?cache_/),
				),
			).toBe(false);
			expect(
				pipeline.find(
					(step: any) =>
						(step.uses?.startsWith("UploadArtifactory@") &&
							step.with.repoName !== "custom") ||
						step.uses?.startsWith("actions/upload-artifact@"),
				).with.filePath ??
					pipeline.find((step: any) =>
						step.uses?.startsWith("actions/upload-artifact@"),
					).with.path,
			).toBe(`forgeax-studio/packages/ide/blueking-artifacts/${platform}/*`);
		}
		const ci = steps.find((step) => step.run === "bun run ci:desktop");
		expect(ci.env.FORGEAX_CI_IDE_REVISION).toBe("${{ github.sha }}");
		expect(ci.env.CI).toBe("true");
		expect(
			steps.find((step) => step.name === "Upload Linux installers").with[
				"if-no-files-found"
			],
		).toBe("error");
		expect(
			steps.find((step) => step.name === "Upload desktop smoke diagnostics"),
		).toMatchObject({
			if: "always()",
			uses: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
			with: { "if-no-files-found": "warn", "retention-days": 7 },
		});
		expect(native.at(-1).with.enableFileCheckExist).toBe(true);
		const runner = readFileSync(
			new URL("../scripts/ci-desktop.ts", import.meta.url),
			"utf8",
		);
		expect(runner).not.toContain("tauri.release.conf.json");
		expect(runner.match(/["']build:desktop["']/g)).toHaveLength(1);
		expect(runner).toMatch(/process\.execPath,\s*"run",\s*"lint",/);
		const toolchain = "source .ci/wasm-toolchain.sh; ";
		expect(runner.split(toolchain)).toHaveLength(3);
		expect(runner).toContain(
			'source .ci/wasm-toolchain.sh; bun scripts/desktop-toolchain.ts verify; exec "$@"',
		);
		expect(runner.indexOf(toolchain)).toBeLessThan(
			runner.indexOf('} else if (stage === "build")'),
		);
		expect(runner).not.toContain("BLUEKING");
		expect(runner).not.toContain("GITHUB");
		expect(ci.env.IDE_SMOKE_DIAGNOSTIC_DIR).toContain(
			"ide-desktop-smoke-diagnostics",
		);
		const hook = readFileSync(
			new URL("../scripts/prepare-desktop.ts", import.meta.url),
			"utf8",
		);
		expect(
			hook.match(
				/run\(\[["']scripts\/install-desktop-source-workspace.ts["']\]\)/g,
			),
		).toHaveLength(1);
		const importerPreparation = hook.indexOf(
			'for (const name of ["fbx", "codec"])',
		);
		const desktopFrontendBuild = hook.search(
			/run\(\[\s*["']run["'],\s*["']build:web["'],\s*["']--desktop["']\s*\]\)/,
		);
		expect(importerPreparation).toBeGreaterThanOrEqual(0);
		expect(desktopFrontendBuild).toBeGreaterThanOrEqual(0);
		expect(importerPreparation).toBeLessThan(desktopFrontendBuild);
	});
});
