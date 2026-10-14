<div align="center">

# 🛡️ Midtown Vanguard

**Anti-nuke protection, moderation, logging and server recovery for the Midtown Discord network.**

[![CI](https://github.com/aidendixon602-png/midtown-vanguard/actions/workflows/ci.yml/badge.svg)](https://github.com/aidendixon602-png/midtown-vanguard/actions/workflows/ci.yml)
![Version](https://img.shields.io/badge/version-2.35.1-5865F2)
![Node](https://img.shields.io/badge/node-24%2B-339933?logo=node.js&logoColor=white)
![discord.js](https://img.shields.io/badge/discord.js-14-5865F2?logo=discord&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Tests](https://img.shields.io/badge/tests-480%20passing-2EA043)

[Features](#-features) · [Commands](#-commands) · [Deploying](#-deploying) · [Automatic updates](#-automatic-updates) · [Development](#-development) · [Docs](#-documentation)

</div>

---

## ✨ Features

| | |
|---|---|
| 🛡️ **Anti-nuke** | 17 fixed rules that start automatically: mass bans/kicks, channel and role deletes, dangerous permission grants, webhooks, bot adds, server edits. Everyday rules warn first and staff get a heads-up before any limit; offenders lose their powers (stripped), and the damage is reverted. False alarms can be undone in one click. |
| 🎛️ **Control panel** | A private `#vanguard-control` channel with buttons to restore or strip roles, undo the bot's strips and bans, and read recent actions. Authorized staff only, confirmed and logged. |
| 📋 **Ban logs** | One record per ban in `#bans` (BAN-0001) with reason, evidence, moderator, duration and expiry, even for bans made by hand or by other bots. Developer **Unban / Reban** buttons update the same record. |
| 📜 **Server logs** | `#midtown-vanguard-logging`: deleted/edited messages, roles, channels, nicknames, timeouts, bans, kicks and bot actions. Nothing is guessed: anything Discord doesn't confirm is marked *Unavailable*. |
| 🔨 **Moderation** | Bans, tempbans, softbans, massbans, timeouts, warnings with automatic escalation, cases, notes and appeals. |
| 🎭 **Safe role management** | `/role` with hierarchy checks; `/role who-can-give` decides who may hand out each role; rejoining members get their roles back in one click. |
| 🌐 **Network bans** | Developer-only genrebans and hardbans across every Midtown server, enforced on join. |
| 💾 **Recovery** | Snapshots and backups of the server layout with previewed, rate-limit-aware restores. |
| 🚨 **Raid tools** | Raid mode, lockdowns, emergency mode, new-account holds, scam-link and anti-ping protection. |
| 🎮 **Roblox** | RoVer/Bloxlink verification, group rank binds and a shared blacklist. |

## 💬 Commands

Type `/` and pick **Midtown Vanguard**. Commands are grouped so the menu stays short:

| Group | Highlights |
|---|---|
| `/antinuke` | `status`, `enable`, `disable`, `check`, `scan`, `settings`, `whitelist` (`add`, `remove`, `list`, `check`, `bots`) |
| `/mod` | `ban`, `unban`, `kick`, `timeout`, `warn`, `purge`, `tempban`, `softban`, `massban`, `bans`, `case`, `notes`, `warnings`, `appeals` |
| `/role` | `add`, `remove`, `restore`, `who-can-give` |
| `/security` | `lockdown`, `emergency`, `raidmode`, `automod`, `scam`, `antiping`, `health` |
| `/setup` | `panel`, `logs`, `staff`, `welcome`, `config`, `permissions`, `history` |
| `/recovery` | `snapshot`, `backup`, `copylayout` |
| `/info` | `user`, `role`, `server`, `bot`, `ping` |
| `/roblox` | `lookup`, `sync`, `blacklist`, `bind`, `group` |
| `/network` | `genreban`, `ungenreban`, `hardban`, `unhardban` (developers) |
| `/dev` | `diagnostics`, `update`, `restart`, `server`, `database` (developers) |
| `/help` | Every command you can use, with who it's for |

Full list with access levels: **[docs/commands.md](docs/commands.md)**.

### Who can use what

| Rank | Where | Can do |
|---|---|---|
| 👑 **Supreme Leader** | every server | Everything; receives the daily database backup |
| 🧰 **Developer** (`DEVELOPER_IDS`) | every server | Everything, including updates, restarts, the database and network bans; ignored by anti-nuke |
| 🔭 **Overseer** | every server | Bot Manager + inspect any server, authorize new servers |
| 🛠️ **Bot Manager** | every server | Head Admin everywhere + diagnostics, bot status, broadcasts, server list |
| 🏠 **Server Owner** | their server | Everything there, incl. security admins, staff roles and undoing strips |
| 🛡️ **Head Admin** | one server | Anti-nuke, whitelist, control panel, backups, staff ranks |
| 🔧 **Admin** | one server | Raid tools, automod, scam protection, logs, welcome |
| 🔨 **Moderator** | one server | Bans, kicks, tempbans, purge, ban records |
| 🤝 **Helper** | one server | Warnings, short timeouts, cases and notes |
| 👤 **Everyone** | | Help, info, verify |

Every command with its rank: **[docs/ranks.md](docs/ranks.md)** (generated from the code with `npm run docs`, and checked by the tests so it never goes stale).

## 🚀 Deploying

Runs on any Node 24 host. On Wispbyte (or any panel that runs one file):

```
cd /home/container && node launch.js
```

1. Upload the project and a `.env` (copy [`.env.example`](.env.example) and fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DEVELOPER_IDS`).
2. Start the server. `launch.js` installs dependencies on first start and restarts the bot if it ever stops.
3. Invite the bot with a developer account. The server is authorized automatically and a setup panel appears.
4. Press **Set up logs** on the panel (or run `/setup logs setup`).

All settings live in `data/vanguard.db`. Back up the `data/` folder now and then.

## 🔄 Automatic updates

Push to `main` and the live bot updates itself:

```
push → GitHub runs build + all tests → server checks every 5 min → installs → restarts
```

- A commit is installed **only if CI passed** for it. Failing or running tests are skipped.
- If a new version crashes within 2 minutes, the server **rolls back** to the previous version and skips the bad one.
- `.env` and `data/` are never touched.

Turn it on by adding to the server's `.env`:

```env
UPDATE_REPO=aidendixon602-png/midtown-vanguard
UPDATE_TOKEN=github_pat_...   # fine-grained, read-only Contents + Actions, this repo only
```

> ⚠️ Anyone who can push to `main` can change the live bot. Keep the repo private and review what you merge.

## 🧑‍💻 Development

```bash
npm ci
npm run build     # compile src/ → dist/ (dist/ is committed; CI checks it matches)
npm test          # 480 tests
npm run dev       # run from source
```

| Script | What it does |
|---|---|
| `npm run build` | Clean and compile `src/` to `dist/` |
| `npm start` | Run the compiled bot |
| `npm run check` | Type-check |
| `npm test` | Run the test suites |
| `npm run doctor` | Check configuration and command loading |
| `npm run docs` | Regenerate docs/commands.md and docs/ranks.md from the code |
| `npm run database:restore` | Restore a verified database backup (bot stopped) |

**Never run two copies with the same token.** A database lease refuses a second copy on the same database, but two hosts would both answer.

<details>
<summary><b>Project layout</b></summary>

```
src/
  index.ts         entry point: client, health endpoint, startup
  bot/             command registry, routing, permissions, guild lifecycle
  commands/        one file per slash command, by category
  security/        anti-nuke engine, moderation, network bans, /role rules
  audit/           ban log, server event log, log setup, redaction
  database/        SQLite store, migrations, scheduled backups
  recovery/        snapshots and the restore engine
  integrations/    Roblox lookups
  features/        automod, appeals, welcome, autoreact and more
  ui/              embeds, buttons, panels
launch.js          host launcher: install, import, supervise, auto-update
test/              node:test suites
docs/              documentation
dist/              compiled output (committed)
```

</details>

## 📚 Documentation

| Page | Contents |
|---|---|
| [commands.md](docs/commands.md) | Every command and who can use it |
| [ranks.md](docs/ranks.md) | Every rank and the commands it unlocks |
| [changelog.md](docs/changelog.md) | Version history |
| [security-controls.md](docs/security-controls.md) | Anti-nuke behaviour and controls |
| [server-lifecycle.md](docs/server-lifecycle.md) | Invites, authorization and deadlines |
| [recovery.md](docs/recovery.md) | Snapshots, restores and rate limits |
| [hosting.md](docs/hosting.md) | Persistent hosting and the health endpoint |
| [architecture.md](docs/architecture.md) | How the code fits together |

## 🔒 Security

Never commit `.env`, tokens or `data/`. CI blocks commits that contain a token, an API key or a database. If a token leaks, reset it in the Discord Developer Portal straight away. See [SECURITY.md](SECURITY.md).
