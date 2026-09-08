import { describe, expect, test } from 'bun:test';
import { canonicalizeOrchestrationId, resolveReleaseContext, validateTrustedSidecarUrl } from '../../scripts/resolve-release-context';

const base = {
  EVENT_NAME: 'workflow_dispatch', REQUESTED_VERSION: '0.1.0', REQUESTED_IDE_REVISION: 'a'.repeat(40),
  ACTUAL_IDE_REVISION: 'a'.repeat(40), REQUESTED_INTEGRATION_REVISION: 'b'.repeat(40), REQUESTED_REVISION_BRANCH: 'main', REQUESTED_SIDECAR_URL: 'https://github.com/ForgeaX-Games/forgeax-server/releases/download/server-v0.1.0/candidate.json',
  REQUESTED_SIDECAR_SHA256: 'c'.repeat(64), REQUESTED_INTENT: 'dry-run', REQUESTED_ORCHESTRATION_ID: 'studio-20260901', WORKFLOW_DEFINITION_REVISION: 'd'.repeat(40),
};

describe('public IDE orchestration context', () => {
  test('canonicalizes the Studio correlation ID and derives stable transport names', () => {
    expect(canonicalizeOrchestrationId('studio-20260901')).toBe('studio-20260901');
    const context = resolveReleaseContext(base);
    expect(context).toMatchObject({ orchestrationId: 'studio-20260901', candidateArtifactName: 'ide-release-candidate-studio-20260901', assetsArtifactName: 'ide-release-assets-studio-20260901', targetTag: 'v0.1.0' });
  });

  test('rejects shell/output/control injection and noncanonical IDs', () => {
    for (const value of ['UPPER', ' leading', 'trailing ', 'two--hyphens', '-leading', 'trailing-', 'a\nname=pwned', 'a/b', 'a'.repeat(65)]) {
      expect(() => canonicalizeOrchestrationId(value)).toThrow();
    }
  });

  test('rejects revision, mode, digest, and URL drift before outputs are emitted', () => {
    for (const changed of [
      { REQUESTED_IDE_REVISION: 'main' }, { REQUESTED_INTENT: 'passed' }, { REQUESTED_SIDECAR_SHA256: 'x'.repeat(64) },
      { REQUESTED_SIDECAR_URL: 'https://127.0.0.1/private/candidate.json' }, { REQUESTED_VERSION: '0.1' }, { REQUESTED_REVISION_BRANCH: 'feature' },
    ]) expect(() => resolveReleaseContext({ ...base, ...changed })).toThrow();
  });

  test('keeps ide-v tag resolution fail-closed while immutable tag inputs are incomplete', () => {
    expect(() => resolveReleaseContext({ EVENT_NAME: 'push', REF_NAME: 'ide-v0.1.0', ACTUAL_IDE_REVISION: 'a'.repeat(40), WORKFLOW_DEFINITION_REVISION: 'd'.repeat(40) })).toThrow();
  });

  test('accepts only the exact trusted manifest owner/path/version contract', () => {
    const url = base.REQUESTED_SIDECAR_URL;
    expect(validateTrustedSidecarUrl(url)).toBe(url);
    expect(() => validateTrustedSidecarUrl(url.replace('ForgeaX-Games', 'attacker'))).toThrow();
    expect(() => validateTrustedSidecarUrl(url.replace('server-v0.1.0', 'latest'))).toThrow();
  });
});
