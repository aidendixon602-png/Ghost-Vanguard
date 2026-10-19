import { spawnSync } from 'node:child_process';
const target = new URL('./ops/restore-database.mjs', import.meta.url);
const res = spawnSync(process.execPath, [target.pathname, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(res.status ?? 0);