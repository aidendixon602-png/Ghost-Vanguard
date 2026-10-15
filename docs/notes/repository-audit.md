# Repository review — October 15, 2026 (UTC)

## Scope

Reviewed the remaining command routing and permission paths, component handlers, moderation and anti-nuke flows, Roblox verification and role synchronization, logging/outbox delivery, database maintenance, recovery, lifecycle and startup scheduling. The repository contains 158 TypeScript source modules, including 61 command modules; registration loads all 61 commands and 30 component handlers successfully.

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

## Validation

- Added 31 tests covering the findings, including success paths, failures, expiry, authorization changes during awaits, and cross-server batch fairness.
- Typecheck and build pass; regenerated output is committed with the source changes.
- Full local suite on the audit branch: 517 passing.
- Combined validation with #1–#4: all four patches apply cleanly, typecheck and build pass, and all 543 tests pass.

## Live verification still needed

Before deploying, use a test server to exercise verification with a plain role and a protected role, new-account Release/Kick/Ban controls with different staff roles, quarantine and release, and automatic temporary-ban expiry. Local tests use controlled Discord responses and cannot verify the host's actual role ordering, enabled intents, permissions, or provider credentials.
