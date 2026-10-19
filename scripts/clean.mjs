import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = dirname(fileURLToPath(import.meta.url));
const target = join(root, 'build/clean.mjs');
const res = spawnSync(process.execPath, [target], { stdio: 'inherit' });
process.exit(res.status ?? 0);
