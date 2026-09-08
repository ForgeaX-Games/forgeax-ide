import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';

type Source = { sourceRepo: string; remote: string; ref: string; commit: string; scope: string };
type Mapping = { sourceRepo: string; sourceCommit: string; oldPath: string; newPath: string; owner: string };

const root = join(import.meta.dir, '..');
const refs = JSON.parse(readFileSync(join(root, 'provenance/candidate-source-refs.json'), 'utf8')) as { sources: Source[] };
const mappings = JSON.parse(readFileSync(join(root, 'provenance/path-mapping.json'), 'utf8')) as { mappings: Mapping[] };
const digests = JSON.parse(readFileSync(join(root, 'provenance/candidate-tree-digests.json'), 'utf8')) as { sources: { sourceRepo: string; sourceCommit: string; tree: string }[] };
const mode = Bun.argv.includes('--merged') ? 'merged' : Bun.argv.includes('--normalized') ? 'normalized' : Bun.argv.includes('--main') ? 'main' : 'candidate';

function fail(message: string): never {
  console.error(JSON.stringify({ code: 'IDE_PROVENANCE_INVALID', phase: 'provenance', message, mode }));
  process.exit(1);
}

function validateShape() {
  const seen = new Set<string>();
  for (const source of refs.sources) {
    if (!/^[0-9a-f]{40}$/.test(source.commit)) fail(`invalid source commit for ${source.sourceRepo}`);
    if (seen.has(source.sourceRepo)) fail(`duplicate source repo ${source.sourceRepo}`);
    seen.add(source.sourceRepo);
  }
  for (const mapping of mappings.mappings) {
    if (!mapping.owner || !mapping.oldPath || !mapping.newPath) fail('mapping requires owner and paths');
    if (seen.has(`path:${mapping.newPath}`)) fail(`duplicate destination path ${mapping.newPath}`);
    seen.add(`path:${mapping.newPath}`);
    const source = refs.sources.find((item) => item.sourceRepo === mapping.sourceRepo);
    if (!source || source.commit !== mapping.sourceCommit) fail(`mapping commit mismatch for ${mapping.newPath}`);
  }
  for (const digest of digests.sources) {
    const source = refs.sources.find((item) => item.sourceRepo === digest.sourceRepo);
    if (!source || source.commit !== digest.sourceCommit || !/^[0-9a-f]{40}$/.test(digest.tree)) fail(`tree digest mismatch for ${digest.sourceRepo}`);
  }
}

async function verifySourceObjects() {
  const sourceDirs = { 'forgeax-studio': process.env.FORGEAX_STUDIO_SOURCE, 'forgeax-interface': process.env.FORGEAX_INTERFACE_SOURCE } as Record<string, string | undefined>;
  for (const source of refs.sources) {
    const dir = sourceDirs[source.sourceRepo];
    if (!dir) continue;
    if (!existsSync(join(dir, '.git'))) fail(`source checkout is missing or not a repository: ${source.sourceRepo}`);
    const status = await $`git -c diff.ignoreSubmodules=all -C ${dir} status --porcelain`.text();
    if (status.trim()) fail(`source checkout is dirty: ${source.sourceRepo}`);
    const actual = (await $`git -C ${dir} rev-parse HEAD`.text()).trim();
    if (actual !== source.commit) fail(`source ref mismatch for ${source.sourceRepo}: ${actual}`);
    const actualTree = (await $`git -C ${dir} rev-parse HEAD^{tree}`.text()).trim();
    const recorded = digests.sources.find((item) => item.sourceRepo === source.sourceRepo)?.tree;
    if (recorded && actualTree !== recorded) fail(`source tree mismatch for ${source.sourceRepo}`);
  }
}

function verifyNormalizedTree() {
  if (mode !== 'normalized' && mode !== 'main') return;
  const normalized = JSON.parse(readFileSync(join(root, 'provenance/normalization-map.json'), 'utf8')) as { rootResponsibilities?: Record<string, string> };
  const required = ['product', 'scripts', 'src', 'src-tauri', 'tests'];
  if (!normalized.rootResponsibilities || Object.keys(normalized.rootResponsibilities).sort().join(',') !== required.join(',')) fail('normalized root responsibilities are incomplete');
  if (existsSync(join(root, 'imported'))) fail('normalized tree still contains imported namespace');
}

validateShape();
verifyNormalizedTree();
await verifySourceObjects();
console.log(JSON.stringify({ code: 'IDE_PROVENANCE_VALID', phase: mode, sources: refs.sources.length, mappings: mappings.mappings.length }));
