import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const baseline = JSON.parse(readFileSync(join(import.meta.dir, '../../release/baselines/ide-release-33566394641.json'), 'utf8')) as any;
const measuredBaseline = JSON.parse(readFileSync(join(import.meta.dir, '../../release/baselines/ide-release-33622205397.json'), 'utf8')) as any;
const schema = JSON.parse(readFileSync(join(import.meta.dir, '../../release/runtime-artifact-manifest.v1.schema.json'), 'utf8')) as any;
const desktopSchema = JSON.parse(readFileSync(join(import.meta.dir, '../../release/desktop-runtime-manifest.v2.schema.json'), 'utf8')) as any;
const ownership = JSON.parse(readFileSync(join(import.meta.dir, '../../release/runtime-resource-ownership.v1.json'), 'utf8')) as any;

describe('modular desktop release evidence', () => {
  test('preserves a reproducible measured baseline without inventing unavailable metrics', () => {
    expect(baseline.schema).toBe('forgeax-ide-release-baseline/v1');
    expect(baseline.source).toMatchObject({ runId: 33566394641, intent: 'dry-run' });
    expect(baseline.webBuilds.count).toBe(7);
    expect(baseline.webBuilds.executions).toHaveLength(7);
    expect(baseline.webBuilds.executions.reduce((sum: number, item: any) => sum + item.seconds, 0)).toBeCloseTo(baseline.webBuilds.totalViteSeconds, 5);
    expect(baseline.jobs.reduce((sum: number, job: any) => sum + job.totalSeconds, 0)).toBe(baseline.totals.platformJobSeconds);
    expect(baseline.jobs.reduce((sum: number, job: any) => sum + job.artifactTransferBytes, 0)).toBe(baseline.totals.platformArtifactTransferBytes);
    expect(baseline.jobs.flatMap((job: any) => job.installers).reduce((sum: number, installer: any) => sum + installer.bytes, 0)).toBe(baseline.totals.installerBytes);
    expect(baseline.unavailable.map((item: any) => item.metric)).toEqual(['intermediate-directory-bytes', 'engine-prepare-seconds']);
  });

  test('records the successful instrumented three-platform baseline', () => {
    expect(measuredBaseline.source).toMatchObject({
      runId: 33622205397,
      ideRevision: '0c5ecc11cff8f54d8f7c5cefd47d5bc0ff321e6f',
      intent: 'dry-run',
      conclusion: 'success',
    });
    expect(measuredBaseline.jobs).toHaveLength(3);
    expect(measuredBaseline.jobs.every((job: any) => Object.values(job.stages).every((duration) => Number(duration) > 0))).toBe(true);
    expect(measuredBaseline.jobs.every((job: any) => job.outputs.desktopResources.bytes > 0 && job.outputs.tauriBundle.bytes > 0)).toBe(true);
    expect(measuredBaseline.jobs.reduce((sum: number, job: any) => sum + job.totalSeconds, 0)).toBe(measuredBaseline.totals.platformJobSeconds);
    expect(measuredBaseline.jobs.reduce((sum: number, job: any) => sum + job.artifactTransferBytes, 0)).toBe(measuredBaseline.totals.platformArtifactTransferBytes);
    expect(measuredBaseline.jobs.flatMap((job: any) => job.installers).reduce((sum: number, installer: any) => sum + installer.bytes, 0)).toBe(measuredBaseline.totals.installerBytes);
    expect(measuredBaseline.unavailable).toEqual([]);
  });

  test('publishes a recursively closed manifest shape contract', () => {
    expect(schema.$id).toContain('runtime-artifact-manifest.v1.schema.json');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.producer.additionalProperties).toBe(false);
    expect(schema.properties.inputs.additionalProperties).toBe(false);
    expect(schema.properties.files.items.additionalProperties).toBe(false);
    expect(schema.$defs.identityFiles.items.additionalProperties).toBe(false);
    expect(schema.required).toContain('digest');
    expect(schema.properties.algorithm.const).toBe('sha256');
    expect(desktopSchema.$id).toContain('desktop-runtime-manifest.v2.schema.json');
    expect(desktopSchema.additionalProperties).toBe(false);
    expect(desktopSchema.properties.inputs.additionalProperties).toBe(false);
    expect(desktopSchema.$defs.file.additionalProperties).toBe(false);
    expect(desktopSchema.properties.schema.const).toBe('forgeax-ide-desktop-runtime/v2');
  });

  test('inventories current ownership and makes missing contracts explicit', () => {
    expect(ownership.schema).toBe('forgeax-ide-runtime-resource-ownership/v1');
    expect(ownership.assembly).toMatchObject({
      commonArtifact: 'ide-desktop-runtime-common/v1',
      targetArtifact: 'ide-desktop-runtime-target/v1',
      commonFrequency: 'once-per-run',
      targetFrequency: 'once-per-platform',
    });
    const ids = ownership.entries.map((entry: any) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ownership.entries.every((entry: any) => ['common', 'target'].includes(entry.scope))).toBe(true);
    expect(ownership.entries.every((entry: any) => /\/v1$/.test(entry.targetArtifact))).toBe(true);
    expect(ownership.entries.find((entry: any) => entry.id === 'brand-and-personas')).toMatchObject({ status: 'missing-contract', source: null });
    expect(ownership.entries.find((entry: any) => entry.id === 'engine-javascript-dependency-closure').scope).toBe('target');
  });
});
