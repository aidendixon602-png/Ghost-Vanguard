# Panels and permissions — 2.9.3

Opening a new command embed replaces the previous personal embed for that user in the
same server. Buttons, menus, confirmations and error embeds follow the same rule. Other
users' panels and other servers' panels are separate. Updates to the same reply keep it
in place. Failed delivery of a new reply preserves the old panel. Incident, security and
audit log messages are retained.

Cleanup tracks replies opened since this process started. Discord's interaction tokens
expire after 15 minutes; an older ephemeral reply, or one from before a restart, may remain
and need to be dismissed in Discord. Cleanup failures do not prevent the new reply.

`/help` is now a category browser with a category menu and Previous/Next buttons.
Categories separate anti-nuke, security/trust, moderation, backups/recovery, logs/history,
server setup, Roblox verification and general information. It includes every allowed
command/subcommand without a text attachment. Categories and pages are recalculated
on each click so revoked access and disabled commands disappear. Existing command names
and shortcuts remain available.

Permission checks retain this structure:

| Action | Required access |
|---|---|
| Basic information/help | Available information commands; protected details remain guarded |
| Moderation | Exact native permission for the chosen action; bot permissions and target hierarchy also checked |
| Anti-nuke, trust, recovery controls | Server owner, configured developer, explicit admin grant or configured admin role |
| Owner settings | Server owner or configured developer |
| Developer commands | Configured developer IDs only |
| Confirmation buttons | Same user/server; fresh checks of the original command policy, authorization, feature settings and bot permissions |

Administrator permission alone does not grant Vanguard's internal security access and
does not create an anti-nuke bypass. Use the existing security/admin-role configuration
for command access and `/trust` separately for anti-nuke exemptions.

Confirmation buttons no longer require developer status when the original action is
available to moderators or security administrators. Developer-only actions remain
developer-only. Authorization-required confirmed actions run in the server's work queue
and authorization context. Permission changes made after opening a prompt are rechecked
before any action. Disabling `/antinuke` also blocks its status/rule controls; disabling
snapshot features blocks mapped recovery controls.
