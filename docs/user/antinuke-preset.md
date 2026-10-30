# Anti-nuke defaults and per-server controls

Ghost Vanguard ships a 19-rule anti-nuke policy. Each server can tune a rule's event threshold and counting window, or disable that rule. High-confidence signals retain their strict default response; routine or ambiguous staff activity warns first. Legacy shared thresholds are discarded, but per-rule settings survive restarts and enforcement enable/disable cycles.

## Observe-first lifecycle

- New or unconfigured authorized servers start in **observe** mode. Incidents are recorded, but the bot does not automatically strip members or revert changes.
- Run `/setup logs setup`, then `/antinuke check`. Readiness requires the bot's required permissions and an accessible security-log channel.
- When readiness passes, `/antinuke enable` presents a confirmation describing enforcement consequences, the baseline snapshot, and any roles at or above Vanguard. On confirmation, readiness and hierarchy are checked again, the baseline is saved, then checks are repeated immediately before enforcement is switched on.
- A role-hierarchy warning does not block enforcement, but Vanguard cannot contain members whose roles are above its highest role. Review `/antinuke check` and move the bot role higher where possible.
- A server already in enforce mode stays there across restarts only if readiness still passes. If not, startup changes it to observe and reports the blockers. Fixing readiness does not silently resume enforcement; staff must run `/antinuke enable` and confirm again.
- `/antinuke disable` requires confirmation and records a staff opt-out that survives restarts.

## Tuning rules

Use `/antinuke rule rule:<rule>` to view the effective threshold and response. Set any combination of:

- `threshold`: number of matching events before the rule fires (1–100)
- `window_seconds`: how many seconds to count events over (1–300)
- `enabled`: turn that rule on or off

Omitted options stay unchanged. For example, `/antinuke rule rule:Ban members threshold:8 window_seconds:90` changes only that server's ban limit. `/antinuke reset rule:<rule>` restores the shipped limit and enables the rule again. `/antinuke status` lists all effective values and disabled rules.

## Graduated response

- The first threshold hit for routine or ambiguous rules (including mass bans/kicks, channel or role changes/deletions, AutoMod edits and emoji/sticker deletion) warns a human actor without removing their roles. The triggering change is reverted only when the rule has a safe automated revert. The security log shows whether the revert succeeded.
- Repeating the **same rule** within one hour gets its normal response. A warning for one kind of work does not escalate an unrelated rule.
- High-confidence signals such as adding a bot, mass unbanning, pruning members, or granting dangerous permissions retain stronger defaults. Self-assigning Administrator or Manage Server remains immediate strip-and-revert.
- Bots do not receive first-hit warnings for routine rules. The owner, configured developers, trusted bots and explicit whitelist entries are protected as documented in [security-controls.md](security-controls.md).

`/antinuke whitelist` manages explicit exceptions; whitelist changes reduce protection for their selected scope. For the shipped limits and exact default actions, see [antinuke-locked.md](antinuke-locked.md).
