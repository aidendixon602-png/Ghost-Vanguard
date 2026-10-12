# Security controls — Vanguard 2.9.2

Run `/antinuke status` for Refresh, View Incidents, Manage Whitelist and Edit Rules.
Controls recheck security access, server authorization and the user/server that opened
the panel. Whitelist mentions do not notify anyone. The whitelist panel grants 24-hour
bypasses; use `/trust` for different durations, permanent bypasses and verification-only
bot exemptions. Another administrator must change your own bypass or a role you hold.

| Command | Behavior |
|---|---|
| `/antinuke check` | Report permissions, log-channel overwrites and hierarchy |
| `/enable` | Check readiness, capture a baseline and enable the default preset |
| `/disable` | Stop protection after confirmation; keep saved data |
| `/antinuke toggle name enabled` | Turn an individual rule on or off |
| `/antinuke preset action:save name` | Save current limits and toggles, up to 20 presets per server |
| `/antinuke preset action:load name` | Load limits and toggles; retain mode, whitelist and enabled state |
| `/antinuke preset action:list` | List this server's presets |
| `/antinuke preset action:delete name` | Delete a named preset |
| `/antinuke preset action:reset` | Restore default limits and turn all rules on; retain mode and whitelist |
| `/trust manage [user\|role]` | Panel: pick who, tick what they may do (Everything, a ★ preset or single actions), pick how long, Save. Save replaces what they had; Remove all clears it. |
| `/trust remove user/role` | Revoke the selected exemption |
| `/trust list` | Show active exemptions and expiration times |

`/enable` intentionally reloads the default preset. Load a custom preset afterwards.
Enable rejects missing permissions, inaccessible log channels and regular roles at or
above Vanguard. Managed integration roles are excluded from the hierarchy check.
Startup retains saved settings and reports readiness problems instead of silently
resetting protection. A missing security log permission is also reported in the console.

Incident reports include executor, triggering target, rule, count/window, mode,
punishment and completed/failed/skipped revert counts. Each reviewed event updates the
stored incident. Larger incidents publish progress updates after the first reviewed event
and every ten events, followed by the final report. An interrupted revert is not resumed
automatically; review the recorded progress and recovery controls after a crash.

Role bypasses cover all anti-nuke rules. Verification-only exemptions cover ordinary
member-role updates and never dangerous permission grants. Both expire automatically. Newly assigned bypass roles do not exempt the assignment that grants them.
Rule toggles and presets persist in the existing per-server database. Disabling a rule
stops counting its new events. Evidence from earlier events is retained.

Permission reverts remove only newly added dangerous permission bits and preserve
pre-existing permissions and unrelated later changes. Managed and uneditable roles,
trusted users and hierarchy restrictions remain protected. Webhook creation can be
undone; edits/deletions still require manual review. See [default preset](antinuke-preset.md).

For live validation, follow [the test-server walkthrough](notes/security-live-test.md).
