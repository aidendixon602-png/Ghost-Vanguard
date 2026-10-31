# Anti-nuke shipped defaults

Every authorized server starts with the same baseline rules. Servers can tune each threshold/window or disable a rule with `/antinuke rule`; `/antinuke reset` restores that rule's shipped defaults. New or unconfigured servers start in **observe** mode, and enforcement requires a successful readiness check and explicit confirmation.

| Rule | Default limit | Default response |
|---|---:|---|
| Ban | 5 in 60s | Human first hit: warn + revert bans; same-rule repeat within an hour: strip + revert |
| Bot Add | 1 in 60s | Strip + remove the added bot |
| Channel Create | 6 in 120s | Human first hit: warn + revert; same-rule repeat: strip + revert |
| Channel Delete | 3 in 120s | Human first hit: warn (no automatic restore); same-rule repeat: strip |
| Kick | 5 in 120s | Human first hit: warn; same-rule repeat: strip |
| Permission Grant (Administrator, Ban/Kick, Manage Channels/Server/Webhooks) | 1 in 60s | First event: revert + warn; repeat within an hour: strip + revert. Self-assigned Administrator or Manage Server: immediate strip + revert |
| Role Create | 8 in 120s | Human first hit: warn + revert; same-rule repeat: strip + revert |
| Role Delete | 5 in 120s | Human first hit: warn (no automatic restore); same-rule repeat: strip |
| Role Invite | 8 in 60s | Human first hit: warn + revert; same-rule repeat: strip + revert |
| Server Update | 5 in 120s | Human first hit: warn; same-rule repeat: strip |
| Timeout | 10 in 120s | Human first hit: warn + revert; same-rule repeat: strip + revert |
| Webhook | 3 in 60s | Human first hit: warn + revert; same-rule repeat: strip + revert |
| Channel Update | 15 in 60s | Human first hit: warn; same-rule repeat: strip |
| Role Update | 15 in 60s | Human first hit: warn; same-rule repeat: strip |
| Member Prune | 1 in 60s | Strip |
| AutoMod | 1 in 60s | Human first hit: warn + revert; same-rule repeat: strip + revert |
| Join Flood | 12 in 15s | Alert and, when configured, switch raid mode on and sweep the wave |
| Unban | 5 in 60s | Strip + re-ban the unbanned users |
| Emoji Delete (emojis and stickers) | 5 in 60s | Human first hit: warn; same-rule repeat: strip |

First-hit warnings apply to human actors; bots get the normal response without a warning. A safe revert is attempted only for rules with a revert handler. Self-assigned Administrator/Manage Server grants are immediate even if other dangerous grants warn first. Explicit whitelist exemptions still apply.

## Raid protection

- **Raid mode** removes (kick or timeout) joiners whose account is younger than the minimum age, and joiners whose name matches two or more other accounts that joined in the last 10 minutes (a lookalike wave), whatever their age.
- **Join flood → raid mode:** switched on automatically for the raid auto-trigger's hours; the accounts that made up the flood are swept straight away, and the server's verification level is raised to High until raid mode ends (join gate, needs Manage Server; a level staff change during the raid is left as they set it).
- **Message waves:** the same message from 4 or more accounts that joined in the last 30 minutes, within 30 seconds, is deleted, the accounts are handled like raid mode, and raid mode switches on. In observe mode it is only reported.
- `/antinuke settings join_gate:false message_waves:false` switches either off.

## Observe-first rollout and readiness

At startup and after authorization, a new or unconfigured server loads its default rules in **observe** mode. It records incidents but does not strip people or automatically revert changes. Run `/setup logs setup`, then `/antinuke check`; readiness requires the bot permissions and an accessible security-log channel. When ready, `/antinuke enable` opens a confirmation that describes enforcement consequences, the baseline snapshot, and any roles at or above Vanguard. Confirming rechecks the security log, permissions, and hierarchy before enabling enforcement. A hierarchy warning does not block the choice, but Vanguard cannot contain members whose roles are above it.

An enforced server retains its per-rule settings across restarts. If permissions or the security-log destination are missing, startup switches it to observe mode and reports the blockers; fixing readiness alone never silently resumes enforcement. A staff `/antinuke disable` opt-out stays off across restarts. The server owner, configured developers, Vanguard itself and the network's trusted bots are never punished.
