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
| `type` | All, manual snapshots, manual backups, scheduled backups, synced backups, automatic pre-restore backups, or layout-copy templates (default: all) |
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

## Synced backups

With backup sync on, which is the default (`/antinuke settings backup_sync`), Vanguard keeps a recent backup of each server's roles and channels without anyone running a command. Every five minutes it compares the server with its newest backup. When they differ and the server has looked the same on two checks in a row, it saves a **Synced backup**. A burst of edits makes one backup, two are at least 15 minutes apart, and the newest five are kept. It never deletes manual, scheduled or baseline backups.

A synced backup follows the server and never changes it. Restoring one gives you the server as it was a few minutes ago, not as it was the last time somebody remembered to back it up. Saving is quiet: it is in the audit history and posts no card in the log.

It holds off while something looks wrong, so that the backups from before a problem are not pushed out by copies of the problem:

- raid mode or a lockdown is on
- anti-nuke recorded an incident in the last hour (incidents for people who are never punished do not count)
- three or more channels or roles were deleted in the last ten minutes
- the server has at least 8 fewer channels (or roles), and a third fewer, than its newest backup. Sync pauses and says so once in the security log. If the smaller server is what you meant, save a backup by hand with `/recovery backup create` and syncing carries on from there. If it is not, review a restore.

It saves nothing in a server where anti-nuke is off, where backups are off (`/setup config feature snapshots`), or where `backup_sync` is switched off.

## Automatic restore

When anti-nuke contains someone who deleted channels or roles (enforce mode, and not a first-hit warning), Vanguard puts those channels and roles back by itself, from the newest backup saved before the first deletion. It is on by default; `/antinuke settings auto_restore:false` turns it off.

- **It waits for the deletions to stop.** Nothing is restored until the person has deleted nothing for 10 seconds, so the restore does not race a script that is still running. A spree that never stops is restored anyway after two minutes.
- **Only what was deleted comes back.** The list is the one anti-nuke wrote down from the audit log, not a comparison of the whole server with the backup. A role renamed or a channel edited on purpose since the backup is left as it is, and a channel with the same name in another category is not mistaken for the deleted one.
- **Objects return with their saved settings:** category, order and permission overwrites for channels, permissions and order for roles. An overwrite that points at a role that could not be restored is skipped and named in the card.
- **One card says what happened:** which backup was used and when it was saved, what came back, what was not in the backup (made after it was saved), what is still missing and why. It reads "Partly put back" unless everything deleted is back and nothing was skipped. A channel whose saved permissions point at a role that is not coming back is restored private and named in the card. Messages in a deleted channel are gone for good; Discord does not keep them.
- **When it cannot:** if no backup was saved before the deletions, or what was deleted is newer than the newest backup, the card says so. Backup sync is what keeps the newest backup recent. A restore that finds another recovery running, or the server changing under it, is tried again up to three times; any other error is reported at once. **Review restore** on the incident card still works by hand.
- **Not for people who are never punished.** The server owner, Developers and whitelisted people are recorded but not contained, so nothing they delete is put back behind their back. Observe mode never restores, and servers with backups switched off are skipped.

The restore uses the same engine as `/recovery snapshot restore`, in a mode that creates what is missing and edits nothing else. It takes a pre-restore backup first, like any restore, and the audit history records it.

## Restoring after an incident

When an incident's actor deleted channels or roles in the 10 minutes before it, the incident alert in your log channel shows a **Review restore** button. With automatic restore on, most of what was deleted is already back by the time you look; the button is for anything the card says is still missing, or when you want the whole snapshot back. It opens the same preview as `/recovery snapshot restore`, using the newest snapshot taken before the first deletion (layout-copy templates are skipped), with the matching components selected. It restores the whole snapshot for those components, so changes made since that snapshot are reverted too. Check the preview, adjust the components if needed, then confirm. Only people with Vanguard security access can use it, and the reply is visible only to them.

## Audit history

Guild-scoped `recovery_events` records snapshot and backup creation and deletion, restore start, completion and failure, and layout-copy preparation, start, completion and failure, each with actor, snapshot ID, time and details. Records survive snapshot deletion. `snapshot_metadata` marks backups and copy templates, and older snapshots stay readable without it. Layout-copy completion is logged in both servers, and a backup is validated and read back before success is announced.

## What recovery cannot do

Recovery does not bring back original object IDs, messages, member-role assignments or integrations, and Discord's final hierarchy rules still apply. A restore you start is manual and button-confirmed. The one automatic restore puts back channels and roles a contained attacker deleted (see Automatic restore); it never rolls the rest of the server back. Enforcement in anti-nuke removes manageable dangerous roles but cannot touch the owner, higher roles or some managed permissions, and join-flood detection alerts without guessing who an attacker is. Protection needs a connected gateway, View Audit Log, Manage Roles and the right role hierarchy. Start in observe mode, review incidents, add explicit bot exemptions, then choose enforce.
