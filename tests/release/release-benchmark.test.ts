import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRunRecord, distribution, summarizeRuns, type BenchmarkRunRecord, type ReleaseStageRecord } from '../../scripts/release-benchmark';
import { aggregateCandidate, type PlatformRecord } from '../../scripts/release-candidate';
import type { ReleaseContext } from '../../scripts/resolve-release-context';
import transport from '../../release/transport-contract.v1.json';

const definitionRevision = 'd'.repeat(40);
const baseContext: ReleaseContext = {
  orchestrationId: 'issue7-baseline-1', version: '1.2.3', ideRevision: 'a'.repeat(40), integrationRevision: 'b'.repeat(40), revisionBranch: 'main',
  sidecarManifestUrl: 'https://github.com/ForgeaX-Games/forgeax-server/releases/download/server-v0.1.0/candidate.json', sidecarManifestSha256: 'c'.repeat(64),
  mode: 'dry-run', targetTag: 'v1.2.3', serviceVersion: '0.1.0', candidateArtifactName: 'ide-release-candidate-issue7-baseline-1',
  assetsArtifactName: 'ide-release-assets-issue7-baseline-1', workflowDefinitionRevision: definitionRevision,
};

function records(): PlatformRecord[] {
  return transport.platforms.map((platform) => ({
    logicalId: platform.logicalId, targetTriple: platform.targetTriple, trust: 'suppressed-not-applicable',
    artifacts: platform.installerRoster.map((artifact, index) => ({ logicalId: artifact.logicalId, fileName: `${artifact.logicalId}.${index}`, mediaType: artifact.mediaType, sha256: `${index + 1}`.repeat(64).slice(0, 64), size: 100 + index })),
    evidence: [{ logicalId: `${platform.logicalId}-evidence`, fileName: `${platform.logicalId}.json`, mediaType: 'application/json', sha256: 'e'.repeat(64), size: 20 }],
  }));
}

function stage(platform: string, name: string, durationMs: number): ReleaseStageRecord {
  return { schema: 'forgeax-ide-release-stage/v1', stage: name, platform, targetTriple: platform === 'common' ? null : 'x86_64-test', durationMs, exitCode: 0, outputs: [] };
}

function runRecord(runId: number, scale = 1): BenchmarkRunRecord {
  process.env.GITHUB_RUN_ID = String(runId); process.env.GITHUB_RUN_ATTEMPT = '1';
  const context = { ...baseContext, orchestrationId: `issue7-baseline-${runId}` };
  const candidate = aggregateCandidate(context, records());
  return buildRunRecord({
    repository: 'ForgeaX-Games/forgeax-ide',
    run: { id: runId, run_attempt: 1, html_url: `https://github.com/ForgeaX-Games/forgeax-ide/actions/runs/${runId}`, head_sha: definitionRevision, event: 'workflow_dispatch', conclusion: 'success' },
    jobs: [
      { name: 'preflight', conclusion: 'success', started_at: '2026-09-01T00:00:00Z', completed_at: `2026-09-01T00:00:0${scale}Z`, labels: ['ubuntu-latest'], steps: [{ name: 'Install release integration workspace', conclusion: 'success', started_at: '2026-09-01T00:00:00Z', completed_at: '2026-09-01T00:00:01Z' }] },
      { name: 'desktop-dry-run (macos-x64)', conclusion: 'success', started_at: '2026-09-01T00:00:00Z', completed_at: `2026-09-01T00:00:0${scale + 2}Z`, labels: ['macos-15-intel'], steps: [{ name: 'Build native binary', conclusion: 'success', started_at: '2026-09-01T00:00:01Z', completed_at: '2026-09-01T00:00:02Z' }] },
    ],
    artifacts: [
      { id: 1, name: `ide-release-metrics-${runId}`, size_in_bytes: 1000 * scale, expired: false },
      { id: 2, name: `ide-release-assets-${runId}`, size_in_bytes: 5000 * scale, expired: false },
    ],
    context, candidate,
    stages: [stage('common', 'web-build', 100 * scale), stage('macos-x64', 'cargo-build', 400 * scale)],
  });
}

beforeEach(() => { delete process.env.GITHUB_RUN_ID; delete process.env.GITHUB_RUN_ATTEMPT; });

describe('release benchmark evidence', () => {
  test('defines closed run and summary schemas rooted in the release contract', () => {
    const runSchema = JSON.parse(readFileSync(join(import.meta.dir, '../../release/schemas/benchmark-run.v1.schema.json'), 'utf8'));
    const summarySchema = JSON.parse(readFileSync(join(import.meta.dir, '../../release/schemas/benchmark-summary.v1.schema.json'), 'utf8'));
    expect(runSchema.additionalProperties).toBe(false);
    expect(runSchema.properties.identity.$ref).toBe('#/$defs/identity');
    expect(runSchema.$defs.identity.properties.mode.const).toBe('dry-run');
    expect(summarySchema.additionalProperties).toBe(false);
    expect(summarySchema.properties.sampleSize.minimum).toBe(3);
    expect(summarySchema.$defs.distribution.required).toEqual(['values', 'min', 'median', 'max', 'rangePercent']);
  });

  test('collects candidate-bound wall-clock, runner, stage, artifact, and installer evidence', () => {
    const run = runRecord(101, 3);
    expect(run).toMatchObject({ schema: 'forgeax-ide-release-benchmark-run/v1', wallClockMs: 5000, runnerTotalMs: 8000 });
    expect(run.source).toMatchObject({ runId: 101, runAttempt: 1, headSha: definitionRevision });
    expect(run.stages.map((item) => `${item.platform}/${item.stage}`)).toEqual(['common/web-build', 'macos-x64/cargo-build']);
    expect(run.artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0)).toBe(18000);
    expect(run.installerBytes).toBeGreaterThan(0);
  });

  test('summarizes at least three identical-input runs with transparent hosted-runner variance', () => {
    const summary = summarizeRuns('baseline', [runRecord(101, 1), runRecord(102, 2), runRecord(103, 3)]);
    expect(summary.sampleSize).toBe(3);
    expect(summary.metrics.wallClockMs).toEqual({ values: [3000, 4000, 5000], min: 3000, median: 4000, max: 5000, rangePercent: 50 });
    expect(summary.metrics.stages['macos-x64/cargo-build'].median).toBe(800);
    expect(summary.interpretation.hostedRunnerVariance).toContain('do not infer deterministic gains from a single run');
  });

  test('rejects too few samples, duplicate runs, input drift, runner drift, and unsuccessful stages', () => {
    const first = runRecord(101, 1); const second = runRecord(102, 2); const third = runRecord(103, 3);
    expect(() => summarizeRuns('baseline', [first, second])).toThrow('at least three');
    expect(() => summarizeRuns('baseline', [first, first, third])).toThrow('unique');
    expect(() => summarizeRuns('baseline', [first, { ...second, identity: { ...second.identity, integrationRevision: 'f'.repeat(40) } }, third])).toThrow('inputs differ');
    const changedRunner = structuredClone(second); changedRunner.jobs[0].runnerLabels = ['ubuntu-24.04'];
    expect(() => summarizeRuns('baseline', [first, changedRunner, third])).toThrow('runner labels differ');
    process.env.GITHUB_RUN_ID = '999'; process.env.GITHUB_RUN_ATTEMPT = '1';
    expect(() => buildRunRecord({
      repository: 'attacker/example', run: { id: 999, run_attempt: 1, html_url: 'https://example.test', head_sha: definitionRevision, event: 'workflow_dispatch', conclusion: 'success' },
      jobs: [], artifacts: [], context: baseContext, candidate: aggregateCandidate(baseContext, records()), stages: [stage('common', 'web-build', 1)],
    })).toThrow('repository must be');
    expect(() => buildRunRecord({
      repository: 'ForgeaX-Games/forgeax-ide', run: { id: 999, run_attempt: 1, html_url: 'https://example.test', head_sha: definitionRevision, event: 'workflow_dispatch', conclusion: 'success' },
      jobs: [], artifacts: [], context: baseContext, candidate: aggregateCandidate(baseContext, records()), stages: [stage('common', 'web-build', 0)],
    })).toThrow();
  });

  test('computes even medians without hiding spread', () => {
    expect(distribution([40, 10, 30, 20])).toEqual({ values: [10, 20, 30, 40], min: 10, median: 25, max: 40, rangePercent: 120 });
  });
});
