import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const required = ['src', 'src-tauri', 'product', 'scripts', 'tests'];
const forbidden = ['imported', 'workspace:', 'file:', 'link:'];
const map = JSON.parse(readFileSync(join(root, 'provenance/normalization-map.json'), 'utf8')) as { rootResponsibilities: Record<string, string> };
const missing = required.filter((directory) => !existsSync(join(root, directory)));
if (missing.length) throw new Error(`IDE_NORMALIZATION_INVALID missing=${missing.join(',')}`);
if (Object.keys(map.rootResponsibilities).sort().join(',') !== required.sort().join(',')) throw new Error('IDE_NORMALIZATION_INVALID responsibilities');
if (forbidden.some((token) => existsSync(join(root, token)))) throw new Error('IDE_NORMALIZATION_INVALID imported/source alias remains');
console.log(JSON.stringify({ code: 'IDE_NORMALIZATION_VALID', directories: required }));
