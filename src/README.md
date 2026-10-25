# src — Ghost Vanguard source

- **index.ts** — Creates `Client`, `Store`, `Security`, `Roblox`, `Snapshots`, wires `Interactions`, starts the health/dashboard HTTP server and all timers.
- **config.ts** — Parses `.env` → typed `config` + `validateConfig()`. Secrets never logged (`src/errors.ts: redact()`).
- **branding.ts** — Single source for `PRODUCT_NAME`, `DEFAULT_CHANNELS` (`bans`, `ghost-vanguard-logging`) and legacy names.
- **core.ts / errors.ts / logging.ts / console-ui.ts** — Cross-cutting helpers.

Subfolders: `bot/` (Discord wiring), `commands/` (68 slash definitions), `security/` (protection engine), `audit/` (logs & ban records), `database/` (SQLite), `recovery/` (snapshots), `features/` (tickets, automod…), `integrations/` (Roblox & HTTP), `dashboard/` (no-build page), `workspace/` (Sheets integration), `ui/` (embeds & panels).
