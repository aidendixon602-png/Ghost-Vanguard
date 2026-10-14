# Fixed anti-nuke preset (2.11.0)

Every authorized server runs the same 17-rule anti-nuke preset in **enforce** mode.

| Rule | Limit | Action |
|---|---|---|
| Ban | 5 in 60s | strip + revert |
| Bot Add | 1 in 60s | strip + remove the bot |
| Channel Create | 6 in 120s | warns first, then strip + revert |
| Channel Delete | 3 in 120s | strip |
| Kick | 5 in 120s | strip |
| Permission Grant (administrator, ban/kick members, manage channels/server/webhooks) | 1 in 60s | strip + revert, including the recipient |
| Role Create | 8 in 120s | warns first, then strip + revert |
| Role Delete | 5 in 120s | strip |
| Role Invite | 8 in 60s | warns first, then strip + revert |
| Server Update | 5 in 120s | warns first, then strip |
| Timeout | 10 in 120s | warns first, then strip + revert |
| Webhook | 3 in 60s | warns first, then strip + revert |
| Channel Update | 15 in 60s | warns first, then strip |
| Role Update | 15 in 60s | warns first, then strip |
| Member Prune | 1 in 60s | strip |
| AutoMod | 1 in 60s | strip |
| Join Flood | 12 in 15s | alert only |

## What staff can change

- **On/off only:** `/antinuke enable` (or `/antinuke enable`) and `/antinuke disable` (or `/antinuke disable`, with confirmation). A disable is remembered across restarts.
- **Whitelist:** `/antinuke whitelist` and the status panel's *Manage Whitelist* button.
- Nothing else. `/antinuke rule`, `toggle`, `preset`, `mode`, `bots` and `/antinuke-rule` were removed. Limits saved by older versions are ignored and cleared on the next startup.

## Automatic enable

At startup and whenever a server is authorized, Vanguard enables the preset in enforce mode unless staff used `/antinuke disable`. The first automatic enable captures a baseline snapshot and posts "Anti-nuke protection active" in the security log.

The server owner, configured developers and Vanguard itself are never punished. Role hierarchy still applies: Vanguard cannot act on members above its top role, so keep its role at the top (`/antinuke check`).
