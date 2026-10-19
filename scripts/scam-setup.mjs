import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const target = join(root, 'ops/scam-setup.mjs');
const res = spawnSync(process.execPath, [target], { stdio: 'inherit' });
process.exit(res.status ?? 0);
