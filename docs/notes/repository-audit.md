# Repository review — October 15, 2026 (UTC)

## Scope

Reviewed the remaining command routing and permission paths, component handlers, moderation and anti-nuke flows, Roblox verification and role synchronization, logging/outbox delivery, database maintenance, recovery, lifecycle and startup scheduling. Registration loads all 61 commands and 30 component handlers successfully.

This is a source review with local regression and integration tests. No production database, live Discord server, or real verification-provider account was used. Passing tests do not establish that every live Discord permission or provider response is correct.

The earlier changes remain separate: #1 (HTTP cancellation), #2 (verified startup recovery), #3 (update concurrency), and #4 (ban confirmation safety). This audit is based on the same main commit, `f991d512dde21d6911fe4ebade3e5d9f18624dc7`.

## Confirmed findings and changes

| Area | Observed problem | Change |
|---|---|---|
| Automatic roles | Roles with no Discord permission bits could still confer Vanguard staff, command, or anti-nuke whitelist access. Verification and group binds considered them safe. | Centralize automatic-role eligibility; check it during setup, verification before and after provider reads, group binding/sync, quarantine assignment, and settings rollback. Whitelist roles also require owner-approved delegation through `/role`. |
| Quarantine command access | A quarantined member could retain Vanguard command access through an internal staff grant even after Discord permission roles were stripped. | Block commands requiring server authorization while quarantine is active. Current owners and developers retain access; public/help paths remain available and staff release restores normal access. |
| New-account controls | Alert buttons checked the bot's ability to act but skipped the acting moderator's role hierarchy. Failed member lookups were treated as absence. A shared Timeout Members requirement also blocked Ban Members-only actors before the action-specific check. | Fetch current membership, apply protected-target and hierarchy checks, distinguish Unknown Member from lookup failure, and use the existing per-action permission checks. |
| Automod links | Host matching used raw authority text, allowing userinfo or encoded hostnames to evade a blocked domain. | Parse the URL and match its actual normalized hostname; paths and userinfo do not count as the destination host. |
| Deferred record logs | Record posts/edits could continue after authorization was revoked during channel lookup. | Recheck authorization and readiness immediately before the Discord mutation. |
| Background batch fairness | Paused/inactive rows could fill every limited batch, starving other servers' logs, due temporary unbans, and verification refreshes. | Apply current server eligibility before each batch limit, preserving inactive rows for their normal retention or future authorization. |
| Automod records | A rejected timeout still created an `automod timeout` case, and a failed deletion could be reported as messages deleted. | Record only confirmed timeouts and describe confirmed deletion outcomes. |
| Group-sync results | Failed role additions/removals were reported using the intended counts as successful changes. | Count only completed operations and report failed role changes. |
| Rejoin role history | A later full departure with no ordinary roles left an older saved-role snapshot intact; partial departures could overwrite a complete snapshot. | Clear an old record on an authoritative empty departure, and preserve complete records when the departure is partial. |
| Case search | Filtering for `tempban` missed cases stored as `tempban (1 day)` or other labeled variants. | Match both the exact action and its parenthesized variants. |
| Inactive-server retention | Cleanup used an older table list and left newer operational data such as notes, staff roles, scam settings, temporary bans and saved rejoin roles behind. | Derive cleanup from the maintained guild-scoped table inventory, preserving authorization/network audit records and taking a verified safety backup first. |
| Owner and backup recipients | Missing environment configuration silently selected a fixed owner account and sent trusted bot DMs, including database backups, to it. | Remove built-in identities, trim configured IDs, validate owner/recipient inputs, and display an unconfigured owner clearly. Explicit developers still work without an owner; no recipients are selected if both owner and trusted DM settings are blank. |
| Staff-role history | Staff commands wrote incomplete history that either targeted the legacy table or had an unsupported component name. | Both commands snapshot role identity and the full current/legacy access rows. Rollback restores both tables transactionally after a verified backup, rechecks rank hierarchy, and records its actual before/after state so the rollback can itself be undone. Older incomplete entries require an explicit role change. |
| Shared Roblox bans | Turning sharing on copied temporary-ban-linked blacklist entries to partners despite the local-only temporary-ban policy. | Skip those entries and remove any previously shared copy for this guild, preserving the local blacklist and other guilds' records. |
| Quiet hours | A failed start could leave the ownership flag set and suppress retries; a partial unlock cleared the flag too early. | Claim ownership inside the lock operation, release it when no recoverable scheduled lockdown exists after failure, and retain it until failed unlocks have been retried. |
| Updater request deadlines | A stalled GitHub response or response body could keep an update check pending indefinitely. | Abort each GitHub request after 15 seconds (one second for local API fixtures), including response-body reads. |
| Updater installation result | Failed installs returned an installed result; both outcomes left the last-check status at installing. | Report the actual installation outcome, update the last-check status, and only schedule fallback promotion after a successful install. |
| Manual missing-database restore | The restore command treated an absent live database as corruption and required the corruption override. | Skip live lease inspection only when the path is absent. Existing corrupt files still require the override; active leases block restoration even with it. |
| Owner/developer anti-nuke access | Rank inheritance allowed Head Admins and higher bot-wide ranks to manage protection and whitelist settings. Related panels, bot approvals, command switches and history could offer alternate paths. | Require the current server owner or a configured Developer before rank inheritance for all anti-nuke commands and panels, whitelist controls, held-bot/incident controls, security configuration, quarantine/release and shared log setup. Apply the same identity check to anti-nuke command switches, saved-setting rollback and control-panel containment/release; recheck confirmation and post-backup ownership. Staff grants, Discord Administrator, whitelist entries and lower bot-wide ranks do not delegate control. Held bots added by Supreme Leaders now await owner/developer approval. |

## Validation

- Added 66 tests covering the findings, including 11 owner/developer access tests with rank/permission matrices, ownership transfers, stale confirmations, help visibility and indirect mutation paths. Of the earlier 24 follow-up tests, 22 fail against the earlier audit code; the two existing corruption/active-lease safeguards pass before and after.
- Typecheck and build pass; regenerated output is committed with the source changes.
- Full local suite on the expanded audit branch: 552 passing.
- Combined validation with #1–#4: typecheck and build pass, and all 578 tests pass with the owner/developer restriction in place.

## Live verification still needed

Before deploying, use a test server to exercise verification with a plain role and a protected role, new-account Release/Kick/Ban controls with different staff roles, quarantine and release, staff-role rollback, quiet hours, and automatic temporary-ban expiry. Confirm `BOT_OWNER_ID` and `TRUSTED_DM_IDS` name your intended accounts before relying on owner access or backup DMs. Local tests use controlled Discord responses and cannot verify the host's actual role ordering, enabled intents, permissions, or provider credentials.
