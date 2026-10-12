# Fixed anti-nuke preset (2.11.0)

Every authorized server runs the same 17-rule anti-nuke preset in **enforce** mode.

| Rule | Limit | Action |
|---|---|---|
| Ban | 3 in 60s | ban + revert |
| Bot Add | 1 in 60s | ban + revert |
| Channel Create | 2 in 120s | kick + revert |
| Channel Delete | 2 in 120s | ban |
| Kick | 3 in 120s | ban |
| Permission Grant (administrator, ban/kick members, manage channels/server/webhooks) | 1 in 60s | strip + revert, including the recipient |
| Role Create | 5 in 120s | strip + revert |
| Role Delete | 5 in 120s | strip |
| Role Invite | 1 in 60s | strip + revert |
| Server Update | 1 in 60s | strip |
| Timeout | 5 in 120s | strip + revert |
| Webhook | 1 in 60s | kick + revert |
| Channel Update | 5 in 20s | strip |
| Role Update | 5 in 20s | strip |
| Member Prune | 1 in 60s | strip |
| AutoMod | 1 in 60s | strip |
| Join Flood | 12 in 15s | alert only |

## What staff can change

- **On/off only:** `/enable` (or `/antinuke enable`) and `/disable` (or `/antinuke disable`, with confirmation). A disable is remembered across restarts.
- **Whitelist:** `/trust` and the status panel's *Manage Whitelist* button.
- Nothing else. `/antinuke rule`, `toggle`, `preset`, `mode`, `bots` and `/antinuke-rule` were removed. Limits saved by older versions are ignored and cleared on the next startup.

## Automatic enable

At startup and whenever a server is authorized, Vanguard enables the preset in enforce mode unless staff used `/disable`. The first automatic enable captures a baseline snapshot and posts "Anti-nuke protection active" in the security log.

The server owner, configured developers and Vanguard itself are never punished. Role hierarchy still applies: Vanguard cannot act on members above its top role, so keep its role at the top (`/antinuke check`).
