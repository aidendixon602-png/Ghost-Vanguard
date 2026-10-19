# Snapshots, restore and layout copy

Snapshots record a server's roles, categories, channels, role order, supported channel properties and permission overwrites. Restores rebuild that layout from a snapshot, from a manual backup, or from another server.

## Commands

| Command | What it does |
|---|---|
| `/recovery snapshot create` | Save a baseline of the current layout. |
| `/recovery snapshot view page:<n>` | Browse every saved snapshot and backup, including older and legacy entries, with Previous/Next buttons. |
| `/recovery snapshot restore` | Pick **All** or individual components, review the per-object preview, then press Confirm. |
| `/recovery snapshot delete id:<ID>` | Review and confirm deletion of a saved recovery point. Blocked during an active recovery. |
| `/recovery backup create` / `/recovery backup restore` | Manual layout backup, restored through the same flow. |
| `/recovery copylayout destination_id:<server ID>` | Use the current server as the source and copy it to another. Both servers must be authorized, and you need Vanguard security access in both. |

**All** is the first option and expands to Roles, Categories, Channels, Permissions and Settings. Confirmations are bound to the user and server, expire after two minutes, and check that the snapshot has not changed since the preview.

## Cleaning up old recovery points

`/recovery snapshot delete id` removes one recovery point after a confirmation. To remove many at once, use `/recovery snapshot cleanup`:

| Option | Meaning |
|---|---|
| `older_than_days` | Delete points older than this (required) |
| `type` | All, manual snapshots, manual backups, scheduled backups, automatic pre-restore backups, or layout-copy templates (default: all) |
| `keep_latest` | Always keep this many of the newest matching points (default 1, minimum 1) |
| `confirm` | Type `DELETE` to delete; without it you only get a preview |

Run it without `confirm` first to see how many points would go and their date range. Every deletion is recorded in the recovery audit history and summarized in the security log. Deleting recovery points never changes the server itself or the stored restore mappings.

## Who can see snapshots

Snapshots and backups belong to the server they were taken in. `/recovery snapshot view`, `restore`, `delete` and `cleanup` only ever see the current server's recovery points, and the database refuses cross-server reads. The one deliberate exception is `/recovery copylayout`: it stores a copy of the source server's layout in the destination server, and only someone with Vanguard security access in both servers can run it.

## How a restore works

1. Validate the snapshot and check that the preview still matches the live server.
2. Save and read back a fresh backup of the destination. If this fails, nothing is changed.
3. Match saved objects to live ones: stored mappings first, then exact IDs, then cautious matching. A role matched by name must also match appearance and permissions; a category or channel needs a unique name, type and parent.
4. Roles (top to bottom, in descending slots below Vanguard), then role hierarchy, then categories and channels in saved order, then positions, then permission overwrites, then settings.
5. Verify, save mappings, and write the report.

Rules that keep it safe:

- Ambiguous matches, managed or integration roles, hierarchy slots Vanguard cannot manage, and unsupported channel types are skipped and reported, never guessed or duplicated.
- New roles are created with no permissions and new channels start private. Saved permissions are applied in a later phase, and overwrites that cannot be resolved leave the channel private and are reported.
- Mappings are saved as each object is created, so repeating a restore, even after a restart, reuses objects instead of duplicating them.
- Existing extras are not deleted. The explicit `prune` option only runs when nothing was skipped or failed, and needs an extra destructive confirmation.
- Supported settings: AFK timeout and channel, verification level, explicit content filter, default notifications, locale, and the system, rules and public-updates channels. Older snapshots without settings still work and report the omission.
- Forum and media channels need a Community server; otherwise they are skipped and reported.

The report counts Created, Updated, Reused, Reordered, Unchanged, Skipped and Failed. An object can be reused and then updated, and Reordered counts ordering requests, each of which can move many objects. Full reports are stored per guild in `recovery_history` and attached to the reply, and the log channel gets a summary.

## Rate limits

Discord's rate limits are enforced by Discord and cannot be switched off. Bulk operations like restoring a large server are what hit them, in particular creating many roles and channels.

- discord.js queues requests per rate-limit bucket and waits out normal limits by itself.
- During a restore, a wait of **up to 15 minutes** is waited out automatically, with progress messages like `Discord API wait: 45s on POST /guilds/:id/roles; retrying automatically.`
- A longer wait stops the restore cleanly. Completed changes and object mappings are saved, the destination backup ID is recorded, the locks are released, and the report says when to retry. Run the restore again after that time and existing objects are reused.
- The 15-minute cap sits just under Discord's interaction-token lifetime. It is `MAX_RATE_LIMIT_WAIT_MS` in `src/recovery/limits.ts`.
- For very large servers, restore in stages (Roles, then Categories, then Channels, then Permissions) so each stage works against its own limits.

### Optional pacing

Set a gap between restore actions in `.env`:

```ini
SNAPSHOT_ACTION_DELAY_MS=1000
```

Valid values are whole milliseconds from 0 to 60000. The default is `0` (no added delay). The gap is measured from when the previous action finished, and the first action is never delayed. A modest delay can avoid long waits on big restores. Actions always run sequentially, and role and channel position changes are single bulk requests.

## Locks and long restores

Only one recovery operation can hold a guild at a time, and a layout copy locks both servers. Locks are database leases that renew while work runs and expire after a crash. A generation check stops the operation if authorization is revoked or replaced, and locks are released on success and on failure.

A long restore can outlive Discord's 15-minute interaction token. Progress delivery failures do not abort the restore, progress updates are throttled to once per five seconds, the full report is saved in the database, and a summary goes to the configured log channel.

## Restoring after an incident

When an incident's actor deleted channels or roles in the 10 minutes before it, the incident alert in your log channel shows a **Review restore** button. It opens the same preview as `/recovery snapshot restore`, using the newest snapshot taken before the first deletion (layout-copy templates are skipped), with the matching components selected. It restores the whole snapshot for those components, so changes made since that snapshot are reverted too. Check the preview, adjust the components if needed, then confirm. Only people with Vanguard security access can use it, and the reply is visible only to them.

## Audit history

Guild-scoped `recovery_events` records snapshot and backup creation and deletion, restore start, completion and failure, and layout-copy preparation, start, completion and failure, each with actor, snapshot ID, time and details. Records survive snapshot deletion. `snapshot_metadata` marks backups and copy templates, and older snapshots stay readable without it. Layout-copy completion is logged in both servers, and a backup is validated and read back before success is announced.

## What recovery cannot do

Recovery does not bring back original object IDs, messages, member-role assignments or integrations, and Discord's final hierarchy rules still apply. It is manual and button-confirmed, never an automatic rollback after an incident. Enforcement in anti-nuke removes manageable dangerous roles but cannot touch the owner, higher roles or some managed permissions, and join-flood detection alerts without guessing who an attacker is. Protection needs a connected gateway, View Audit Log, Manage Roles and the right role hierarchy. Start in observe mode, review incidents, add explicit bot exemptions, then choose enforce.
