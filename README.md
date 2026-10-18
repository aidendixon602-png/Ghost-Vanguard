<div align="center">

<img src="assets/ghost-vanguard-logo.png" alt="Ghost Vanguard" width="180">

# Ghost Vanguard

**Security, moderation and support desk for the Midtown Discord network**

Anti-nuke and the threat board · Moderation and audit logging · Ticket desk · Live dashboard · Server recovery

[![CI](https://github.com/aidendixon602-png/Ghost-Vanguard/actions/workflows/ci.yml/badge.svg)](https://github.com/aidendixon602-png/Ghost-Vanguard/actions/workflows/ci.yml)
![Version](https://img.shields.io/badge/version-3.0.0-6d5ae6)
![Tests](https://img.shields.io/badge/tests-529%20passing-2EA043)
![Node](https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![discord.js](https://img.shields.io/badge/discord.js-14-5865F2?logo=discord&logoColor=white)

[Overview](#overview) · [Capabilities](#capabilities) · [The threat board](#the-threat-board-defence-and-counter-attack) · [Dashboard](#dashboard) · [Tickets](#ticket-desk) · [Getting started](#getting-started) · [Development](#development)

</div>

> **v3.0.0 — the two bots are one.** The Midtown Desk ticket bot is now part of this codebase, midtown-desk is retired, and the product is called **Ghost Vanguard**. One Node.js process, one database, one set of ranks: **defence and counter-attack, balanced.**

---

## Overview

Ghost Vanguard protects a network of Discord servers from account takeovers, raids and staff abuse, gives staff one consistent toolset for moderation across every server, and runs the support desk those servers depend on. A single bot instance serves every authorized server. Settings, cases, tickets, threat scores and records are stored per server in SQLite, and every action that changes a server is confirmed, logged and attributable to a person.

It is deliberately **balanced — yin and yang**. Defence reacts: anti-nuke strips an attacker and puts back what they broke. Offence answers: the threat board remembers repeat attackers and counter-attacks on its own, only when the score is high or critical, only in enforce mode, and always reversibly. Everything the bot does is visible in Discord and on the dashboard.

**Design principles**

- **Fail safe.** Evidence is recorded before any action, every destructive action asks for confirmation, and permissions are re-checked at the moment of confirmation.
- **Least privilege.** Server ranks, bot-wide ranks and developer access are separate. Discord's Administrator permission never unlocks actions that weaken protection.
- **Reversible by default.** Strips save roles first, bans are recorded with their reason, and layout changes can be restored from snapshots.
- **Accurate logs.** Anything Discord does not confirm is shown as *Unavailable*, never guessed.
- **Balanced.** Defence contains, offence counter-attacks, and both are governed by one readable rule set (`planResponse`) rather than ad-hoc thresholds.

## Capabilities

### Protection
| Feature | Description |
|---|---|
| **Anti-nuke** | 17 rules covering mass bans and kicks, channel/role deletion, dangerous permission grants, bot additions, webhooks and server edits. New or unconfigured servers start in observe mode; enforcement requires a successful readiness check and an explicit confirmation. Everyday rules warn first, staff get a heads-up one step before any limit, and offenders are stripped with the damage reverted. False alarms are undone in one click. |
| **Whitelist** | Per-user or per-role exemptions, either full or per rule, with optional expiry. Includes presets for common staff roles and built-in recognition of verification bots. |
| **Raid response** | Raid mode, server-wide lockdown with exact restore, emergency mode, new-account holds, join-flood detection. |
| **Content protection** | Automod (spam, links, invites, optional AI moderation), scam-link and scam-image detection, staff anti-ping. |
| **Threat board** | Every confirmed incident scores the member behind it. Watch (25+) is staff's chance to step in first, High (55+) strips their access and puts the damage back, Critical (85+) counter-attacks and bans. Whitelisted people, the bot, the server owner and observe mode are never auto-actioned, everything is logged and reversible, and a quiet attacker cools off (scores halve daily, entries expire after a week). See [docs/threat-board.md](docs/threat-board.md). |

### Moderation
| Feature | Description |
|---|---|
| **Moderation suite** | Ban, tempban, softban, massban, kick, timeout, warnings with automatic escalation, cases, notes and appeals. Reasons are optional. |
| **Ban records** | One record per ban (`BAN-0001`) in `#bans` with reason, evidence, moderator, duration and expiry, including bans made by hand or by other bots. |
| **Network bans** | Developer-issued genrebans and hardbans across every server, enforced on join. Server staff cannot lift them: genrebans are lifted by a Supreme Leader or Developer (or excepted for one server by an Overseer+), hardbans only by a Developer. |
| **Role management** | `/role` with full hierarchy checks, per-role giving rules, and one-click role restore for members who leave and rejoin. |

### Support desk
| Feature | Description |
|---|---|
| **Ticket desk** | Panel-driven tickets with per-type categories, claim/close/rename, a 60-second cooldown and a per-member open limit. Closing posts a full transcript, waits five seconds, then removes the channel. |
| **Satisfaction** | Every close DMs the requester a rating; the averages feed the weekly staff report and the dashboard. |
| **Upkeep** | Automatic closing of idle tickets, staff reminders, and a weekly report of volume, response and ratings. |

### Operations
| Feature | Description |
|---|---|
| **Control panel** | A private `#vanguard-control` channel with buttons to restore or strip roles, revert the bot's actions and review recent activity. Restricted to authorized staff, confirmed and logged. |
| **Audit logging** | `#midtown-vanguard-logging`: message edits and deletions, role, channel, member and permission changes, each with the verified actor. |
| **Recovery** | Snapshots and scheduled backups of roles, channels and permissions, with previewed, rate-limit-aware restores. |
| **Dashboard** | A self-contained read-only page (no build step, no external assets) showing servers, protection, the threat board, the ticket desk and recent incidents. Served by the bot next to `/healthz`, or standalone against the same database. See [docs/dashboard.md](docs/dashboard.md). |
| **Self-hosting tools** | Supervised launcher, automatic CI-gated updates with rollback, hourly verified database backups, health endpoint. |

## Access model

Every command has a minimum rank, and each rank includes everything below it. Bot-wide ranks work in every server; server ranks work only where they were given.

| Rank | Scope | Can do |
|---|---|---|
| **Developer** | All servers | The bot owner (`BOT_OWNER_ID`) and `DEVELOPER_IDS`. Everything, including the tools that can break the bot: restarts, installing updates, restoring database settings, removing or banning servers, giving bot-wide ranks, lifting hardbans |
| **Supreme Leader** | All servers | Everything except the Developer-only tools: diagnostics, update status, database health and backups, genrebans and hardbans, lifting genrebans |
| **Overseer** | All servers | Bot Manager, plus inspecting and authorizing servers and one-server genreban exceptions |
| **Bot Manager** | All servers | Head Admin in every server, plus bot status, diagnostics and announcements |
| **Server Owner** | Own server | Head Admin, plus security admins, undoing setting changes and undoing strips |
| **Head Admin** | One server | Anti-nuke, whitelist, control panel, backups, staff ranks |
| **Admin** | One server | Lifting ordinary bans, accepting appeals, raid tools, automod, scam protection, logging |
| **Moderator** | One server | Bans, kicks, tempbans, purges, ban records, denying appeals |
| **Helper** | One server | Warnings, short timeouts, cases and notes |

**Developer is the top rank and is set only in `.env`.** Anything that can take the bot offline, change its data or affect every server at once is Developer only, so Supreme Leader (or any lower rank) is safe to give to someone who is still learning.

**Who can lift a ban**

| Ban | Lifted by |
|---|---|
| Ordinary server ban | Admin rank, Discord Administrator or the server owner (`/mod unban`, ban log buttons, accepting an appeal) |
| Genreban | A Supreme Leader or Developer, everywhere (`/network ungenreban`); an Overseer or higher can let the person back into one server (`/mod unban`) |
| Hardban | A Developer only (`/network unhardban`) |

Anti-nuke watches every rank except Developers, Supreme Leaders, server owners and whitelisted entries. The complete list of commands for each rank is in **[docs/ranks.md](docs/ranks.md)**.

## The threat board: defence and counter-attack

Anti-nuke answers an incident immediately; the threat board is the memory that decides whether the person behind it is a one-off mistake or a repeat attacker. It is the only part of the bot that counter-attacks, and it does so on a rule that is short enough to read:

| Level | From | What the bot does by itself |
|---|---|---|
| 🟢 Quiet | 0 | Nothing — shown on the board only |
| 🟡 Watch | 25 | Nothing — staff's chance to step in first |
| 🟠 High | 55 | Defence: strip their dangerous roles, put their damage back |
| 🔴 Critical | 85 | Counter-attack: strip, restore, then ban |

Never automatic: whitelisted people, the bot itself, the server owner, servers with protection off or unauthorized, observe mode, and anything inside a ten-minute cooldown. A quiet attacker cools off — scores halve once a day and entries expire a week after the last incident.

`/security threats list` shows the board, `view` shows one member's full history, and `clear`, `release` and `strike` (Head Admin and above) are how staff undo or force an action. Every automatic action is in the server's log channel too, and **all of them are reversible**. Full detail: [docs/threat-board.md](docs/threat-board.md).

## Dashboard

```bash
npm run dashboard        # against the bot's database, no Discord needed
npm run dashboard:demo   # seeded sample data to look at
```

One self-contained page: no build step, no external fonts, scripts or images, so it works on a host with no internet. It shows the overview, the live threat board, the ticket desk and recent incidents, and re-reads the API every 15 seconds. The bot serves the same thing on its health port, so in production there is nothing extra to run. Set `DASHBOARD_TOKEN` to require a token (the bot prints whether it is required at startup). Full detail: [docs/dashboard.md](docs/dashboard.md).

## Ticket desk

A staff member posts the panel once with `/ticket setup`; members press a button and get a private channel for their ticket type. Closing posts a transcript, waits five seconds, then deletes the channel, and the requester is DMed a rating. Idle tickets close themselves, and staff get a weekly report. The desk numbers (open, unclaimed, urgent, average rating) are on the dashboard.

## Commands

Commands are grouped under a small number of top-level entries:

| Command | Purpose |
|---|---|
| `/antinuke` | Status, enable/disable, checks, safety scan, settings, whitelist |
| `/mod` | Bans, kicks, timeouts, warnings, purge, ban records, cases, notes, appeals |
| `/ticket` | Ticket panel, types, setup, claim, close, transcripts, block list, weekly report |
| `/role` | Give, remove and restore roles; who can give which role |
| `/security` | Lockdown, emergency mode, raid mode, automod, scam protection, anti-ping, quarantine, threats |
| `/setup` | Control panel, logging, staff ranks, welcome, configuration, permissions, history |
| `/recovery` | Snapshots, backups, layout copy |
| `/info` | Users, roles, server, bot, latency |
| `/roblox` | Verification, lookups, blacklist, group binds |
| `/network` | Genrebans, hardbans and their exceptions (developers) |
| `/dev` | Diagnostics, updates, restarts, servers, database (bot-wide ranks; the risky tools are Developer only) |

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
| `DEVELOPER_IDS` | Yes | Comma-separated user IDs with Developer access (the top rank, full control) |
| `DATABASE_PATH` | No | SQLite database location (default `./data/vanguard.db`) |
| `DASHBOARD_ENABLED` | No | Set to `false` to disable the built-in dashboard while keeping `/healthz` available (default: enabled) |
| `DASHBOARD_TOKEN` | Recommended | Require a token for the dashboard and its API when enabled. Without it the dashboard is open to anyone who can reach the port, so keep it on localhost |
| `BOT_OWNER_ID` | Recommended | The bot owner: Developer (the top rank), and the default for `TRUSTED_DM_IDS` |
| `SUPREME_LEADER_IDS` | No | Supreme Leaders: everything except the Developer-only tools. Nobody is built in; every start prints who has bot-wide access |
| `TRUSTED_DM_IDS` | No | The only people the bot DMs about itself, including the daily database backup (default: `BOT_OWNER_ID`) |
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
2. Run `/setup logs setup` to create the ban and server log channels (including the security log used by anti-nuke).
3. Move the Ghost Vanguard role above staff roles where possible. `/antinuke check` reports missing permissions and roles the bot cannot contain.
4. When the readiness check passes, run `/antinuke enable` and review the confirmation to start enforce mode. New or unconfigured servers stay in observe mode until this is done.
5. Run `/setup panel` to create the staff control panel.
6. Link staff roles to ranks with `/setup staff role`.
7. Run `/ticket setup` to post the ticket panel.

## Operations

### Automatic updates

With `UPDATE_REPO` and `UPDATE_TOKEN` set (a fine-grained token with read-only *Contents* and *Actions* on this repository), the launcher checks `main` every five minutes:

```
push to main → CI (typecheck, build, tests, secret scan) → launcher installs → bot restarts
```

- Only commits that passed CI are installed.
- A version that stops within two minutes of installing is rolled back automatically and skipped.
- `.env` and `data/` are never modified.
- Developers can check the update status with `/dev update`. Installing immediately (`action: now`), `/dev restart`, and the in-server `,restart` shortcut are Developer only. `,restart` requires Message Content Intent enabled in the Discord Developer Portal, and `MESSAGE_CONTENT_ENABLED` must not be set to `false`.

### Backups

- **Database:** verified backups every hour, kept on a rolling schedule in `data/database-backups`, plus a daily compressed copy sent by DM only to `TRUSTED_DM_IDS` (default: the bot owner). Lost settings can be merged back from any backup with `/dev database restore-settings`.
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
| `npm run dashboard` | Serve the dashboard against the database, without starting Discord |
| `npm run dashboard:demo` | The same, with seeded sample data |

Every pull request and push runs the CI workflow: type-check, build, a check that `dist/` matches `src/`, the full test suite, and a scan that blocks committed secrets or databases. The command and rank documentation is generated from code and verified by a test, so it cannot drift.

<details>
<summary><b>Project structure</b></summary>

```
src/
  index.ts         entry point: client, health endpoint, startup
  bot/             command registry, routing, permissions, ranks, lifecycle
  commands/        one module per slash command, by category
  security/        anti-nuke engine, threat board, moderation, network bans, role policy
  dashboard/       the read-only page, its JSON API and the standalone server
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
| [threat-board.md](docs/threat-board.md) | Scoring, levels, the counter-attack and how to reverse it |
| [dashboard.md](docs/dashboard.md) | Running, securing and reading the dashboard |
| [antinuke-locked.md](docs/antinuke-locked.md) | The 17 rules and their limits |
| [recovery.md](docs/recovery.md) | Snapshots, backups and restores |
| [server-lifecycle.md](docs/server-lifecycle.md) | Invites, authorization and removal |
| [hosting.md](docs/hosting.md) | Hosting, persistence and the health endpoint |
| [architecture.md](docs/architecture.md) | How the code is organized |
| [changelog.md](docs/changelog.md) | Release history |

## Security

Do not commit `.env`, tokens, API keys or anything under `data/`; CI rejects commits that contain them. If a token is exposed, reset it in the Discord Developer Portal immediately and update the host's `.env`. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

This repository is publicly viewable, but no open-source license is granted. All rights reserved. Public visibility does not grant permission to reuse, redistribute, or modify the code without prior written permission.
