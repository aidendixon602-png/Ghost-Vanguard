<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:b6b1f5bd2c9f85335ee5d2ec421714f6516639d9b87850fc527bc90d4b36d434 -->

# Anti-nuke controls

The 19-rule baseline loads for authorized servers and survives restarts. Each server can customize a rule's threshold and time window or disable that rule with `/antinuke rule`; `/antinuke reset` restores the shipped default. New or unconfigured servers begin in **observe** mode: incidents are recorded, but no members are stripped and no changes are automatically reverted. Run `/setup logs setup`, then `/antinuke check`; when required bot permissions and an accessible security-log channel are ready, `/antinuke enable` shows a confirmation, saves a baseline, and rechecks readiness before switching to **enforce**. Roles at or above Vanguard are shown as hierarchy warnings because their members cannot be contained. Existing enforce-mode servers stay enforced only while readiness passes at startup; missing readiness switches them to observe, and fixing it does not silently resume enforcement. A staff opt-out remains off across restarts. The shipped defaults are listed in [antinuke-locked.md](antinuke-locked.md), and `/antinuke status` shows live per-server values.

## How a rule fires

1. Every audit-log action is counted against the person responsible. Actions made through Vanguard on behalf of a staff member, such as `/mod ban`, count against that staff member.
2. **One step before a limit**, a blue *heads-up* is posted to the security log. Nothing is done to the person.
3. **At the limit:**
   - Routine or ambiguous actions (including mass bans/kicks, channel or role changes/deletions, AutoMod edits and emoji/sticker deletion) warn human actors on the first hit. The bot removes no roles; it attempts a safe revert only when that rule supports one. The alert reports the result. Repeating that same rule within an hour gets the rule's normal response.
   - A warning for one rule does not escalate an unrelated rule. This avoids punishing normal staff work because of an earlier, different action.
   - High-confidence takeover signals (adding a bot, mass unbanning, member pruning and dangerous permission grants) retain stronger defaults. Dangerous grants include newly granted Manage Roles, Administrator, Manage Server, Ban/Kick Members, Manage Channels and Manage Webhooks. They warn first except self-assigned Administrator or Manage Server, which are stripped and reverted immediately. A repeat dangerous grant within an hour strips and reverts; bots receive the warning path for dangerous grants.
   - Bots do not get first-hit warnings for routine rules; their normal configured response applies.
4. When a rule's normal response is a strip, staff and admin roles are removed and saved, and damage is reverted only where the rule has a supported revert handler. Rule limits can be customized per server, so review the current values with `/antinuke status`.
5. The alert in the security log has an **Undo strip** button (owner or developer) and, after deletions, **Review restore**.

## Everyone is watched

Anti-nuke watches **everyone**. Nobody's actions are skipped, except Vanguard's own, which count against the staff member who asked for them.

Some people are **never punished**. When they hit a limit it is recorded quietly in `/antinuke incidents` and nothing is stripped or undone. Set `ALERT_EXEMPT=true` in `.env` to also get a blue **Anti-nuke Alert (not punished)** card, global feed post and DM for them:

| Who | Not punished for |
|---|---|
| Server owner, Developers | Everything |
| Full whitelist entries (user or role) | Everything |
| Rule-specific whitelist entries | Only the chosen rules |

Supreme Leaders and every other rank are punished like anyone else. If someone is whitelisted for some rules but sets off another one, they are punished, and the alert has a **Whitelist** line saying what they are covered for and what was missing.

Still not counted at all, because they are not attacks:

| What | Why |
|---|---|
| Known verification bots (Bloxlink, RoVer, Carl-bot, Dyno, MEE6) and `/antinuke whitelist bots` giving ordinary roles | Verifying members; dangerous grants by them are still counted |
| A change approved through `/role` | That single, already-checked change |

## Alerts

- **Security log:** every server gets its own alert card with Undo strip and Review restore buttons.
- **Global feed:** every trigger in every server also goes to one channel: `GLOBAL_ALERT_CHANNEL_ID` in `.env`, or `/dev alerts channel:` (Developer). The branded card shows the incident number, server, actor, trigger, status, response, role history and rollback details, with an **Open server log** button.
- **DMs:** the same card is DMed to every bot Developer (`BOT_OWNER_ID` and `DEVELOPER_IDS`) and to `TRUSTED_DM_IDS`, once each. Protected-role and protected-user alerts go to the same people. It is rate-limited to once per person per server every 5 minutes and 15 per 10 minutes. `/dev alerts dm:false` turns it off.

## Settings locked in `.env`

Nobody can change these from Discord. Restart after editing.

| Setting | What it does |
|---|---|
| `ANTINUKE_LOCK=true` | Only Developers can turn anti-nuke off or change its extra layers. A server someone switched off is switched back on at every start |
| `PROTECTED_USERS` | Staff can't ban, kick, time out, strip or take roles from these people, through Vanguard or by hand. Manual bans, timeouts and role removals are undone and you are alerted (kicks can't be undone). Anti-nuke still contains them if they set it off |
| `PROTECTED_ROLES`, `PROTECTED_ROLE_ASSIGNERS` | Only the assigners and Developers may give these roles. Anyone else's grant is taken back and you are alerted |
| `COMMAND_BLACKLIST` | Blocks specific people from specific commands in every server, e.g. `111…:mod ban\|genreban`. `*` blocks every command and button. The bot owner can never be blocked |
| `GLOBAL_ALERT_CHANNEL_ID`, `GLOBAL_ALERT_WARNINGS` | The global alert feed channel, and whether first-time warnings go there too |

## Commands

| Command | What it does |
|---|---|
| `/antinuke status` | Effective rules, per-server limits, whitelist and state, with Refresh, Incidents and Whitelist buttons |
| `/antinuke rule rule:<rule> [threshold] [window_seconds] [enabled]` | View or tune one rule. Omitted settings stay unchanged; thresholds are 1–100 and windows are 1–300 seconds. |
| `/antinuke reset rule:<rule>` | Restore one rule's shipped threshold and enabled state. |
| `/antinuke enable` | After readiness passes, review a confirmation; it saves a baseline and enables enforce mode. Hierarchy warnings are shown and rechecked. |
| `/antinuke disable` | Turn protection off with confirmation; the staff opt-out stays off after restarts |
| `/antinuke check` | Vanguard's permissions, log-channel access and role position |
| `/antinuke scan` | Powerful roles, roles above Vanguard, bots with Administrator |
| `/antinuke settings` | Extra protection layers (all on by default) |
| `/antinuke whitelist add` | Panel: pick who, what they may do and for how long |
| `/antinuke whitelist remove` · `list` · `check` · `bots` | Remove, list, explain one person's coverage, verification-bot exemptions |
| `/antinuke quarantine` · `release` | Strip and save someone's roles by hand, or give them back |
| `/setup panel` | Private control channel with Restore / Strip / Revert / Logs buttons |

## Evidence and reverts

Evidence is written before any Discord change is made. Incidents record the executor, target, rule, count and window, mode, punishment and completed/failed/skipped reverts. Large incidents post progress every ten events. Permission reverts remove only the newly added dangerous permission bits and keep everything else. Webhook creation is undone; edits and deletions need manual review.

After an enforcement incident, supported reversals continue for new actions by the same actor and rule during its cooldown. This covers continued bot additions, bans, unbans and dangerous grants. Containment and alerts are throttled separately; the cooldown does not create a reversal blind spot. Each reversal attempt and outcome is saved with its audit payload before and after the Discord request. Already attempted events are not automatically retried, including after a restart or warning escalation, so later legitimate staff corrections are not repeatedly undone. A failed or interrupted attempt needs staff review. Current observe/disabled settings and whitelist exemptions still apply. Deletions without a supported reversal still require the previewed recovery workflow.

For a live test plan, see [notes/security-live-test.md](notes/security-live-test.md).


<!-- /coderabbit-ai-generated:v1 -->