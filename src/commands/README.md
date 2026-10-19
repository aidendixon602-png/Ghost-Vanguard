# src/commands — One file = one slash command

Groups: `antinuke/`, `configuration/` (logs, staff, welcome, guild-config + workspace), `developer/` (now comma-only), `moderation/`, `roblox/`, `security/`, `tickets/`, `utility/`, `verification/`.

Each exports `defineCommand(builder, metadata, execute, { subcommands, autocomplete })`. `npm run docs` regenerates `docs/commands.md` + `docs/ranks.md` so docs never drift.
