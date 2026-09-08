import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';

const root = join(import.meta.dir, '..');
const fail = (message: string): never => {
  console.error(JSON.stringify({ code: 'IDE_MAIN_PROVENANCE_INVALID', phase: 'main-promotion', message }));
  process.exit(1);
};

if (!existsSync(join(root, 'provenance/normalization-map.json')) || !existsSync(join(root, 'provenance/source-refs.json')) || !existsSync(join(root, 'provenance/tree-digests.json'))) fail('normalized provenance files are missing');
const status = (await $`git status --porcelain`.text()).trim();
if (status) fail('candidate checkout is dirty');
const branch = (await $`git branch --show-current`.text()).trim();
if (branch !== 'main' && Bun.argv.includes('--main')) fail(`verification must run on main, got ${branch || 'detached'}`);
const candidate = (await $`git rev-parse HEAD`.text()).trim();
const promotion = JSON.parse(readFileSync(join(root, 'provenance/main-promotion.json'), 'utf8')) as { candidateCommit: string; mainCommit: string; status: string };
if (promotion.status !== 'promoted' && Bun.argv.includes('--require-merge')) fail('protected main promotion evidence is not complete');
if (promotion.status === 'promoted') {
  const expected = Bun.argv.includes('--main') ? promotion.mainCommit : promotion.candidateCommit;
  if (Bun.argv.includes('--main')) {
    const reachable = await $`git merge-base --is-ancestor ${expected} HEAD`.nothrow();
    if (reachable.exitCode !== 0) fail('promoted main commit is not reachable from the checked-out main');
  } else {
    const reachable = await $`git merge-base --is-ancestor ${expected} HEAD`.nothrow();
    if (reachable.exitCode !== 0) fail('candidate commit is not reachable from the checked-out candidate');
  }
}
console.log(JSON.stringify({ code: 'IDE_MAIN_PROVENANCE_VALID', branch: branch || 'detached', commit: candidate, status: promotion.status }));
