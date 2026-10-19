import { rmSync } from 'node:fs';
// Only generated output is removed; configuration and data are untouched.
rmSync(new URL('../../dist/', import.meta.url), { recursive: true, force: true });
