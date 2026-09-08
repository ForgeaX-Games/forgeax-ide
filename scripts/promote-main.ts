import { $ } from 'bun';

if (!Bun.argv.includes('--require-merge')) throw new Error('IDE_PROMOTION_REQUIRES_MERGE_FLAG');
const status = (await $`git status --porcelain`.text()).trim();
if (status) throw new Error('IDE_PROMOTION_DIRTY_CANDIDATE');
const candidate = (await $`git branch --show-current`.text()).trim();
if (candidate !== 'migration-candidate') throw new Error(`IDE_PROMOTION_WRONG_SOURCE_REF:${candidate}`);
const remote = (await $`git remote get-url origin`.nothrow().text()).trim();
if (!remote) throw new Error('IDE_PROMOTION_ORIGIN_REQUIRED');
const main = await $`git ls-remote --heads origin main`.nothrow();
if (main.exitCode !== 0 || !main.stdout.toString().trim()) throw new Error('IDE_PROMOTION_PROTECTED_MAIN_UNAVAILABLE');
throw new Error('IDE_PROMOTION_MUST_USE_PULL_REQUEST');
