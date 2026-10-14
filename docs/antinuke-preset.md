# Default anti-nuke preset

`/enable` and `/antinuke enable` capture a fresh baseline, clear older shared or
individual thresholds, load this preset, and enable enforcement. Configure a security
log channel with `/security config` first. `/disable` and `/antinuke disable` use a
confirmation and stop detection/enforcement. Settings, incidents and backups are retained.

| Rule | Count | Window | Action | Revert |
|---|---:|---:|---|---|
| Ban | 5 | 60 seconds | strip | Yes |
| Bot Add | 1 | 60 seconds | strip | Yes (the bot is removed) |
| Channel Create | 6 | 120 seconds | strip (warns first) | Yes |
| Channel Delete | 3 | 120 seconds | strip | No |
| Kick | 5 | 120 seconds | strip | No |
| Permission Grant | 1 | 60 seconds | strip | Yes, including member role grants (whitelisted role managers may grant moderator perms; Administrator and Manage Server always checked) |
| Role Create | 8 | 120 seconds | strip (warns first) | Yes |
| Role Delete | 5 | 120 seconds | strip | No |
| Role Invite | 8 | 60 seconds | strip (warns first) | Yes |
| Server Update | 5 | 120 seconds | strip (warns first) | No |
| Timeout | 10 | 120 seconds | strip (warns first) | Yes |
| Webhook | 3 | 60 seconds | strip (warns first) | Creation; other events need manual review |

One step before any limit a heads-up is posted to the security log; nothing is done to the person.

Role Invite means adding a role to a member, not creating a server invitation.
Permission Grant detects newly granted Administrator, Ban Members, Kick Members,
Manage Channels, Manage Guild and Manage Webhooks. Other existing rules remain available:
Channel Update, Role Update, Member Prune, AutoMod and Join Flood.

Each rule counts an executor's actions in its configured window. Evidence is saved
before enforcement. Revert-enabled incidents use recorded events in that window, not
just the event that reaches the threshold. Timeout reverts retain a later manual change.
Role-grant reverts remove only the assigned editable roles. Managed roles, hierarchy
restrictions, the server owner, developers and trusted accounts remain protected.

Webhook creation can be undone by deleting the created webhook. A deleted webhook's
original ID, URL and token cannot be recreated; update/deletion events are reported for
manual review. Role/channel deletion rules do not auto-restore deleted objects; use the
existing snapshot review and recovery controls.

The saved configuration survives restart. `/enable` deliberately reloads this preset;
customize thresholds afterwards with `/antinuke rule` or `/antinuke-rule`. A 120-second
window is available in the rule menu. Observe mode remains selectable with `/antinuke mode`.

For Wispbyte, upload the patched source, compiled modules and package files, then restart.
Keep the host's database and credentials. The new `/enable` and `/disable` commands are
synchronized on startup; Discord command refresh may take a little time.

`/antinuke status` and `/antinuke rules` show the Antinuke Status embed: current state, configured limits/actions, revert flags and active explicit anti-nuke bypasses. Enabled enforcement is green, observe mode orange and disabled protection red. Whitelist mentions do not send notifications. Verification exemptions are scoped to member-role updates and do not appear as unrestricted bypasses.
