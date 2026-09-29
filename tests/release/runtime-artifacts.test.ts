import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { submoduleRevision } from "../../scripts/release-artifact-identity";
import {
	runtimeArtifactBuildScriptInputs,
	runtimeArtifactBuildScriptPaths,
	sharpNativePackageNames,
	stageGameCreationResources,
} from "../../scripts/runtime-artifacts";
import {
	expectCodeContains,
	expectCodeNotContains,
} from "../helpers/code-token-assertions";

const harnessFixture = vi.hoisted(() => ({
	revision: "b".repeat(40),
	read: vi.fn((path: string) => ({
		bytes: Buffer.from(`Fixture documentation: ${path}\n`),
		mode: 0o644,
	})),
}));

// Exercise real resource composition without making the unit suite depend on
// GitHub latency or credentials. The reader has separate local-Git tests.
vi.mock("../../scripts/engine-harness-documents", () => ({
	engineHarnessDocuments: () => harnessFixture,
}));

const artifactsSource = readFileSync(
	join(import.meta.dirname, "../../scripts/runtime-artifacts.ts"),
	"utf8",
);
const sidecarSource = readFileSync(
	join(import.meta.dirname, "../../scripts/stage-release-sidecar.ts"),
	"utf8",
);

function localImportClosure(entrypoints: string[]): string[] {
	const scriptsRoot = join(import.meta.dirname, "../../scripts");
	const seen = new Set<string>();
	const visit = (path: string): void => {
		const absolute = join(scriptsRoot, path);
		if (seen.has(path)) return;
		seen.add(path);
		const source = readFileSync(absolute, "utf8");
		for (const match of source.matchAll(
			/(?:from|import)\s*['"](\.[^'"]+)['"]/g,
		)) {
			const specifier = match[1]!;
			if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
			const imported = specifier.endsWith(".ts")
				? specifier
				: `${specifier}.ts`;
			const resolved = relative(
				scriptsRoot,
				join(dirname(absolute), imported),
			).replaceAll("\\", "/");
			visit(resolved);
		}
	};
	entrypoints.forEach(visit);
	return [...seen].sort().map((path) => `scripts/${path}`);
}

describe("Desktop Runtime artifact split", () => {
	test("hashes the exact local source closure for both common runtime bundles", () => {
		expect(runtimeArtifactBuildScriptPaths("common")).toEqual([
			"product/engine-harness-input.json",
			"scripts/bundle-desktop-orchestrator-kits.ts",
			"scripts/desktop-engine.ts",
			"scripts/desktop-environment.ts",
			"scripts/desktop-pipe.ts",
			"scripts/desktop-ports.ts",
			"scripts/desktop-process-tree.ts",
			"scripts/desktop-runtime-layout.ts",
			"scripts/desktop-runtime.ts",
			"scripts/desktop-windows-job.ts",
			"scripts/engine-harness-documents.ts",
			"scripts/forgeax-core-serve-entry.ts",
			"scripts/runtime-artifacts.ts",
			"scripts/server-native-preload.ts",
			"scripts/server-runtime-assets.ts",
			"scripts/stage-engine-project-skills.ts",
		]);
		expect(runtimeArtifactBuildScriptPaths("target")).toEqual([
			"scripts/desktop-platforms.ts",
			"scripts/executable-identity.ts",
			"scripts/runtime-artifacts.ts",
			"src-tauri/Cargo.lock",
			"src-tauri/Cargo.toml",
			"src-tauri/build.rs",
			"src-tauri/src/bin/runtime-guardian.rs",
		]);
		expect(runtimeArtifactBuildScriptPaths("target", "windows-x64")).toEqual([
			"scripts/desktop-platforms.ts",
			"scripts/executable-identity.ts",
			"scripts/runtime-artifacts.ts",
		]);
		// Dependency PRs replace gitlinks intentionally. Hashing the script closure
		// is independent of admitting those checkouts as a desktop release.
		const buildScripts = runtimeArtifactBuildScriptInputs("common");
		expect(buildScripts.map((entry) => entry.path)).toEqual(
			runtimeArtifactBuildScriptPaths("common"),
		);
		expect(
			buildScripts.every((entry) => /^[0-9a-f]{64}$/.test(entry.sha256)),
		).toBe(true);
		expect(
			runtimeArtifactBuildScriptPaths("common").filter(
				(path) =>
					path !== "scripts/runtime-artifacts.ts" &&
					path !== "scripts/engine-harness-documents.ts" &&
					path !== "product/engine-harness-input.json" &&
					path !== "scripts/stage-engine-project-skills.ts",
			),
		).toEqual(
			localImportClosure([
				"desktop-runtime.ts",
				"server-native-preload.ts",
				"forgeax-core-serve-entry.ts",
				"bundle-desktop-orchestrator-kits.ts",
			]),
		);
	});

	test("uses canonical unique path order for source build manifests on every platform", () => {
		for (const platform of [
			"macos-arm64",
			"macos-x64",
			"windows-x64",
			"linux-x64",
		] as const) {
			const paths = runtimeArtifactBuildScriptPaths("target", platform, true);
			expect(paths[0]).toBe(".ci/desktop-build-inputs.json");
			expect(paths).toContain("scripts/build-source-sidecar.ts");
			expect(paths).toContain("scripts/server-playwright-runtime.ts");
			for (const path of localImportClosure(["server-native-preload.ts"]))
				expect(paths).toContain(path);
			expect(
				paths.every((path, index) => index === 0 || paths[index - 1]! < path),
			).toBe(true);
		}
	});

	test("builds one portable common payload from the verified Web and Engine inputs", () => {
		expectCodeContains(artifactsSource, "'ide-desktop-runtime-common/v1'");
		expectCodeContains(
			artifactsSource,
			"materializeWebArtifact(webCommon, join(payload, 'interface/dist'))",
		);
		expectCodeContains(
			artifactsSource,
			"composeEngineCommonArtifacts(engineCommon, engine)",
		);
		expectCodeContains(artifactsSource, "'runtime/local-runtime.mjs'");
		expectCodeContains(artifactsSource, "'server-runtime/agent-host.mjs'");
		expectCodeContains(
			artifactsSource,
			"normalizePortableArtifactFiles(payload)",
		);
		expectCodeContains(artifactsSource, "runtimeArtifactDescriptor('common')");
	});

	test("keeps native Engine, Bun, Server, and Sharp resources in the target artifact", () => {
		expectCodeContains(artifactsSource, "'ide-desktop-runtime-target/v1'");
		expectCodeContains(
			artifactsSource,
			"composeEngineTargetArtifact(engineTarget, platform, engine)",
		);
		expectCodeContains(
			artifactsSource,
			"copyVerifiedExecutable(process.execPath, bunSidecar, platform)",
		);
		expectCodeContains(artifactsSource, "'server-candidate-manifest-sha256'");
		expectCodeContains(
			artifactsSource,
			"runtimeArtifactDescriptor('target', platform, context)",
		);
		expect(
			sharpNativePackageNames(
				{
					"@img/sharp-darwin-arm64": "1",
					"@img/sharp-libvips-darwin-arm64": "1",
					"@img/sharp-darwin-x64": "1",
					"@img/sharp-win32-x64": "1",
				},
				"macos-arm64",
			),
		).toEqual(["@img/sharp-darwin-arm64", "@img/sharp-libvips-darwin-arm64"]);
	});

	test("stages the verified Server candidate outside final Tauri resources", () => {
		expectCodeContains(sidecarSource, "value('--output')");
		expectCodeNotContains(sidecarSource, "'../src-tauri/resources/sidecars'");
	});
});

describe("packaged game creation resources", () => {
	const roots: string[] = [];
	afterEach(() => {
		harnessFixture.read.mockClear();
		for (const root of roots.splice(0))
			rmSync(root, { recursive: true, force: true });
	});

	function fixture(): string {
		const payload = mkdtempSync(join(tmpdir(), "ide-game-resources-"));
		roots.push(payload);
		const catalog = join(payload, "editor/apps/standalone/template-catalog.ts");
		mkdirSync(dirname(catalog), { recursive: true });
		writeFileSync(catalog, "export const templates = [];\n");
		for (const name of ["empty", "game-3d"]) {
			cpSync(
				join(
					import.meta.dirname,
					"../../../editor/packages/engine/templates",
					name,
				),
				join(payload, "editor/packages/engine/templates", name),
				{ recursive: true },
			);
		}
		return payload;
	}

	test("stages real schema 2.0 templates with offline harness document inputs", () => {
		const payload = fixture();
		const required = stageGameCreationResources(payload);

		for (const path of [
			"product/asset-library/worker.js",
			"product/asset-library/provenance.json",
			"editor/apps/standalone/template-catalog.ts",
			"server/templates/game-minimal/forge.json",
			"server/templates/game-minimal/main.ts",
			"editor/packages/engine/templates/empty/forge.json",
			"editor/packages/engine/templates/game-3d/forge.json",
			"editor/packages/engine/engine-skills-version.json",
			"editor/packages/engine/skills/forgeax-engine-sdk/SKILL.md",
		])
			expect(required).toContain(path);
		expect(
			JSON.parse(
				readFileSync(
					join(payload, "editor/packages/engine/engine-skills-version.json"),
					"utf8",
				),
			).engineCommit,
		).toBe(
			submoduleRevision(
				join(import.meta.dirname, "../../../editor"),
				"packages/engine",
			),
		);
		for (const path of required)
			expect(existsSync(join(payload, path))).toBe(true);
		expect(harnessFixture.read).toHaveBeenCalled();
		for (const [path] of harnessFixture.read.mock.calls) {
			const staged = `editor/packages/engine/.forgeax-harness/${path}`;
			expect(required).toContain(staged);
			expect(readFileSync(join(payload, staged), "utf8")).toBe(
				`Fixture documentation: ${path}\n`,
			);
		}
		expect(
			JSON.parse(
				readFileSync(
					join(payload, "editor/packages/engine/engine-skills-version.json"),
					"utf8",
				),
			).harnessCommit,
		).toBe(harnessFixture.revision);
		for (const name of ["empty", "game-3d"]) {
			const manifest = JSON.parse(
				readFileSync(
					join(payload, "editor/packages/engine/templates", name, "forge.json"),
					"utf8",
				),
			);
			expect(manifest.schemaVersion).toBe("2.0.0");
			expect(manifest.entry).toBeUndefined();
		}
	});

	test("rejects a composed template whose manifest is missing", () => {
		const payload = fixture();
		rmSync(join(payload, "editor/packages/engine/templates/empty/forge.json"));

		expect(() => stageGameCreationResources(payload)).toThrow(
			"packaged game template is incomplete: editor/packages/engine/templates/empty/forge.json",
		);
	});

	test("rejects an empty composed template set", () => {
		const payload = fixture();
		const templates = join(payload, "editor/packages/engine/templates");
		rmSync(templates, { recursive: true });
		mkdirSync(templates);

		expect(() => stageGameCreationResources(payload)).toThrow(
			"no engine game templates were staged",
		);
	});
});
