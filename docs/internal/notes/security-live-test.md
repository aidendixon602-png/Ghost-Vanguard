# Live test-server walkthrough

Live Discord enforcement has not been executed from this workspace. This checklist is
ready to run after installing 2.9.2. Use a separate authorized test server with disposable
channels/roles and test members. Test actions can ban or kick the executor and strip their
roles; use a helper account below Vanguard rather than the server owner, a developer or
an exempt account. Do not automate a normal user account.

1. Invite Vanguard and authorize the test server with `/dev server authorize` as an authorized Developer.
2. Place Vanguard above regular staff/test roles, grant the permissions reported by
   `/antinuke check`, and set a security log channel with `/setup security`.
3. Run `/recovery backup`, `/antinuke check`, then `/antinuke enable`. Confirm green status and the defaults.
4. Run `/antinuke mode value:observe`. Have the untrusted helper create two disposable
   channels within 120 seconds. Confirm an incident with no punishment or deletion.
5. Delete the test channels yourself and wait 120 seconds for that rule's window to clear.
   Switch to enforce mode. Have the helper create two new disposable channels. Confirm
   the helper is kicked and both channels are removed. Record failures/hierarchy issues.
6. Reinvite the helper. Grant them a one-hour user bypass using `/antinuke whitelist add`, wait for
   the prior window to clear, then repeat channel creation. Confirm no incident. Revoke
   the exemption and clean up the channels. Repeat using a regular test role bypass.
7. Toggle Channel Create off, repeat channel creation and confirm no incident. Turn it
   back on, confirm status, and clean up. Save a named preset, change a limit, then load
   the preset and confirm the original limit/toggle returns.
8. Open status controls as one security administrator. Confirm a different user cannot
   operate them. Test whitelist add/remove; check expiration and that no mention is sent.
9. Restart Vanguard. Confirm saved mode, toggles, presets and exemptions remain, and
   the startup log reports readiness. Temporarily remove a required permission and run
   `/antinuke check`; confirm `/antinuke enable` rejects it before creating a snapshot.

Additional rule checks, each using disposable targets and a fresh incident window:

| Rule | Test activity | Expected |
|---|---|---|
| Ban | Ban three test members within 60s | Executor banned; those bans removed |
| Bot Add | Untrusted helper adds one disposable bot | Executor and added bot banned |
| Channel Delete | Delete two disposable channels within 120s | Executor banned; snapshot recovery needs review |
| Kick | Kick three test members within 120s | Executor banned; kicked users are not auto-rejoined |
| Permission Grant | Add one of the six listed dangerous permissions to another role/member | First event reverted and warned; repeat within an hour strips the executor and reverts again |
| Self-admin protection | Self-assign Administrator or Manage Server while unwhitelisted | Executor stripped and newly assigned role removed immediately; repeat with an explicit anti-nuke whitelist to confirm the exemption |
| Role Create | Create five regular roles within 120s | Executor stripped; created editable roles deleted |
| Role Delete | Delete five disposable roles within 120s | Executor stripped; restore needs review |
| Role Invite | Assign one ordinary role to a test member | Executor stripped; assigned editable role removed |
| Server Update | Change a disposable server setting | Executor stripped; setting not auto-reverted |
| Timeout | Timeout five eligible test members within 120s | Executor stripped; previous timeout states restored |
| Webhook | Create one disposable webhook | Executor kicked; created webhook removed |

For timeout tests, confirm a later manual change is retained. For permission tests,
confirm existing permissions remain. Test a verification bot exemption separately:
ordinary role assignments are exempt, dangerous grants remain detectable. Deleted
webhooks cannot recover their original URL/token; update/deletion incidents must report
manual review rather than a successful revert.

Record each incident ID, actual punishment, completed/failed/skipped counts and any
permission or hierarchy failures. Restore the test server from its baseline only after
reviewing the restore preview. Finish with `/antinuke disable` and its confirmation.
