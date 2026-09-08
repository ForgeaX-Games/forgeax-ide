import { describe, expect, it } from 'bun:test';
import valid from '../fixtures/release-source/registry-only.json';
import local from '../fixtures/release-source/local-sources.json';
import absolute from '../fixtures/release-source/absolute-path.json';
import { scanReleaseSources } from '../../scripts/check-release-sources';

describe('release source provenance gate', () => {
  it('accepts registry-backed product inputs', () => {
    expect(scanReleaseSources(valid)).toEqual({ valid: true, violations: [] });
  });

  it('rejects workspace, file, and development-link inputs', () => {
    const result = scanReleaseSources(local);
    expect(result.valid).toBe(false);
    expect(result.violations.map((violation) => violation.token)).toEqual(
      expect.arrayContaining(['workspace:', 'file:', 'source adapter', '/Users/']),
    );
  });

  it('rejects absolute paths in final bundle metadata', () => {
    expect(scanReleaseSources(absolute)).toMatchObject({ valid: false, violations: [{ token: '/private/' }] });
  });

  it('rejects lockfiles pinned to a non-canonical npm tarball mirror', () => {
    const result = scanReleaseSources({
      ...valid,
      lockText: 'https://registry.npmjs.org/react/-/react-19.1.1.tgz',
    });

    expect(result).toMatchObject({
      valid: false,
      violations: [{ token: 'non-canonical npm tarball', field: 'lockText' }],
    });
  });
});
