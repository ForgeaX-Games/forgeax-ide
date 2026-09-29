import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export const BUN_TEST_FILES = [
	"tests/ci-harness-sync.test.ts",
	"tests/desktop-runtime-failure.test.ts",
	"tests/desktop-runtime-status.test.ts",
	"tests/desktop-startup.test.ts",
	"tests/desktop-template-dependencies.test.ts",
	"tests/product-agent-roster.test.ts",
	"tests/release/avatar-media.test.ts",
	"tests/release/bgm-package.test.ts",
	"tests/release/desktop-engine-dependencies.test.ts",
	"tests/release/desktop-engine-workspace.test.ts",
	"tests/release/desktop-orchestrator-kits.test.ts",
	"tests/release/desktop-runtime-controller.test.ts",
	"tests/release/engine-harness-documents.test.ts",
	"tests/release/package-desktop-local.test.ts",
	"tests/release/product-test-scope.test.ts",
	"tests/release/server-runtime-assets.test.ts",
	"tests/release/stage-engine-project-skills.test.ts",
	"tests/release/video-game-package.test.ts",
	"tests/server-native-preload-compiled.test.ts",
	"tests/studio-viewport-selection.test.ts",
] as const;

if (import.meta.main) {
	const result = spawnSync(process.execPath, ["test", ...BUN_TEST_FILES], {
		cwd: resolve(import.meta.dirname, ".."),
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
}
