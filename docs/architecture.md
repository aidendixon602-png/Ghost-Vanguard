# Architecture

## Code layout

| Folder | Responsibility |
|---|---|
| `src/index.ts` | Creates the client and database, starts the health endpoint, wires everything together |
| `src/bot/` | Command registry, interaction routing, access guard, guild lifecycle, command synchronization, invite links |
| `src/commands/` | One module per slash command, in category folders |
| `src/database/` | SQLite store, versioned migrations, scheduled verified backups |
| `src/security/` | Anti-nuke engine, the threat board, staff anti-ping, moderation, protection statistics |
| `src/dashboard/` | The read-only page, its JSON API (a pure function of the store), and the standalone server |
| `src/recovery/` | Snapshots, the restore engine, operation locks, rate-limit handling |
| `src/integrations/` | Roblox provider lookups and the shared rate-limited HTTP reader |
| `src/ui/` | Embeds, buttons, select menus and paged views |
| `src/core.ts`, `errors.ts`, `config.ts`, `logging.ts` | Shared helpers used across folders |

## Command modules

Everything under `src/commands/` is discovered recursively at startup. A module exports one `defineCommand(...)` definition containing the Discord schema, metadata, optional per-subcommand policy, an execute handler and an optional autocomplete handler. A load error names the exact file. Duplicate names, invalid schemas and missing handlers stop startup rather than skipping a command. To add a command, add one module.

Common metadata covers category, developer-only, authorization requirement, user/bot/channel permissions, cooldown, ephemeral default, DM/guild restrictions, access policy and response kind. Subcommands inherit these and declare only what differs.

## Interactions

`Interactions` handles slash commands, user and message context commands, buttons, every select-menu type, modal submissions and autocomplete. All of them go through the registry and the guard, and unregistered or stale controls fail closed. Handlers acknowledge the interaction before doing asynchronous checks, and shared helpers edit the deferred reply instead of replying twice.

Errors carry a category and a reference ID. Users see a safe message; the structured log keeps command, user, guild, channel, timing, result and redacted technical detail. Prompt text, reasons and SDK request bodies are never logged, and tokens, API keys, credential URLs and password fields are redacted.

## Execution model

Authorized commands run one at a time per guild, with a bounded pending queue, duplicate-interaction suppression and per-command cooldowns. Security events use their own per-guild queue so enforcement never waits behind a long command. One audit entry can count toward several rules (for example a role update toward `role_update` and `dangerous_grant`); each rule records its own observation, so they are counted and deduplicated independently. Every mutation checks current authorization, and database writes inside protected work validate the generation token captured when the work began. Permissions are re-checked just before execution after queueing.

## Discord REST and integrations

Discord REST scheduling and rate-limit handling come from discord.js. Global commands are read and compared once at startup rather than overwritten continuously, and a persisted checkpoint avoids refetching the legacy per-guild cleanup. Log delivery uses a persistent outbox with small sequential batches and exponential backoff, and drops deliveries for unauthorized servers. How restores behave under rate limits is covered in [recovery.md](recovery.md#rate-limits).

Roblox provider reads use four workers, a bounded wait queue, 30-second success caching, in-flight de-duplication, timeouts and limited exponential retries for 429 and transient server errors. A long provider rate limit trips a circuit breaker. A rejected API key (401 or 403) pauses that provider for that server for 5 minutes and logs which `.env` setting to check. Revoking a server aborts its outstanding reads and clears its cached responses. Verification refresh only runs for authorized, initialized guilds, handles at most ten stale links per tick, and keeps existing verification when a provider is down. RoVer and Bloxlink keys must be authorized for each guild and provider; a key alone does not guarantee API access everywhere.
