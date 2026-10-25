# Server lifecycle and invites

## Invite link

On every successful start the terminal prints a public server-installation link. It requests the `bot` and `applications.commands` scopes with the permissions the bot needs, including View Audit Log, and contains no token or API key. If the bot is in no servers, it says so and asks you to invite it. A server command received while the guild is unavailable returns a server-specific invite link and tells the user to wait for reconnection if the bot is already a member.

## Setup advice

When the bot is added (or re-added) to a server, it follows the authorization notice with a short setup message recommending two things, with its current status for each:

- **Administrator permission**, so containment, permission rollback, restores and lockdowns never fail on a missing permission.
- **Its role above every other role**, because Discord only lets a bot act on members whose highest role is below its own.

It is posted in the system channel or the first channel where the bot can send embeds, and is not repeated on restarts.

## Developer invites

Keep approved Discord user IDs in `DEVELOPER_IDS` and invite the bot with one of those accounts, with **View Audit Log** granted. The bot checks the latest `BOT_ADD` audit entry. If it names this bot and the current installation time, and its executor is a developer, the server is authorized automatically, server systems start, and the 120-second leave timer is cancelled. A developer merely being a member does not count.

If Discord does not expose the inviter, or the bot lacks View Audit Log, an authorized Developer can run `/dev server authorize` within 120 seconds. Other inviters keep the same window. Server bans and explicit deauthorization always take precedence. Servers the bot already left need a fresh invite.

The lookup is bounded: up to three reads for a recent pending join (750 ms apart), one read for an older pending install at startup, and a 2.5-second timeout per request. Already-authorized servers need no lookup, and nothing polls continuously.

## States

| State | Behavior |
|---|---|
| `PENDING_AUTHORIZATION` | Deadline is the join time plus 120 seconds. No protected work; only information and developer lifecycle commands. |
| `AUTHORIZED` | Authorization metadata is saved, server systems start, and protected commands and jobs can run. |
| `DEAUTHORIZED` | Protection is disabled, the generation is invalidated, confirmations, cooldowns and caches are cleared, integrations are cancelled, and the bot leaves. |
| `EXPIRED` | A final check confirmed no authorization. Cleanup, a best-effort final message, then leave. |
| `BANNED` | Invite attempts are logged. Nothing is initialized and the bot leaves. |

The database keeps the guild ID and name, join time, original deadline, who authorized and when, who removed it and when, bot and config version, generation and state. Bans are stored separately with reason, actor and time, and an append-only event table preserves every transition. Settings expose a derived `authorized` value; no authorization boolean is stored or trusted.

## Restarts and races

Pending deadlines are restored on restart without a new window. Pending installs get one bounded developer-invite check first; otherwise already-expired deadlines are processed immediately. Authorization and expiry share a per-guild queue, so whichever commits first wins: if authorization commits first, expiry sees it and does not leave, and if expiry commits first, a later authorization is rejected.

Revocation changes the database state synchronously before any cleanup or network call. Queued and in-flight protected work carries a generation token and checks it before each further step, so old work cannot resume after re-authorization. A request already submitted to Discord cannot be recalled.

Announcements use the system channel or a cached sendable channel and never mass-mention. Missing send permission does not extend the deadline, final announcements have a short deadline, failed leaves retry, and a restart resumes leaving for terminal states.
