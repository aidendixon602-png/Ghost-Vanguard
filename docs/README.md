# Ghost Vanguard Documentation

## For Operators & Staff
- **[Commands](commands.md)** — every slash command and required rank
- **[Ranks](ranks.md)** — every rank and what it unlocks
- **[Security Controls](user/security-controls.md)** — how anti-nuke decides, warns, strips and reverts
- **[Threat Board](user/threat-board.md)** — scoring, staff triage, manual controls and reversibility
- **[Dashboard](user/dashboard.md)** — running, securing and reading the dashboard
- **[Anti-Nuke Locked Rules](user/antinuke-locked.md)** — the 17 rules and limits
- **[Recovery](user/recovery.md)** — snapshots, backups and restores
- **[Server Lifecycle](user/server-lifecycle.md)** — invites, authorization and removal
- **[Hosting](user/hosting.md)** — persistence and health endpoint
- **[Architecture](user/architecture.md)** — how the code is organized
- **[Anti-Ping](user/anti-ping.md)** · **[Scam Protection](user/scam-protection.md)** · **[Snapshots](user/snapshots.md)** · **[Validation](user/validation.md)**

## Scripts & Automation
- `npm run docs` — regenerate `docs/commands.md` + `docs/ranks.md` via `scripts/docs/generate.ts`
- `npm run build` — `node scripts/build/clean.mjs && tsc`
- `npm run dashboard` / `dashboard:demo` — `scripts/ops/dashboard-demo.mjs`

## Internal / Historical
- `docs/internal/notes/` — prior incident fixes and audits (e.g. `command-audit.md`)
- `docs/changelog.md` — release history

> Historical paths like `docs/threat-board.md` still resolve via redirects (see individual files).
