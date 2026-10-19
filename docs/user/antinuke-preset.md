# Default anti-nuke preset

The current fixed 17-rule preset, including limits, punishments and reversals, is documented in [antinuke-locked.md](antinuke-locked.md). Thresholds and actions cannot be customized; legacy saved rule overrides are cleared when the preset is applied.

## Observe-first lifecycle

- New or unconfigured authorized servers start with the preset in **observe** mode. Incidents are recorded, but the bot does not automatically strip members or revert changes.
- Run `/setup logs setup`, then `/antinuke check`. Readiness requires the bot's required permissions and an accessible security-log channel.
- When readiness passes, `/antinuke enable` presents a confirmation describing enforcement consequences, the baseline snapshot, and any roles at or above Vanguard. On confirmation, readiness and hierarchy are checked again, the baseline is saved, then checks are repeated immediately before enforcement is switched on.
- A role-hierarchy warning does not block enforcement, but Vanguard cannot contain members whose roles are above its highest role. Review `/antinuke check` and move the bot role higher where possible.
- A server already in enforce mode stays there across restarts only if readiness still passes. If not, startup changes it to observe and reports the blockers. Fixing readiness does not silently resume enforcement; staff must run `/antinuke enable` and confirm again.
- `/antinuke disable` requires confirmation and records a staff opt-out that survives restarts. The bot will not automatically turn protection back on.

`/antinuke status` shows the current state, fixed rules and active bypasses. `/antinuke whitelist` manages explicit exceptions; whitelist changes reduce protection for their selected scope.
