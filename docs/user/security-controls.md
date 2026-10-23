# Anti-nuke controls

The fixed 17-rule preset is loaded for authorized servers and survives restarts. New or unconfigured servers begin in **observe** mode: incidents are recorded, but no members are stripped and no changes are automatically reverted. Run `/setup logs setup`, then `/antinuke check`; when required bot permissions and an accessible security-log channel are ready, `/antinuke enable` shows a confirmation, saves a baseline, and rechecks readiness before switching to **enforce**. Roles at or above Vanguard are shown as hierarchy warnings because their members cannot be contained. Existing enforce-mode servers stay enforced only while readiness passes at startup; missing readiness switches them to observe, and fixing it does not silently resume enforcement. A staff opt-out remains off across restarts. The complete limits are listed in [antinuke-locked.md](antinuke-locked.md), and `/antinuke status` shows the live values.

## How a rule fires

1. Every audit-log action is counted against the person responsible. Actions made through Vanguard on behalf of a staff member, such as `/mod ban`, count against that staff member.
2. **One step before a limit**, a blue *heads-up* is posted to the security log. Nothing is done to the person.
3. **At the limit:**
   - *Everyday rules* (role and channel edits, role grants, server edits, timeouts, webhooks) **warn first**. The change is undone, a yellow *Anti-nuke Warning* is posted and the person is DMed. Hitting any of these rules again within an hour gets the punishment.
   - *All other rules*, and any bot, are punished straight away.
4. **The punishment is always a strip.** Staff and admin roles are removed and saved, and the damage is reverted where possible (bans lifted, created channels/roles/webhooks deleted, granted permissions removed).
5. The alert in the security log has an **Undo strip** button (owner or developer) and, after deletions, **Review restore**.

## Everyone is watched

Anti-nuke watches **everyone**. Nobody's actions are skipped, except Vanguard's own, which count against the staff member who asked for them.

Some people are **never punished**. When they hit a limit, the alert, the global feed and the DM still go out as a blue **Anti-nuke Alert (not punished)** card, but nothing is stripped or undone:

| Who | Not punished for |
|---|---|
| Server owner, Developers | Everything |
| Full whitelist entries (user or role) | Everything |
| Rule-specific whitelist entries | Only the chosen rules |

Supreme Leaders and every other rank are punished like anyone else.

Still not counted at all, because they are not attacks:

| What | Why |
|---|---|
| Known verification bots (Bloxlink, RoVer, Carl-bot, Dyno, MEE6) and `/antinuke whitelist bots` giving ordinary roles | Verifying members; dangerous grants by them are still counted |
| A change approved through `/role` | That single, already-checked change |

## Alerts

- **Security log:** every server gets its own alert card with Undo strip and Review restore buttons.
- **Global feed:** every trigger in every server also goes to one channel: `GLOBAL_ALERT_CHANNEL_ID` in `.env`, or `/dev alerts channel:` (Developer). The card shows the server, the person, the action, the limit, the punishment, the roles they held before the strip and a Jump to Server button.
- **DMs:** the same card is DMed to `TRUSTED_DM_IDS` (default: the bot owner). It is rate-limited to once per person per server every 5 minutes and 15 per 10 minutes. `/dev alerts dm:false` turns it off.

## Settings locked in `.env`

Nobody can change these from Discord. Restart after editing.

| Setting | What it does |
|---|---|
| `ANTINUKE_LOCK=true` | Only Developers can turn anti-nuke off or change its extra layers. A server someone switched off is switched back on at every start |
| `PROTECTED_USERS` | Staff can't ban, kick, time out, strip or take roles from these people, through Vanguard or by hand. Manual bans, timeouts and role removals are undone and you are alerted (kicks can't be undone). Anti-nuke still contains them if they set it off |
| `PROTECTED_ROLES`, `PROTECTED_ROLE_ASSIGNERS` | Only the assigners and Developers may give these roles. Anyone else's grant is taken back and you are alerted |
| `COMMAND_BLACKLIST` | Blocks specific people from specific commands in every server, e.g. `111…:mod ban\|network`. `*` blocks every command and button. The bot owner can never be blocked |
| `GLOBAL_ALERT_CHANNEL_ID`, `GLOBAL_ALERT_WARNINGS` | The global alert feed channel, and whether first-time warnings go there too |

## Commands

| Command | What it does |
|---|---|
| `/antinuke status` | Rules, limits, whitelist and state, with Refresh, Incidents and Whitelist buttons |
| `/antinuke enable` | After readiness passes, review a confirmation; it saves a baseline and enables enforce mode. Hierarchy warnings are shown and rechecked. |
| `/antinuke disable` | Turn protection off with confirmation; the staff opt-out stays off after restarts |
| `/antinuke check` | Vanguard's permissions, log-channel access and role position |
| `/antinuke scan` | Powerful roles, roles above Vanguard, bots with Administrator |
| `/antinuke settings` | Extra protection layers (all on by default) |
| `/antinuke whitelist add` | Panel: pick who, what they may do and for how long |
| `/antinuke whitelist remove` · `list` · `check` · `bots` | Remove, list, explain one person's coverage, verification-bot exemptions |
| `/security quarantine` · `release` | Strip and save someone's roles by hand, or give them back |
| `/setup panel` | Private control channel with Restore / Strip / Revert / Logs buttons |

## Evidence and reverts

Evidence is written before any Discord change is made. Incidents record the executor, target, rule, count and window, mode, punishment and completed/failed/skipped reverts. Large incidents post progress every ten events. Permission reverts remove only the newly added dangerous permission bits and keep everything else. Webhook creation is undone; edits and deletions need manual review.

For a live test plan, see [notes/security-live-test.md](notes/security-live-test.md).
