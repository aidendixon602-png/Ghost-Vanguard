<div align="center">
  <img src="assets/ghost-vanguard-logo.png" alt="Ghost Vanguard logo" width="176">
  <h1>Ghost Vanguard</h1>
  <p><strong>One Discord bot for security, moderation, recovery, and support—across your whole server network.</strong></p>
  <p>
    <a href="#what-it-does">What it does</a> ·
    <a href="#security-model">Security model</a> ·
    <a href="#get-started">Get started</a> ·
    <a href="#operate-it">Operate it</a> ·
    <a href="#documentation">Documentation</a>
  </p>
  <p>
    <a href="https://github.com/aidendixon602-png/Ghost-Vanguard/actions/workflows/ci.yml?query=branch%3Amain"><img src="https://github.com/aidendixon602-png/Ghost-Vanguard/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a>
    <img src="https://img.shields.io/badge/Node.js-24-339933?logo=node.js&logoColor=white" alt="Node.js 24">
    <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="Strict TypeScript">
    <img src="https://img.shields.io/badge/discord.js-14-5865F2?logo=discord&logoColor=white" alt="discord.js 14">
  </p>
</div>

---

Ghost Vanguard is a **single-process, multi-server Discord security and operations bot**. It combines anti-nuke safeguards, raid response, moderation, audit trails, server recovery, a staff dashboard, and a full ticket desk in one application backed by SQLite.

> **Commands are slash commands.** Type `/` in Discord and select **Ghost Vanguard**. Use `/help` to see the commands your account can access. Message-prefix commands are not supported.

## What it does

### Protects servers

- **Anti-nuke:** watches dangerous server changes across 19 rules. New or unconfigured servers begin in observe mode; enforcement starts only after readiness checks and an explicit confirmation.
- **Measured response:** routine or ambiguous activity is alert-first and can warn before escalation. High-confidence takeover signals retain immediate safeguards. Tune thresholds and controls per rule and per server.
- **Raid response:** lockdown and emergency controls, new-account holds, join-flood detection, lookalike-name waves, and coordinated message-wave handling.
- **Content protection:** spam, link and invite controls, scam-link and scam-image detection, staff anti-ping, and optional AI moderation.
- **Whitelist:** exempt people or roles globally or per rule, with optional expiry and verification-bot recognition.

### Gives staff context—not automatic punishment

The **threat board** combines confirmed incidents into Watch, High, and Critical triage levels. Scores decay and expire; they do not ban, strike, quarantine, or otherwise contain a member on their own. Staff retain the controls to review evidence and decide what to do.

### Keeps moderation and records together

- Ban, tempban, softban, massban, kick, timeout, warnings, cases, notes, and appeals.
- A per-server ban record and audit history, including bans made directly in Discord or by another bot when Discord exposes the event.
- **Genrebans and hardbans are distinct network-wide ban types.** Each can be issued while the other is active; neither silently revokes the other.
- **Network-ban actions are Developer-only:** issuing, revoking, lifting from the ban log, and managing one-server genreban exceptions.

### Runs the operations around your community

- Panel-driven tickets with claims, transcripts, member ratings, staff reminders, and weekly reports.
- Server-layout snapshots, verified database backups, previewed restores, and recovery tools.
- Audit logging, a private staff control panel, and a read-only dashboard with server, protection, ticket, and incident views.
- A supervised launcher, health endpoint, and optional CI-gated updates with rollback.

## Security model

Ghost Vanguard separates **server permissions**, **bot-wide ranks**, and **Developer access**. A Discord Administrator permission is not a shortcut to weakening protection or changing bot-wide settings.

| Rank | Scope | In brief |
|---|---|---|
| **Developer** | Bot-wide | Bot owner (`BOT_OWNER_ID`) and approved IDs in `DEVELOPER_IDS`. Full bot control, including network bans, data recovery, server authorization, and bot-wide ranks. |
| **Supreme Leader** | Bot-wide | Diagnostics, update status, and database health/backup tools. Cannot use Developer-only commands or network-ban controls. |
| **Overseer / Bot Manager** | Bot-wide | Cross-server operations appropriate to the rank, such as inspecting or authorizing servers and Bot Manager-level staff tools. No Developer-only network-ban access. |
| **Server Owner** | One server | Server-level authority in their own server, but no bot-wide tools. |
| **Head Admin / Admin / Moderator / Helper** | One server | Scoped staff tools according to rank and configured roles. |

**Network-ban permissions are deliberately narrower than ordinary moderation:** only Developers may issue or lift a genreban or hardban, or grant/revoke a one-server genreban exception. Local staff can still manage ordinary server bans without changing a network ban.

For the complete command-to-rank map, see [the generated rank reference](docs/ranks.md) and [command reference](docs/commands.md).

## Get started

### Requirements

- **Node.js 24 or newer** (the project uses `node:sqlite`).
- A Discord application and bot token.
- The **Server Members** and **Message Content** privileged intents enabled in the Discord Developer Portal.
- Persistent storage for the database and backups in any hosted deployment.

### Install and configure

From PowerShell:

```powershell
git clone https://github.com/aidendixon602-png/Ghost-Vanguard.git
Set-Location Ghost-Vanguard
Copy-Item .env.example .env
notepad .env
npm ci
npm run check
npm run build
```

Set at least `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and `DEVELOPER_IDS` in `.env`. Set `BOT_OWNER_ID` if you want a configured owner account. Keep the real `.env` private; never commit it.

For a local development run, use:

```powershell
npm run dev
```

For a supervised deployment, start one instance with:

```powershell
node launch.js
```

The launcher supervises the process and can apply optional CI-gated updates. See [hosting and persistence](docs/user/hosting.md) before deploying to a container or hosted panel.

### Bring a server online

1. Invite the bot with the required scopes and permissions. Use a Developer account to authorize the server.
2. Run `/setup logs setup` to create the active **Ghost Vanguard Logs** layout. The legacy **VEIL LOGS** category is renamed and archived; its channels and message history are preserved.
3. Run `/antinuke check` and address any missing permissions or role-hierarchy warnings.
4. After readiness passes, run `/antinuke enable` and confirm the change. New and unconfigured servers remain in observe mode until explicitly enabled.
5. Create the staff panel with `/setup panel`, map staff roles with `/setup staff role`, and post the ticket panel with `/ticket setup` as needed.

## Operate it

### Persistence and availability

- Run **one instance per bot token and database**. A database lease rejects a second worker; multiple hosts sharing a token can still duplicate Discord event handling.
- Mount persistent storage and point `DATABASE_PATH` and `DATABASE_BACKUP_DIRECTORY` at it. An ephemeral container filesystem can lose server authorization and records on redeploy.
- Keep an independent off-host copy of important backups. Stop the bot before copying SQLite files by hand, or use the built-in online backup tools.
- `/healthz` is unavailable until startup checks, command registration, and gateway readiness complete; then it reports health and runtime information.

### Dashboard safety

The dashboard is read-only. If you enable it on a network-facing host, configure `DASHBOARD_TOKEN` and follow the exposure guidance in the [dashboard guide](docs/user/dashboard.md). Do not assume that a reachable host port is private.

### Automatic updates

Automatic updates are optional. Set `UPDATE_REPO` and a fine-grained, read-only `UPDATE_TOKEN` with access to repository contents and Actions. The launcher checks `main` for a CI-passing commit before installing it. Failed starts can be rolled back; `.env` and `data/` are not replaced. See `.env.example` and [hosting.md](docs/user/hosting.md) for details.

## Development

```powershell
npm ci
npm run check       # type-check
npm test            # full Node test suite
npm run docs        # regenerate command and rank references
npm run build       # compile src/ into the committed dist/
```

CI checks types, build output, tests, generated documentation, and secrets. When changing commands or ranks, update the source definitions and run `npm run docs`; do not hand-edit the generated command/rank pages.

See [CONTRIBUTING.md](CONTRIBUTING.md) for pull-request guidance and [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Documentation

| Guide | Use it for |
|---|---|
| [Commands](docs/commands.md) | Every slash command and its required access |
| [Ranks](docs/ranks.md) | Bot-wide and server-level permissions |
| [Server lifecycle](docs/user/server-lifecycle.md) | Invites, authorization, and removing a server |
| [Security controls](docs/user/security-controls.md) | Anti-nuke decisions, warnings, strips, and reversions |
| [Anti-nuke rules](docs/user/antinuke-locked.md) | Shipped rules, limits, and controls |
| [Threat board](docs/user/threat-board.md) | Scoring, evidence, and staff triage |
| [Recovery](docs/user/recovery.md) | Snapshots, backups, and restores |
| [Dashboard](docs/user/dashboard.md) | Access, security, and the dashboard views |
| [Hosting](docs/user/hosting.md) | Persistent disks, startup, health checks, and rate limits |
| [Architecture](docs/user/architecture.md) | How the codebase is organized |
| [Changelog](docs/changelog.md) | Product and command history |

## Repository layout

| Path | Purpose |
|---|---|
| `src/bot/` | Command registry, routing, permission guard, and rank model |
| `src/commands/` | Slash-command handlers |
| `src/security/` | Anti-nuke, moderation safeguards, and network-ban enforcement |
| `src/audit/` | Ban records, audit logs, and channel setup |
| `src/database/` | SQLite store, migrations, and backup logic |
| `src/recovery/` | Server snapshots and restore workflows |
| `src/features/` | Tickets, automod, joins, and scheduled features |
| `src/dashboard/` | Dashboard UI and read-only API |
| `docs/` | Generated references and operator guides |
| `test/` | Node.js test suites |
| `dist/` | Compiled runtime included for supported hosts |

## License

This repository is publicly visible, but **no open-source license is granted**. All rights are reserved. Public visibility does not grant permission to reuse, redistribute, or modify the code without prior written permission.
