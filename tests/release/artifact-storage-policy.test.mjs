import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "vitest";

const release = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
const cleanup = readFileSync(
	resolve(".github/workflows/actions-artifact-cleanup.yml"),
	"utf8",
);

test("release artifacts are transient except for the tiny completion record", () => {
	const retentionDays = [...release.matchAll(/retention-days: (\d+)/g)].map(
		(match) => Number(match[1]),
	);
	assert.deepEqual(retentionDays, [1, 1, 1, 1, 1, 1, 1, 1, 14]);
	assert.equal(
		(
			release.match(
				/if: needs\.resolve\.outputs\.revision_branch == 'main'/g,
			) ?? []
		).length,
		5,
	);
	assert.match(
		release,
		/group: ide-release-\$\{\{ inputs\.version \}\}-\$\{\{ inputs\.intent \}\}/,
	);
	assert.match(
		release,
		/cancel-in-progress: \$\{\{ inputs\.intent != 'publish' \}\}/,
	);
});

test("failed and cancelled producer runs have an artifact cleanup backstop", () => {
	assert.match(cleanup, /workflow_run:/);
	assert.match(cleanup, /workflows:\n\s+- IDE Release/);
	assert.doesNotMatch(cleanup, /- IDE CI/);
	assert.doesNotMatch(cleanup, /- IDE Desktop/);
	assert.match(
		cleanup,
		/if: github\.event\.workflow_run\.conclusion != 'success'/,
	);
	assert.match(cleanup, /actions: write/);
	assert.match(
		cleanup,
		/SOURCE_RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}/,
	);
	assert.match(cleanup, /--run-id "\$SOURCE_RUN_ID"/);
});

test("successful candidate runs delete fan-out copies while preserving consumers", () => {
	assert.match(release, /cleanup-candidate-transient-artifacts:/);
	assert.match(
		release,
		/if: always\(\) && needs\.candidate\.result == 'success'/,
	);
	assert.match(
		release,
		/--preserve-name "ide-release-candidate-\$ORCHESTRATION_ID"/,
	);
	assert.match(
		release,
		/--preserve-name "ide-release-assets-\$ORCHESTRATION_ID"/,
	);
	assert.match(
		release,
		/--preserve-name "ide-release-completion-\$ORCHESTRATION_ID"/,
	);
	assert.match(
		release,
		/RELEASE_MODE: \$\{\{ needs\.resolve\.outputs\.mode \}\}/,
	);
	assert.match(
		release,
		/release-benchmark collects these four small JSON artifacts/,
	);
	assert.match(release, /metrics-\$ORCHESTRATION_ID-\$logical_id/);
	assert.match(release, /metrics\/\*\*\/\*\.json/);
	assert.match(
		release,
		/Upload preflight stage metrics\n\s+# release-benchmark consumes metrics from dry-runs only[\s\S]*?if: needs\.resolve\.outputs\.mode == 'dry-run'/,
	);
	assert.match(
		release,
		/Upload platform stage metrics\n\s+# Keep benchmark inputs for dry-runs; publish has no metrics consumer\.[\s\S]*?if: needs\.resolve\.outputs\.mode == 'dry-run'/,
	);
	assert.doesNotMatch(release, /cp "\$timing_source"/);
});
