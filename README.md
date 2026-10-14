<div align="center">

# Midtown Vanguard

**Security and moderation platform for the Midtown Discord network**

Anti-nuke protection · Moderation and audit logging · Staff permissions · Server recovery

[![CI](https://github.com/aidendixon602-png/midtown-vanguard/actions/workflows/ci.yml/badge.svg)](https://github.com/aidendixon602-png/midtown-vanguard/actions/workflows/ci.yml)
![Version](https://img.shields.io/badge/version-2.36.0-5865F2)
![Tests](https://img.shields.io/badge/tests-481%20passing-2EA043)
![Node](https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![discord.js](https://img.shields.io/badge/discord.js-14-5865F2?logo=discord&logoColor=white)

[Overview](#overview) · [Capabilities](#capabilities) · [Access model](#access-model) · [Getting started](#getting-started) · [Operations](#operations) · [Development](#development) · [Documentation](#documentation)

</div>

---

## Overview

Midtown Vanguard protects a network of Discord servers from account takeovers, raids and staff abuse, and gives staff one consistent toolset for moderation across every server. A single bot instance serves every authorized server. Settings, cases and records are stored per server in SQLite, and every action that changes a server is confirmed, logged and attributable to a person.

**Design principles**

- **Fail safe.** Evidence is recorded before any action, every destructive action asks for confirmation, and permissions are re-checked at the moment of confirmation.
- **Least privilege.** Server ranks, bot-wide ranks and developer access are separate. Discord's Administrator permission never unlocks actions that weaken protection.
- **Reversible by default.** Strips save roles first, bans are recorded with their reason, and layout changes can be restored from snapshots.
- **Accurate logs.** Anything Discord does not confirm is shown as *Unavailable*, never guessed.

## Capabilities

### Protection
| Feature | Description |
|---|---|
| **Anti-nuke** | 17 rules covering mass bans and kicks, channel/role deletion, dangerous permission grants, bot additions, webhooks and server edits. Everyday rules warn first, staff get a heads-up one step before any limit, and offenders are stripped with the damage reverted. False alarms are undone in one click. |
| **Whitelist** | Per-user or per-role exemptions, either full or per rule, with optional expiry. Includes presets for common staff roles and built-in recognition of verification bots. |
| **Raid response** | Raid mode, server-wide lockdown with exact restore, emergency mode, new-account holds, join-flood detection. |
| **Content protection** | Automod (spam, links, invites, optional AI moderation), scam-link and scam-image detection, staff anti-ping. |

### Moderation
| Feature | Description |
|---|---|
| **Moderation suite** | Ban, tempban, softban, massban, kick, timeout, warnings with automatic escalation, cases, notes and appeals. Reasons are optional. |
| **Ban records** | One record per ban (`BAN-0001`) in `#bans` with reason, evidence, moderator, duration and expiry, including bans made by hand or by other bots. |
| **Network bans** | Developer-issued genrebans and hardbans across every server, enforced on join. A server owner or Head Admin can grant a single-server exception for a genreban; hardbans have none. |
| **Role management** | `/role` with full hierarchy checks, per-role giving rules, and one-click role restore for members who leave and rejoin. |

### Operations
| Feature | Description |
|---|---|
| **Control panel** | A private `#vanguard-control` channel with buttons to restore or strip roles, revert the bot's actions and review recent activity. Restricted to authorized staff, confirmed and logged. |
| **Audit logging** | `#midtown-vanguard-logging`: message edits and deletions, role, channel, member and permission changes, each with the verified actor. |
| **Recovery** | Snapshots and scheduled backups of roles, channels and permissions, with previewed, rate-limit-aware restores. |
| **Self-hosting tools** | Supervised launcher, automatic CI-gated updates with rollback, hourly verified database backups, health endpoint. |

## Access model

Every command has a minimum rank. Each rank includes everything below it.

| Rank | Scope | Responsibilities |
|---|---|---|
| Supreme Leader | All servers | Full control; receives the daily database backup |
| Developer | All servers | Updates, restarts, database, network bans; exempt from anti-nuke |
| Overseer | All servers | Bot Manager, plus inspecting and authorizing servers |
| Bot Manager | All servers | Head Admin everywhere, plus diagnostics, status and broadcasts |
| Server Owner | Own server | Security admins, staff role policy, undoing strips |
| Head Admin | One server | Anti-nuke, whitelist, control panel, backups, staff ranks |
| Admin | One server | Raid tools, automod, scam protection, logging, welcome |
| Moderator | One server | Bans, kicks, tempbans, purges, ban records |
| Helper | One server | Warnings, short timeouts, cases and notes |

Anti-nuke watches every rank except Developers, Supreme Leaders, server owners and whitelisted entries. The complete list of commands for each rank is in **[docs/ranks.md](docs/ranks.md)**.

## Commands

Commands are grouped under a small number of top-level entries:

| Command | Purpose |
|---|---|
| `/antinuke` | Status, enable/disable, checks, safety scan, settings, whitelist |
| `/mod` | Bans, kicks, timeouts, warnings, purge, ban records, cases, notes, appeals |
| `/role` | Give, remove and restore roles; who can give which role |
| `/security` | Lockdown, emergency mode, raid mode, automod, scam protection, anti-ping, quarantine |
| `/setup` | Control panel, logging, staff ranks, welcome, configuration, permissions, history |
| `/recovery` | Snapshots, backups, layout copy |
| `/info` | Users, roles, server, bot, latency |
| `/roblox` | Verification, lookups, blacklist, group binds |
| `/network` | Genrebans, hardbans and their exceptions (developers) |
| `/dev` | Diagnostics, updates, restarts, servers, database (developers and bot-wide ranks) |

`/help` in Discord lists only the commands available to you. The full reference is in **[docs/commands.md](docs/commands.md)**.

## Getting started

### Requirements

- Node.js 24
- A Discord application with a bot token and the **Server Members** and **Message Content** intents enabled
- Persistent storage for the `data/` directory

### Configuration

Copy [`.env.example`](.env.example) to `.env` and set at least:

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | Yes | Bot token from the Discord Developer Portal |
| `DISCORD_CLIENT_ID` | Yes | Application ID |
| `DEVELOPER_IDS` | Yes | Comma-separated user IDs with developer access |
| `DATABASE_PATH` | No | SQLite database location (default `./data/vanguard.db`) |
| `SUPREME_LEADER_IDS` | No | Additional Supreme Leaders |
| `UPDATE_REPO`, `UPDATE_TOKEN` | No | Enable automatic updates (see below) |
| `ROVER_API_KEY`, `BLOXLINK_API_KEY` | No | Roblox verification providers |
| `AI_ENABLED`, `OPENAI_API_KEY` | No | AI moderation and `/ask` |

### Running

```bash
node launch.js
```

`launch.js` installs dependencies when needed, starts the bot, restarts it if it stops, and restores the database from its most recent backup if the file is missing. On hosting panels such as Wispbyte, use `cd /home/container && node launch.js` as the start command.

### Adding a server

1. Invite the bot using the link printed at startup. Inviting with a developer account authorizes the server automatically.
2. Run `/setup logs setup` to create the ban and server log channels.
3. Run `/setup panel` to create the staff control panel.
4. Link staff roles to ranks with `/setup staff role`.
5. Make sure the Midtown Vanguard role sits above every staff role.

## Operations

### Automatic updates

With `UPDATE_REPO` and `UPDATE_TOKEN` set (a fine-grained token with read-only *Contents* and *Actions* on this repository), the launcher checks `main` every five minutes:

```
push to main → CI (typecheck, build, tests, secret scan) → launcher installs → bot restarts
```

- Only commits that passed CI are installed.
- A version that stops within two minutes of installing is rolled back automatically and skipped.
- `.env` and `data/` are never modified.
- Developers can check or trigger an update with `/dev update`, and restart with `/dev restart`.

### Backups

- **Database:** verified backups every hour, kept on a rolling schedule in `data/database-backups`, plus a daily compressed copy sent by DM to Supreme Leaders. Lost settings can be merged back from any backup with `/dev database restore-settings`.
- **Server layout:** snapshots and scheduled backups with `/recovery`.

### Running more than one copy

Run only one instance per bot token. A database lease prevents a second instance from sharing the same database, but two hosts using the same token would both respond to events.

## Development

```bash
npm ci
npm run build    # compile src/ to dist/ (dist/ is committed and verified by CI)
npm test         # full test suite
npm run dev      # run from source
```

| Script | Purpose |
|---|---|
| `npm run check` | Type-check without emitting |
| `npm run docs` | Regenerate `docs/commands.md` and `docs/ranks.md` from the command definitions |
| `npm run doctor` | Validate configuration and command loading |
| `npm run database:restore` | Restore a verified database backup (bot stopped) |

Every pull request and push runs the CI workflow: type-check, build, a check that `dist/` matches `src/`, the full test suite, and a scan that blocks committed secrets or databases. The command and rank documentation is generated from code and verified by a test, so it cannot drift.

<details>
<summary><b>Project structure</b></summary>

```
src/
  index.ts         entry point: client, health endpoint, startup
  bot/             command registry, routing, permissions, ranks, lifecycle
  commands/        one module per slash command, by category
  security/        anti-nuke engine, moderation, network bans, role policy
  audit/           ban records, event log, log channel setup, redaction
  database/        SQLite store, migrations, backups, settings restore
  recovery/        snapshots and the restore engine
  features/        automod, appeals, welcome, rejoin roles and more
  integrations/    Roblox providers
  ui/              embeds, panels, buttons and generated docs
launch.js          supervisor: install, restore, restart, automatic updates
test/              node:test suites
docs/              reference documentation
dist/              compiled output (committed)
```

</details>

## Documentation

| Document | Contents |
|---|---|
| [commands.md](docs/commands.md) | Every command and its required rank |
| [ranks.md](docs/ranks.md) | Every rank and the commands it unlocks |
| [security-controls.md](docs/security-controls.md) | How anti-nuke decides, warns, strips and reverts |
| [antinuke-locked.md](docs/antinuke-locked.md) | The 17 rules and their limits |
| [recovery.md](docs/recovery.md) | Snapshots, backups and restores |
| [server-lifecycle.md](docs/server-lifecycle.md) | Invites, authorization and removal |
| [hosting.md](docs/hosting.md) | Hosting, persistence and the health endpoint |
| [architecture.md](docs/architecture.md) | How the code is organized |
| [changelog.md](docs/changelog.md) | Release history |

## Security

Do not commit `.env`, tokens, API keys or anything under `data/`; CI rejects commits that contain them. If a token is exposed, reset it in the Discord Developer Portal immediately and update the host's `.env`. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

Private project. All rights reserved.
