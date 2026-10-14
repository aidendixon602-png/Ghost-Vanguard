# Snapshots and backups (2.12.0)

Snapshots and backups are saved copies of a server's roles, categories, channels and permission overwrites. They are stored together and numbered **per server**: #1, #2, #3…

## Numbering

- Each server has its own numbers; other servers never cause gaps.
- A new point gets the server's highest remaining number + 1. Deleting #1 while #2 and #3 exist means the next is #4, so a number seen in an old log never silently points at a different backup.
- Deleting every point starts the server again at #1.
- Existing points were renumbered per server automatically on upgrade (oldest = #1).

## Types

| Label | Created by |
|---|---|
| Snapshot | `/recovery snapshot create` |
| Anti-nuke baseline | anti-nuke turning on (automatically or `/antinuke enable`) |
| Backup | `/recovery backup create` |
| Scheduled backup | `/setup config backups` schedule |
| Pre-restore backup | taken automatically before every restore |
| Layout copy | `/recovery copylayout` (stored in the destination server) |

## Commands

- `/recovery snapshot list` and `/recovery backup list` (backups only), newest first.
- `/recovery snapshot restore number:<#>` / `/recovery backup restore number:<#>` (newest by default), with preview and confirmation.
- `/recovery snapshot delete numbers:` and `/recovery backup delete numbers:` accept `3`, `3,5,7`, `2-6` or `all`; one confirmation button deletes exactly what was reviewed. `/recovery backup delete` only touches backups.
- `/recovery snapshot cleanup older_than_days:<n> [type] [keep_latest] [confirm:DELETE]` deletes by age and type, previewing first. `older_than_days:0` means any age; `keep_latest:0` keeps none. Types include **Anti-nuke baselines**.

Deleting never changes current server roles/channels, restore mappings or the audit history. Access: server owner, configured developers and security admins.
