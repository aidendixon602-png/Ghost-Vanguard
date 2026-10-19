# scripts

- **build/** — `clean.mjs` (rm dist/), `verify-install.mjs` (193 modules check), `update-preflight.mjs`
- **ops/** — `restore-database.mjs`, `drop-csb-tables.mjs`, `scam-setup.mjs`, `dashboard-demo.mjs`, `merge-guild.mjs`
- **docs/** — `generate.ts` → `docs/commands.md` + `docs/ranks.md`
- **start.sh** — Linux/Wispbyte start (install → import → run)
- Root shims (`clean.mjs`, `commands-doc.ts` …) forward to new paths for backward compat.
