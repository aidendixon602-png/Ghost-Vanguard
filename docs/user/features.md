# Features and administration

## Feature map

| Area | How it works |
|---|---|
| Anti-nuke rules | Fixed 19-rule preset (see docs/antinuke-locked.md). New or unconfigured authorized servers start in observe mode; `/antinuke enable` requires readiness and explicit confirmation. Existing enforcement is readiness-gated on startup; staff opt-outs persist. Limits, punishments and reverts cannot be changed. |
| Snapshot catalog | `/recovery snapshot view` pages through every saved snapshot and backup, including legacy and superseded ones. `/recovery snapshot delete` needs a user- and guild-bound, expiring confirmation. |
| Manual backup | `/recovery backup create` captures supported layout and settings; `/recovery backup restore` uses the common confirmed flow. |
| Cross-server copy | `/recovery copylayout destination_id:` copies from the current server. Both must be authorized and ready, and you need Vanguard security access in both. |
| Idempotent recovery | Stored source-to-destination mappings win, then exact IDs, then cautious unique matching. Ambiguous objects are skipped, and repeated restores reuse objects, even after a restart. See [recovery.md](recovery.md). |
| Destructive changes | Ordinary restore and copy keep extras. `prune` needs an extra destructive confirmation and is blocked after any skip or failure. |
| Reporting and audit | Created / Updated / Reused / Reordered / Unchanged / Skipped / Failed summaries, persistent full reports with actors, log-channel delivery, and copy audit in both servers. |
| Server information | `/server-info` has four pages: identity, ownership, creation, member and cache coverage, boosts, role and channel types, assets, settings, authorization, protection, snapshots and version. |
| Bot information | `/info bot` shows the developer's Discord identity, version, uptime, command count, status and real protection statistics. |
| Presence | A custom status that rotates every minute: protected servers, unique members, verified Roblox accounts (hidden when there are none) and a `/help` hint. Partial member coverage is labelled "known members", and duplicate memberships are never summed. |
| Persistence | Relational tables for guild settings, rules and defaults, providers, staff-role access, command configuration, feature switches, backup configuration, authorization, metadata, grants and histories. Snapshot documents and history versions stay JSON because they are immutable recovery records. |
| Data safety | Parameterized SQL, foreign keys, indexes, constraints, transactions, generation checks, scoped reads and mutation triggers. Explicit source and destination scopes support copies; internal maintenance scopes are only used for global backups. |
| Migrations | Schema version 3, verified pre-migration backups, transactional steps, legacy configuration preserved, failure diagnostics saved. |
| Database backups | At startup and on a schedule, using the online SQLite backup. Each is checked for integrity, foreign keys and schema, hashed with SHA-256, and recorded with size, version and status. Recent, daily and weekly retention. Failures raise health counters, are logged, and trigger developer and owner DMs with backoff. |
| Configuration history | `/config-history list/restore` records settings, grants, providers, permission roles, commands, features, backup, logging and verification settings. Owner or developer rollback needs confirmation and a verified whole-database backup first. Authorization changes stay with the developer authorization commands. |
| Guild departure | A departed guild becomes inactive and its data is kept for 90 days by default. Rejoining restores it. Expired cleanup takes a verified backup first and preserves authorization, bans and their audit. |
| Database monitoring | `/dev database status`, `/healthz`, persistent counters, storage size, last health check and last verified backup. `/dev database backups`, `/dev database backup` and `/dev database verify` for guarded backup work. |
| Threat board | Every confirmed incident scores the member behind it in `threat_scores`; Watch (25+), High (55+) and Critical (85+) are staff triage levels, never automatic punishments. Scores halve daily and expire after a quiet week. Staff keep manual list, view, clear, release and strike controls; the board never creates automatic server-log cards. See [threat-board.md](threat-board.md). |
| Dashboard | A self-contained read-only page and JSON API over the same database: servers, protection, the threat board, the ticket desk and recent incidents. Served by the bot on its health port, or standalone with `npm run dashboard`. No build step and no external assets, so it works offline. See [dashboard.md](dashboard.md). |
| Ticket desk | Panel-driven tickets with types, claim/transfer/priority, cooldown and open limits, transcripts on close with a five-second delay, DM ratings, idle auto-close and a weekly report. The numbers also appear on the dashboard. |
| Terminal logs | Readable by default, with optional JSON and debug output, credential redaction, and concise errors with diagnostic references. |

## Lockdown

`/raid lockdown` pauses the whole server during a raid. For every text, announcement, forum, voice and stage channel it:

1. records the current state of the permissions it is about to change (in the database, before changing anything);
2. posts the notice in public text channels (where `@everyone` can see the channel);
3. denies `@everyone` Send Messages, Send Messages in Threads, Create Threads and Add Reactions (plus Connect and Speak in voice and stage channels), and removes those grants from other role and member overwrites.

Staff keep their access: roles or members with Administrator, Manage Server, Manage Channels, Manage Messages or Timeout Members, the server owner, and the bot. Categories are not changed.

`/raid unlock` restores exactly the permission bits the lockdown changed, removes any `@everyone` overwrite it created, deletes the notices (pass `keep_notices` to leave them) and can post a message where the notices were. Other permission edits made during the lockdown are kept. If a channel can't be restored (for example Vanguard lost access to it), the lockdown stays open and `/raid unlock` can be run again. A lockdown survives restarts.

Snapshots taken during a lockdown capture the locked permissions, so lift the lockdown before taking a baseline you want to keep.

## Event log

`/setup logs enable` starts recording server events. Each event shows what happened, who did it, the target, and details such as changed values or the reason. Events go to the security log channel, or the channel given to `/setup logs enable`, and are stored for 30 days.

| Category | Events |
|---|---|
| Moderation | Bans, unbans, kicks, timeouts and prunes |
| Members | Joins, leaves, role and nickname changes |
| Roles | Created, changed and deleted roles |
| Channels | Created, changed and deleted channels and threads, permission overwrites |
| Server | Server settings, invites, webhooks, emojis and stickers, bots and integrations, AutoMod rules |
| Messages | Messages deleted by moderators, bulk deletes, pins |

Turn categories on or off with `/setup logs category`, and browse with `/setup logs view`, filtered by category or by a user (events done by or to them). Discord does not report people deleting their own messages, and message contents are not logged.

<!-- coderabbit-ai-generated:v1 -->

When `/setup logs setup` finds recognized Veil log channels in the old or archived category, it reuses them under Ghost Vanguard Logs. Messages and permission overrides remain intact. Channels that are public or missing the bot's required permissions are skipped and reported; fix their permissions and run setup again. `/setup logs check` checks configured channels.

Join and leave events go to `#join-logs`; member, role, channel, message, server and moderation events go to their matching channels. `#voice-logs` records voice joins, moves and leaves. `#command-logs` records successful Ghost Vanguard slash command names and users, without arguments or replies. Anti-nuke alerts are also copied to `#antinuke-logs`. Event logging and category settings still apply. If a matching channel is not configured, events use the existing combined log channel.
<!-- /coderabbit-ai-generated:v1 -->

## Restarts and downtime

All settings live in the database, so a restart or crash never resets anything. After each restart, every server's log channel gets a **back-online** notice listing the restored anti-nuke state and how long the bot was offline. The bot also reads Discord's audit log for that offline period: missed events are added to the event log, and destructive actions anti-nuke could not respond to are reported, with anyone at or above a rule's limit flagged. Nothing is enforced automatically for that period; review the report and use `/antinuke quarantine` or `/recovery snapshot restore` if needed.

## Guild administration

`/setup config` lets the server owner or a developer configure provider toggles, Vanguard permission roles, command enablement and cooldowns, feature switches (moderation, verification, AI, snapshots) and scheduled layout backups. Provider credentials stay in environment variables. Security administrators cannot grant themselves owner or developer powers, and ordinary staff have no raw SQL or database-editing command.

`/recovery backup` saves a Discord server's **layout**. `/dev database backup` saves Vanguard's **entire SQLite database**, including every guild's settings and recovery records. They are separate recovery points with separate retention. Manual layout snapshots and restore rollback points are kept until you delete them, and scheduled layout backups follow each guild's configured retention count.

## Restoring the whole database

With the bot stopped, find the backup UUID from `/dev database backups` or the metadata files in the backup directory, then run:

```powershell
npm run database:restore -- --id BACKUP_UUID --confirm RESTORE-BACKUP_UUID
```

The script checks the metadata, checksum and integrity, refuses to run while the bot's process lease is active, verifies a staged copy, and keeps the previous database with its WAL and SHM files as a rollback bundle. If the live database is unreadable you must also pass `--allow-corrupt`, after stopping the bot. This restores the **whole** database, not one guild. Old migration backups use the same lookup and are migrated again safely on the next start.

## Environment options

| Variable | Default | Meaning |
|---|---|---|
| `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` | none | Required. |
| `DEVELOPER_IDS` | none | Required. Approved developer user IDs, comma-separated. |
| `DATABASE_PATH` | `./data/vanguard.db` | Live database. Use a persistent disk when hosting. |
| `DATABASE_BACKUP_DIRECTORY` | `./data/database-backups` | Verified rotating backups. |
| `DATABASE_BACKUP_INTERVAL_MINUTES` | `60` | How often a scheduled backup runs. |
| `DATABASE_BACKUP_KEEP_RECENT` / `_DAILY` / `_WEEKLY` | `24` / `14` / `8` | Retention. |
| `GUILD_RETENTION_DAYS` | `90` | How long data is kept after the bot leaves a server. |
| `SNAPSHOT_ACTION_DELAY_MS` | `0` | Gap between restore actions. See [recovery.md](recovery.md#optional-pacing). |
| `HEALTH_HOST`, `HEALTH_PORT` | `127.0.0.1`, `7475` | Health endpoint. |
| `ROVER_API_KEY`, `BLOXLINK_API_KEY` | empty | Optional Roblox providers. Without them, existing verification roles are preserved. |
| `AI_ENABLED`, `OPENAI_API_KEY`, `OPENAI_MODEL` | `AI_ENABLED=false` | Optional `/ask` assistant. Enabling it requires `OPENAI_API_KEY` and an explicit `OPENAI_MODEL`; there is no built-in model name. |
| `LOG_FORMAT`, `LOG_LEVEL` | `pretty`, `info` | `json` is available for log ingestion. |
| `BOT_OWNER_ID`, `BOT_OWNER_USERNAME` | empty | The bot owner and the default `TRUSTED_DM_IDS`. Nothing is built in: leave it empty and no account holds the owner rank or receives the daily database backup. |

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:b736ff13692c5bfb2d902219a997686aa1706d818daf19cb864aa8f80f49b30a -->

## Manual logs and staff levels

Use `/setup logs route type:messages channel:#message-logs` to choose a private destination. Types include joins, voice, commands, anti-nuke, messages, moderation, members, roles, channels and server events. Omit `channel` to reset a route. `/setup logs status` shows routes and category switches. Manual routes do not move channels. Voice logs include mute/deafen, streaming and camera changes.

The server owner can run `/setup logs cleanup-archive` to preview permanent deletion of channels in `Archive - Veil Logs`. Confirmation deletes their message history. Active log destinations and moved channels are skipped; categories with remaining children are retained.

Assign server levels with `/setup staff role role:@Moderators rank:moderator`. Levels: Helper, Moderator, Admin and Head Admin. Only someone above the assigned level can change it. Developers can assign Bot Manager, Overseer and Supreme Leader with `/setup staff global`. Inspect with `/setup staff list` and `/setup staff check`. These commands do not grant Developer access.

## Limits worth knowing

<!-- /coderabbit-ai-generated:v1 -->

Discord cannot restore deleted object IDs, messages, member-role assignments, managed integrations or unavailable Community and premium features. Member statistics show the cached coverage, and online counts are unavailable without the presence intent.
