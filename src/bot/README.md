# src/bot — Discord plumbing

- **registry.ts** — Loads `src/commands/**/*.ts`, validates schemas, stores `Definition` (data + metadata + execute).
- **command-tree.ts** — Groups the commands into the global slash-command tree (`/mod`, `/setup`, `/antinuke` …) plus standalone commands (`/genreban`, `/hardban`, `/verify` …). `routeInteraction()` re-shapes grouped interactions back to original module shape.
- **interactions.ts** — Acknowledge → guard check → queue → execute. Buttons/selects/modals/autocomplete all via `registry.components`.
- **guard.ts / ranks.ts / lifecycle.ts** — Permission checks, rank resolution (`helper` → `developer`), authorization gating.
- **command-sync.ts** — `syncCommands()` bulk PUTs global commands only when `normalizeCommands()` differs; `cleanLegacyGuildCommands()` one-time per-guild cleanup.
- **restart-request.ts / restart-notice.ts** — `/restart` authorization, launcher fallback and persistent completion notice; no message-prefix command path; slash commands are synced from `treeJson()` at startup.
