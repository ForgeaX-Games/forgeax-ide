import { readFileSync } from "node:fs";
import { parseConfigFileTextToJson } from "typescript";
import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import transport from "../../release/transport-contract.v1.json";
import {
	SMOKE_CLEANUP_BUDGET_MS,
	SMOKE_MAIN_BUDGET_MS,
} from "../../scripts/smoke-assembled-desktop-runtime";

const SMOKE_WORKFLOW_TIMEOUT_MINUTES = 6;
const SMOKE_WORKFLOW_MARGIN_MS = 30_000;

const workflowText = readFileSync(
	new URL("../../.github/workflows/release.yml", import.meta.url),
	"utf8",
);
const workflow = parseYaml(workflowText) as any;
const triggers = workflow.on ?? workflow.true;

describe("IDE owner release workflow", () => {
	test("keeps native release lanes paused pending self-hosted pools", () => {
		expect(workflow.jobs["desktop-dry-run"].if).toBe("${{ false }}");
		expect(workflow.jobs["desktop-publish"].if).toBe("${{ false }}");
	});

	test("exposes the exact public dispatch contract and correlation run name", () => {
		expect(Object.keys(triggers.workflow_dispatch.inputs).sort()).toEqual([
			"ide_revision",
			"integration_revision",
			"intent",
			"orchestration_id",
			"revision_branch",
			"sidecar_candidate_manifest_sha256",
			"sidecar_candidate_manifest_url",
			"version",
		]);
		for (const input of Object.values(
			triggers.workflow_dispatch.inputs,
		) as any[])
			expect(input.required).toBe(true);
		expect(triggers.workflow_dispatch.inputs.intent).toMatchObject({
			default: "dry-run",
			options: ["dry-run", "publish"],
		});
		expect(workflow["run-name"]).toContain(
			"ide-release / ${{ inputs.orchestration_id",
		);
		expect(triggers.push).toBeUndefined();
	});

	test("keeps native builds outside signing approval and protects only publication", () => {
		expect(workflow.jobs["desktop-dry-run"].environment).toBeUndefined();
		expect(workflow.jobs["desktop-publish"].environment).toBeUndefined();
		expect(workflow.jobs.publish.environment).toBe("release-publish");
		expect(workflow.jobs.publish.if).toContain("mode == 'publish'");
		expect(workflow.jobs.publish.permissions).toEqual({ contents: "read" });
		expect(JSON.stringify(workflow.jobs.publish)).toContain(
			"secrets.INTERNAL_TOKEN",
		);
		for (const [name, job] of Object.entries(workflow.jobs) as Array<
			[string, any]
		>) {
			if (name !== "publish")
				expect(job.permissions?.contents).not.toBe("write");
		}
		expect(JSON.stringify(workflow.jobs["desktop-publish"])).not.toMatch(
			/APPLE_|WINDOWS_CERTIFICATE|release-signing/,
		);
		expect(JSON.stringify(workflow.jobs["desktop-publish"])).toContain(
			"Build explicitly unsigned installer",
		);
		const dryCompile = workflow.jobs["desktop-dry-run"].steps.find(
			(step: any) => step.name === "Compile and link native binary",
		);
		const dryBundle = workflow.jobs["desktop-dry-run"].steps.find(
			(step: any) => step.name === "Bundle unsigned dry-run installer",
		);
		const dryVerify = workflow.jobs["desktop-dry-run"].steps.find(
			(step: any) =>
				step.name === "Verify bundle and create suppressed platform evidence",
		);
		expect(dryCompile.shell).toBe("bash");
		expect(dryBundle.shell).toBe("bash");
		expect(dryVerify.shell).toBe("bash");
		expect(dryCompile.run).toContain(
			'bun run build:desktop --config src-tauri/tauri.release.conf.json --target "$RELEASE_TARGET" --no-bundle',
		);
		expect(dryBundle.run).toContain(
			'bun run tauri bundle --config src-tauri/tauri.release.conf.json --target "$RELEASE_TARGET"',
		);
		expect(dryVerify.run).toContain("verify:release-bundle");
		const publishBuild = workflow.jobs["desktop-publish"].steps.find(
			(step: any) => step.name === "Build explicitly unsigned installer",
		);
		const publishSeal = workflow.jobs["desktop-publish"].steps.find(
			(step: any) =>
				step.name ===
				"Verify complete macOS ad-hoc bundle and runtime entitlement",
		);
		expect(publishBuild.run).toContain(
			'bun run build:desktop --config src-tauri/tauri.release.conf.json --target "$RELEASE_TARGET"',
		);
		expect(publishBuild.run).not.toContain("tauri build -- --target");
		expect(publishSeal.if).toBe("runner.os == 'macOS'");
		expect(publishSeal.run).toContain("verify:macos-bundle");
		expect(publishSeal.run).toContain("ForgeaX Studio.app");
		const dryRun = workflow.jobs["desktop-dry-run"];
		const nativeBundle = dryRun.steps.find(
			(step: any) => step.name === "Bundle unsigned dry-run installer",
		);
		expect(
			dryRun.steps.find(
				(step: any) =>
					step.name === "Preserve vendor-signed Bun in macOS bundle and DMG",
			),
		).toBeUndefined();
		expect(nativeBundle.shell).toBe("bash");
		expect(nativeBundle.run).toContain("--stage tauri-bundle");
		expect(nativeBundle.run).toContain(
			'--size tauri-bundle="src-tauri/target/$RELEASE_TARGET/release/bundle"',
		);
		expect(nativeBundle.run).toContain('if [ "$RUNNER_OS" = "macOS" ]; then');
		const bundleIndex = nativeBundle.run.indexOf(
			'bun run tauri bundle --config src-tauri/tauri.release.conf.json --target "$RELEASE_TARGET"',
		);
		const finalizerIndex = nativeBundle.run.indexOf(
			'bun run finalize:macos-bundle --bundle-root "src-tauri/target/$RELEASE_TARGET/release/bundle" --target "$RELEASE_TARGET"',
		);
		expect(bundleIndex).toBeGreaterThanOrEqual(0);
		expect(finalizerIndex).toBeGreaterThan(bundleIndex);
		const publishFinalizer = workflow.jobs["desktop-publish"].steps.find(
			(step: any) =>
				step.name === "Preserve vendor-signed Bun in macOS bundle and DMG",
		);
		expect(publishFinalizer).toMatchObject({
			if: "runner.os == 'macOS'",
			shell: "bash",
			"working-directory": "forgeax-studio/packages/ide",
			run: 'bun run finalize:macos-bundle --bundle-root "src-tauri/target/$RELEASE_TARGET/release/bundle" --target "$RELEASE_TARGET"',
		});
		const publishFinalizerIndex =
			workflow.jobs["desktop-publish"].steps.indexOf(publishFinalizer);
		const publishBuildIndex = workflow.jobs["desktop-publish"].steps.findIndex(
			(step: any) => step.name.includes("installer"),
		);
		expect(publishBuildIndex).toBeLessThan(publishFinalizerIndex);
		const productionSmoke = workflow.jobs["desktop-publish"].steps.find(
			(step: any) => step.name === "Smoke-test the production web bundle",
		);
		expect(publishFinalizerIndex).toBeLessThan(
			workflow.jobs["desktop-publish"].steps.indexOf(productionSmoke),
		);
		expect(nativeBundle.run.indexOf("--size tauri-bundle=")).toBeLessThan(
			nativeBundle.run.indexOf("bun run finalize:macos-bundle"),
		);
		expect(nativeBundle.run.indexOf("--stage tauri-bundle")).toBeLessThan(
			nativeBundle.run.indexOf("--size tauri-bundle="),
		);
	});

	test("uses the canonical platform roster and public transport artifact names", () => {
		const lockPath = new URL("../../.ci/web-source.bun.lock", import.meta.url);
		const lock = parseConfigFileTextToJson(
			lockPath.pathname,
			readFileSync(lockPath, "utf8"),
		);
		expect(lock.error).toBeUndefined();
		const workspaceSources = [
			...new Set(
				Object.keys(lock.config.workspaces)
					.flatMap(
						(path) => path.match(/^\.\.\/\.\.\/(packages\/[^/]+)/)?.[1] ?? [],
					)
					.filter(
						(path) =>
							![
								"packages/ide",
								"packages/app-shell",
								"packages/recursive-input-contract",
							].includes(path),
					),
			),
		];
		for (const jobName of ["preflight", "desktop-dry-run", "desktop-publish"]) {
			const materialize = workflow.jobs[jobName].steps.find((step: any) =>
				step.name.includes("Materialize integration workspace"),
			);
			expect(materialize.env.GITHUB_TOKEN).toBe(
				"${{ secrets.INTERNAL_TOKEN }}",
			);
			expect(materialize.run).toContain(
				'if [ "$RUNNER_OS" = "Windows" ]; then export PATH="/c/Windows/System32:$PATH"; fi',
			);
			expect(materialize.run).not.toContain("TAR_OPTIONS");
			const expectedSources =
				jobName === "preflight"
					? [
							...workspaceSources,
							"packages/agent-host",
							"packages/server",
							"packages/orchestrator",
						]
					: [...workspaceSources, "packages/server"];
			for (const runtimeSource of expectedSources) {
				expect(materialize.run).toContain(runtimeSource);
			}
			expect(materialize.run).toContain(
				"bun scripts/packages.ts sync --only app-shell",
			);
			const install = workflow.jobs[jobName].steps.find(
				(step: any) => step.name === "Install release integration workspace",
			);
			expect(install.run).toContain(
				"bun packages/ide/scripts/install-web-source-workspace.ts",
			);
			expect(install.run).not.toContain("bun install --cwd packages/ide");
			if (jobName !== "preflight") {
				expect(install.run).toContain(
					"bun install --cwd packages/editor --ignore-scripts --frozen-lockfile",
				);
				expect(install.run).not.toContain(
					"install-ide-integration-workspace.ts",
				);
			}
			expect(
				workflow.jobs[jobName].env.FORGEAX_REQUIRE_PUBLISHABLE_SHADER_INPUTS,
			).toBe("1");
			const jobText = JSON.stringify(workflow.jobs[jobName]);
			if (jobName === "preflight") {
				expect(jobText).toContain(
					"packages/editor/packages/engine/packages/wgpu-wasm fetch-wasm",
				);
				expect(jobText).toContain(
					"packages/editor/packages/engine/packages/fbx fetch-wasm",
				);
				expect(jobText).toContain(
					"packages/editor/packages/engine/packages/codec fetch-wasm",
				);
			} else {
				expect(jobText).not.toContain("fetch-wasm");
				expect(jobText).toContain("artifact:engine-runtime target");
			}
		}
		for (const jobName of ["desktop-dry-run", "desktop-publish"]) {
			const matrix = workflow.jobs[jobName].strategy.matrix.include;
			const wasmPack = workflow.jobs[jobName].steps.find(
				(step: any) => step.name === "Setup wasm-pack",
			);
			const roster = matrix.map((entry: any) => ({
				logicalId: entry.logical_id,
				targetTriple: entry.target,
			}));
			expect(wasmPack).toBeUndefined();
			expect(roster).toEqual(
				transport.platforms.map(({ logicalId, targetTriple }) => ({
					logicalId,
					targetTriple,
				})),
			);
			expect(
				matrix.find((entry: any) => entry.logical_id === "macos-arm64").runner,
			).toBe("macos-14");
			expect(
				matrix.find((entry: any) => entry.logical_id === "macos-x64").runner,
			).toBe("macos-15-intel");
			const assembly = workflow.jobs[jobName].steps.find((step: any) =>
				step.name.includes("Compose and validate"),
			);
			const targetRuntime = workflow.jobs[jobName].steps.find(
				(step: any) => step.name === "Build target-native Runtime artifact",
			);
			const evidence = workflow.jobs[jobName].steps.find((step: any) =>
				step.name.includes("platform evidence"),
			);
			expect(assembly.shell).toBe("bash");
			expect(evidence.shell).toBe("bash");
			expect(targetRuntime.run).toContain("stage:release-sidecar");
			expect(targetRuntime.run).toContain("artifact:desktop-runtime target");
			expect(assembly.run).toContain("compose:desktop-resources");
			expect(assembly.run).toContain(
				"--runtime-common release-work/runtime-common",
			);
			expect(assembly.run).toContain(
				"--runtime-target release-work/runtime-target",
			);
			expect(assembly.run).not.toContain("--engine-common");
			expect(assembly.run).not.toContain("--web-common");
			expect(assembly.run).toContain("validate:desktop:resources");
		}
		expect(transport.artifacts.candidate).toBe(
			"ide-release-candidate-{orchestrationId}",
		);
		expect(transport.artifacts.assets).toBe(
			"ide-release-assets-{orchestrationId}",
		);
		expect(workflowText).toContain(
			"needs.resolve.outputs.candidate_artifact_name",
		);
		expect(workflowText).toContain(
			"needs.resolve.outputs.assets_artifact_name",
		);
		expect(workflowText).toContain("candidate-transport/candidate.json");
		expect(workflowText).toContain("candidate-transport/recovery.jsonl");
		expect(workflowText).toContain("candidate-transport/evidence");
	});

	test("records dry-run install, Engine, Web, Runtime, Tauri, and upload baseline boundaries", () => {
		for (const jobName of ["preflight", "desktop-dry-run", "desktop-publish"]) {
			const steps = workflow.jobs[jobName].steps;
			const index = (name: string) =>
				steps.findIndex((step: any) => step.name === name);
			const resolver = steps[index("Resolve exact desktop toolchain")];
			expect(resolver.id).toBe("desktop-toolchain");
			expect(resolver.run).toBe(
				"bun forgeax-studio/packages/ide/.ci/toolchain-versions.cjs github",
			);
			expect(
				steps.findIndex((step: any) =>
					step.name.includes("Materialize integration workspace"),
				),
			).toBeLessThan(index("Resolve exact desktop toolchain"));
			const setupNode = steps.find(
				(step: any) => step.name === "Install Node.js",
			);
			expect(setupNode.with).toEqual({
				"node-version": "${{ steps.desktop-toolchain.outputs.node }}",
				"package-manager-cache": false,
			});
			const setupPnpm = steps.find((step: any) => step.name === "Install pnpm");
			expect(setupPnpm.with).toEqual({
				version: "${{ steps.desktop-toolchain.outputs.pnpm }}",
				run_install: false,
			});
			for (const name of ["Install Node.js", "Install pnpm"])
				expect(index("Resolve exact desktop toolchain")).toBeLessThan(
					index(name),
				);
			const rustName =
				jobName === "preflight"
					? "Install Rust toolchain"
					: "Install Rust target";
			expect(steps[index(rustName)].with.toolchain).toBe(
				"${{ steps.desktop-toolchain.outputs.rust }}",
			);
			expect(index("Resolve exact desktop toolchain")).toBeLessThan(
				index(rustName),
			);
			const verification =
				jobName === "preflight"
					? "Verify exact desktop toolchain"
					: "Verify exact release target toolchain";
			expect(index(rustName)).toBeLessThan(index(verification));
			expect(steps[index(verification)].run).toBe(
				jobName === "preflight"
					? "bun run verify:desktop-toolchain"
					: "bun scripts/desktop-toolchain.ts verify-release-target",
			);
		}
		expect(
			workflow.jobs.preflight.steps.find(
				(step: any) => step.name === "Setup wasm-pack",
			),
		).toMatchObject({
			uses: "taiki-e/install-action@94c31af3204a9f15ab40b35ad084410b905bbc73",
			with: {
				tool: "wasm-pack@${{ steps.desktop-toolchain.outputs.wasmPack }}",
			},
		});
		for (const jobName of [
			"cleanup-candidate-transient-artifacts",
			"cleanup-published-transient-artifacts",
		]) {
			const bun = workflow.jobs[jobName].steps.find(
				(step: any) => step.name === "Install Bun",
			);
			expect(bun.with).toEqual({ "bun-version-file": "package.json" });
		}
		const preflightNames = workflow.jobs.preflight.steps.map(
			(step: any) => step.name,
		);
		expect(preflightNames).toContain("Install release integration workspace");
		expect(preflightNames).toContain("Prepare Engine release inputs");
		expect(preflightNames).toContain(
			"Build content-addressed Engine common artifacts",
		);
		expect(preflightNames).toContain("Build content-addressed Web bundle");
		expect(preflightNames).toContain(
			"Build content-addressed Runtime common artifact",
		);
		expect(preflightNames).toContain("Upload Runtime common artifact");
		expect(preflightNames).not.toContain("Upload Engine common artifacts");
		expect(preflightNames).not.toContain("Upload Web common artifact");
		const runtimeCommonUpload = workflow.jobs.preflight.steps.find(
			(step: any) => step.name === "Upload Runtime common artifact",
		);
		expect(runtimeCommonUpload.with["include-hidden-files"]).toBe(true);
		expect(preflightNames).toContain("Build content-addressed Web bundle");
		expect(preflightNames).toContain("Upload preflight stage metrics");
		const preflightPrepare = workflow.jobs.preflight.steps.find(
			(step: any) => step.name === "Prepare Engine release inputs",
		);
		expect(preflightPrepare.env.GITHUB_TOKEN).toBe(
			"${{ secrets.INTERNAL_TOKEN }}",
		);
		const dryRun = workflow.jobs["desktop-dry-run"];
		const dryRunPrepare = dryRun.steps.find(
			(step: any) => step.name === "Build target-native Engine overlay",
		);
		expect(dryRunPrepare.run).toContain("artifact:engine-runtime target");
		for (const stage of [
			"install",
			"engine-target",
			"runtime-target",
			"runtime-assemble",
			"cargo-compile-link",
			"tauri-bundle",
			"bundle-verify",
		]) {
			expect(JSON.stringify(dryRun)).toContain(`--stage ${stage}`);
		}
		const nativeCompile = dryRun.steps.find(
			(step: any) => step.name === "Compile and link native binary",
		);
		const nativeBundle = dryRun.steps.find(
			(step: any) => step.name === "Bundle unsigned dry-run installer",
		);
		const bundleVerify = dryRun.steps.find(
			(step: any) =>
				step.name === "Verify bundle and create suppressed platform evidence",
		);
		expect(nativeCompile.run).toContain("--no-bundle -- --timings");
		expect(nativeCompile.run).toContain("cargo-timing.html");
		expect(nativeBundle.run).toContain("tauri bundle");
		expect(bundleVerify.run).toContain("verify:release-bundle");
		expect(bundleVerify.run).toContain(
			"--size installer-assets=release-work/transport/assets",
		);
		expect(
			dryRun.steps.find(
				(step: any) => step.name === "Smoke-test the production web bundle",
			),
		).toBeUndefined();
		expect(
			dryRun.steps.find(
				(step: any) =>
					step.name ===
					"Verify complete macOS ad-hoc bundle and runtime entitlement",
			),
		).toBeUndefined();
		expect(workflowText.match(/artifact:engine-runtime common/g)).toHaveLength(
			1,
		);
		expect(workflowText.match(/artifact:web build/g)).toHaveLength(1);
		expect(workflowText.match(/artifact:desktop-runtime common/g)).toHaveLength(
			1,
		);
		expect(workflowText.match(/artifact:desktop-runtime target/g)).toHaveLength(
			2,
		);
		expect(workflowText.match(/compose:desktop-resources/g)).toHaveLength(2);
		expect(workflowText).not.toContain("assemble:desktop:runtime");
		expect(workflowText.match(/bun run build:web/g) ?? []).toHaveLength(0);
		expect(
			workflowText.match(/Download Runtime common artifact/g),
		).toHaveLength(2);
		expect(
			workflowText.match(/Download (?:Engine|Web) common artifact/g) ?? [],
		).toHaveLength(0);
		expect(JSON.stringify(dryRun)).toContain("--size web-dist=dist");
		expect(JSON.stringify(dryRun)).toContain(
			"--size desktop-resources=src-tauri/resources",
		);
		expect(JSON.stringify(dryRun)).toContain("Upload platform stage metrics");
		expect(JSON.stringify(dryRun)).toContain("release-work/transport/");
	});

	test("runs the assembled desktop runtime smoke after resource composition and before Tauri build", () => {
		for (const jobName of ["desktop-dry-run", "desktop-publish"]) {
			const steps = workflow.jobs[jobName].steps;
			const composeIndex = steps.findIndex(
				(step: any) =>
					step.name === "Compose and validate immutable desktop resources",
			);
			const smokeIndex = steps.findIndex(
				(step: any) => step.name === "Smoke-test assembled desktop runtime",
			);
			const buildIndex = steps.findIndex((step: any) =>
				step.name.includes("installer"),
			);
			expect(composeIndex).toBeGreaterThanOrEqual(0);
			expect(smokeIndex).toBe(composeIndex + 1);
			expect(buildIndex).toBeGreaterThan(smokeIndex);
			expect(steps[smokeIndex]).toMatchObject({
				"timeout-minutes": SMOKE_WORKFLOW_TIMEOUT_MINUTES,
				shell: "bash",
				"working-directory": "forgeax-studio/packages/ide",
				run: "bun run smoke:desktop-runtime",
			});
			const workflowBudgetMs = steps[smokeIndex]["timeout-minutes"] * 60_000;
			expect(SMOKE_MAIN_BUDGET_MS).toBe(270_000);
			expect(SMOKE_CLEANUP_BUDGET_MS).toBe(50_000);
			expect(SMOKE_WORKFLOW_MARGIN_MS).toBe(30_000);
			expect(
				SMOKE_MAIN_BUDGET_MS +
					SMOKE_CLEANUP_BUDGET_MS +
					SMOKE_WORKFLOW_MARGIN_MS,
			).toBeLessThan(workflowBudgetMs);
		}
	});

	test("uses exact package, immutable Cargo inputs, and strictly keyed sccache without restoring stale release outputs", () => {
		const cacheAction =
			"actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9";
		const packageInputs = [
			"forgeax-studio/bun.lock",
			"forgeax-studio/packages/ide/.ci/web-source.bun.lock",
			"forgeax-studio/packages/editor/bun.lock",
			"forgeax-studio/packages/editor/packages/engine/bun.lock",
			"forgeax-studio/packages/editor/packages/engine/pnpm-lock.yaml",
		];
		for (const jobName of ["preflight", "desktop-dry-run", "desktop-publish"]) {
			const job = workflow.jobs[jobName];
			expect(job.env.BUN_INSTALL_CACHE_DIR).toBeUndefined();
			expect(job.env.npm_config_store_dir).toBe(
				"${{ github.workspace }}/.release-cache/pnpm",
			);
			expect(JSON.stringify(job.env)).not.toContain("${{ runner.");
			const cacheSteps = job.steps.filter(
				(step: any) => step.uses === cacheAction,
			);
			expect(cacheSteps).toHaveLength(jobName === "preflight" ? 1 : 2);
			for (const cache of cacheSteps)
				expect(cache.with["restore-keys"]).toBeUndefined();

			const packageCache = cacheSteps.find((step: any) =>
				step.name.includes("pnpm store"),
			);
			const packageCachePaths = packageCache.with.path.split("\n");
			expect(packageCachePaths).toContain("${{ env.npm_config_store_dir }}");
			expect(packageCache.with.key).toContain("ide-release-pnpm-v3-");
			expect(packageCache.with.path).not.toContain("BUN_INSTALL_CACHE_DIR");
			expect(packageCache.with.key).toContain("${{ runner.os }}");
			expect(packageCache.with.key).toContain(
				"pnpm-${{ steps.desktop-toolchain.outputs.pnpm }}",
			);
			for (const input of packageInputs)
				expect(packageCache.with.key).toContain(input);
			if (jobName === "preflight") {
				expect(packageCache.with.key).toContain("-common-");
			} else {
				expect(packageCache.with.key).toContain("${{ matrix.target }}");
				const cargoCache = cacheSteps.find((step: any) =>
					step.name.includes("Cargo inputs"),
				);
				expect(cargoCache.with.key).toContain(
					"${{ runner.os }}-${{ matrix.target }}",
				);
				expect(cargoCache.with.key).toContain(
					"${{ steps.rust-toolchain.outputs.cachekey }}",
				);
				expect(cargoCache.with.key).toContain("src-tauri/Cargo.lock");
				expect(cargoCache.with.path).toContain("~/.cargo/registry");
				expect(cargoCache.with.path).toContain("~/.cargo/git");
				expect(cargoCache.with.path).not.toContain("/release/.fingerprint");
				expect(cargoCache.with.path).not.toContain("/release/build");
				expect(cargoCache.with.path).not.toContain("/release/deps");
				expect(cargoCache.with.path).not.toContain("/release/bundle");
				expect(
					job.steps.find((step: any) => step.name === "Install Rust target").id,
				).toBe("rust-toolchain");
				const sccacheSetup = job.steps.find(
					(step: any) => step.name === "Install pinned sccache",
				);
				const sccacheConfig = job.steps.find(
					(step: any) => step.name === "Configure strictly keyed sccache",
				);
				expect(sccacheSetup.uses).toBe(
					"mozilla-actions/sccache-action@fc920bf0ec8de6ee65d409111f7ec508035751ba",
				);
				expect(sccacheSetup.with.version).toBe("v0.17.0");
				expect(sccacheConfig.env.RELEASE_TARGET).toBe("${{ matrix.target }}");
				expect(sccacheConfig.env.RUST_TOOLCHAIN_CACHE_KEY).toBe(
					"${{ steps.rust-toolchain.outputs.cachekey }}",
				);
				expect(sccacheConfig.env.SCCACHE_INPUT_HASH).toContain(
					"src-tauri/Cargo.lock",
				);
				expect(sccacheConfig.env.SCCACHE_INPUT_HASH).toContain(
					"src-tauri/src/**/*.rs",
				);
				expect(sccacheConfig.run).toContain("SCCACHE_GHA_ENABLED=true");
				expect(sccacheConfig.run).toContain("RUSTC_WRAPPER=%s");
				expect(sccacheConfig.run).toContain(
					"SCCACHE_GHA_VERSION=ide-release-sccache-v1-%s-%s-%s-%s",
				);
			}

			const materializeIndex = job.steps.findIndex((step: any) =>
				step.name.includes("Materialize integration workspace"),
			);
			const packageCacheIndex = job.steps.indexOf(packageCache);
			const installIndex = job.steps.findIndex(
				(step: any) => step.name === "Install release integration workspace",
			);
			expect(materializeIndex).toBeLessThan(packageCacheIndex);
			expect(packageCacheIndex).toBeLessThan(installIndex);
		}
		const dryCompile = workflow.jobs["desktop-dry-run"].steps.find(
			(step: any) => step.name === "Compile and link native binary",
		);
		expect(dryCompile.run).toContain('"$SCCACHE_PATH" --zero-stats');
		expect(dryCompile.run).toContain("--show-stats --stats-format=json");
		expect(dryCompile.run).toContain("sccache-stats.json");
	});

	test("pins every remote action and prevents checkout credential persistence", () => {
		const uses = [...workflowText.matchAll(/uses:\s*([^\s]+)/g)].map(
			(match) => match[1],
		);
		expect(uses.length).toBeGreaterThan(0);
		for (const use of uses) expect(use).toMatch(/@[0-9a-f]{40}$/);
		const checkouts = workflowText
			.split(/- name: /)
			.filter((block) => block.includes("actions/checkout@"));
		for (const checkout of checkouts)
			expect(checkout).toContain("persist-credentials: false");
		expect(workflowText).not.toContain("git config --global");
	});

	test("does not restore legacy owners and isolates external mutation to the publish script", () => {
		expect(workflowText).not.toContain("packages/studio");
		expect(workflowText).not.toContain("projectPath: packages/interface");
		expect(workflowText).toContain("forgeax-studio/packages/ide");
		expect(JSON.stringify(workflow.jobs["desktop-dry-run"])).not.toContain(
			"publish:release-candidate",
		);
		expect(JSON.stringify(workflow.jobs.candidate)).not.toContain(
			"publish:release-candidate",
		);
		expect(JSON.stringify(workflow.jobs.publish)).toContain(
			"publish:release-candidate",
		);
	});

	test("uses IDE tags only as immutable dispatch refs, never as automatic publication triggers", () => {
		expect(triggers.push).toBeUndefined();
	});
});
