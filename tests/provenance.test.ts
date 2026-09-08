import { describe, expect, it } from 'bun:test';
import valid from './fixtures/provenance-valid.json';
import invalid from './fixtures/provenance-invalid.json';

type Provenance = { sources: { sourceRepo: string; sourceCommit: string }[]; mappings: { sourceRepo: string; sourceCommit: string; newPath: string; owner: string }[] };

function validate(provenance: Provenance): string[] {
  const errors: string[] = [];
  const commits = new Map(provenance.sources.map((source) => [source.sourceRepo, source.sourceCommit]));
  const paths = new Set<string>();
  for (const source of provenance.sources) {
    if (!/^[0-9a-f]{40}$/.test(source.sourceCommit)) errors.push(`${source.sourceRepo}:invalid-commit`);
  }
  for (const mapping of provenance.mappings) {
    if (!mapping.owner) errors.push(`${mapping.newPath}:missing-owner`);
    if (paths.has(mapping.newPath)) errors.push(`${mapping.newPath}:duplicate-path`);
    paths.add(mapping.newPath);
    if (commits.get(mapping.sourceRepo) !== mapping.sourceCommit) errors.push(`${mapping.newPath}:commit-mismatch`);
  }
  return errors;
}

describe('IDE provenance', () => {
  it('keeps source commit and destination path traceability', () => {
    expect(validate(valid)).toEqual([]);
  });

  it('rejects missing refs, duplicate paths, and owner gaps', () => {
    const errors = validate(invalid);
    expect(errors).toEqual(expect.arrayContaining(['forgeax-studio:invalid-commit', 'src/main.tsx:duplicate-path', 'src/main.tsx:missing-owner', 'src/main.tsx:commit-mismatch']));
  });
});
