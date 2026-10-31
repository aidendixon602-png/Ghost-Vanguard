# src — Ghost Vanguard source

- **index.ts** — Creates `Client`, `Store`, `Security`, `Roblox`, `Snapshots`, wires `Interactions`, starts the health/dashboard HTTP server and all timers.
- **config.ts** — Parses `.env` → typed `config` + `validateConfig()`. Secrets never logged (`src/errors.ts: redact()`).
- **branding.ts** — Single source for `PRODUCT_NAME`, default log names, the Ghost Vanguard Logs category and legacy names.
- **core.ts / errors.ts / logging.ts / console-ui.ts** — Cross-cutting helpers.

Subfolders: `bot/` (Discord wiring), `commands/` (slash definitions), `security/` (protection engine), `audit/` (logs & ban records), `database/` (SQLite), `recovery/` (snapshots), `features/` (tickets, automod…), `integrations/` (Roblox & HTTP), `dashboard/` (no-build page), `ui/` (embeds & panels).
