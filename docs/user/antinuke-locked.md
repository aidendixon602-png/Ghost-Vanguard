# Fixed anti-nuke preset (2.11.0)

Every authorized server uses the same fixed 17-rule preset. New or unconfigured servers start in **observe** mode; enforce mode is an explicit, readiness-gated choice.

| Rule | Limit | Action |
|---|---|---|
| Ban | 5 in 60s | strip + revert |
| Bot Add | 1 in 60s | strip + remove the bot |
| Channel Create | 6 in 120s | warns first, then strip + revert |
| Channel Delete | 3 in 120s | strip |
| Kick | 5 in 120s | strip |
| Permission Grant (administrator, ban/kick members, manage channels/server/webhooks) | 1 in 60s | First event: revert + warn; repeat within an hour: strip + revert. Self-assigned Administrator or Manage Server: immediate strip + revert. Explicit whitelist entries are exempt |
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

- **Enforcement:** `/antinuke enable` requires a passing readiness check and a user confirmation; the bot saves a baseline and rechecks permissions and hierarchy immediately before enabling. `/antinuke disable` also requires confirmation. A staff opt-out is remembered across restarts.
- **Whitelist:** `/antinuke whitelist` and the status panel's *Manage Whitelist* button.
- Nothing else. `/antinuke rule`, `toggle`, `preset`, `mode`, `bots` and `/antinuke-rule` were removed. Limits saved by older versions are ignored and cleared on the next startup.

## Observe-first rollout and readiness

At startup and after authorization, a new or unconfigured server loads the preset in **observe** mode. It records incidents but does not strip people or automatically revert changes. Run `/setup logs setup`, then `/antinuke check`; readiness requires the bot permissions and an accessible security-log channel. When ready, `/antinuke enable` opens a confirmation that describes enforcement consequences, the baseline snapshot, and any roles at or above Vanguard. Confirming rechecks the security log, permissions, and hierarchy before enabling enforcement. A hierarchy warning does not block the choice, but Vanguard cannot contain members whose roles are above it.

A server already in enforce mode remains there across restarts only if readiness passes. If permissions or the security-log destination are missing, startup switches it to observe mode and reports the blockers; fixing readiness alone never silently resumes enforcement. A staff `/antinuke disable` opt-out stays off across restarts. The server owner, configured developers and Vanguard itself are never punished.
