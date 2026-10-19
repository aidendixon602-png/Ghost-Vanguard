# src/bot — Discord plumbing

- **registry.ts** — Loads `src/commands/**/*.ts`, validates schemas, stores `Definition` (data + metadata + execute).
- **command-tree.ts** — Groups 68 commands into 12 global slash entries (`/mod`, `/setup`, `/security` …) + `STANDALONE` (`/verify`, `/roblox` …). `routeInteraction()` re-shapes grouped interactions back to original module shape.
- **interactions.ts** — Acknowledge → guard check → queue → execute. Buttons/selects/modals/autocomplete all via `registry.components`.
- **guard.ts / ranks.ts / lifecycle.ts** — Permission checks, rank resolution (`helper` → `developer`), authorization gating.
- **command-sync.ts** — `syncCommands()` bulk PUTs global commands only when `normalizeCommands()` differs; `cleanLegacyGuildCommands()` one-time per-guild cleanup.
- **prefix-*.ts** — Comma commands (`,restart`, `,genreban` …) require exact `DEVELOPER_IDS`, auto-delete after 10s via `prefix-cleanup.ts`.
