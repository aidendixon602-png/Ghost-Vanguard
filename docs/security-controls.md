# Anti-nuke controls

Anti-nuke runs a fixed preset of 17 rules in every authorized server. It starts automatically and survives restarts. The limits are listed in [antinuke-locked.md](antinuke-locked.md), and `/antinuke status` shows the live values.

## How a rule fires

1. Every audit-log action is counted against the person responsible. Actions made through Vanguard on behalf of a staff member, such as `/mod ban`, count against that staff member.
2. **One step before a limit**, a blue *heads-up* is posted to the security log. Nothing is done to the person.
3. **At the limit:**
   - *Everyday rules* (role and channel edits, role grants, server edits, timeouts, webhooks) **warn first**. The change is undone, a yellow *Anti-nuke Warning* is posted and the person is DMed. Hitting any of these rules again within an hour gets the punishment.
   - *All other rules*, and any bot, are punished straight away.
4. **The punishment is always a strip.** Staff and admin roles are removed and saved, and the damage is reverted where possible (bans lifted, created channels/roles/webhooks deleted, granted permissions removed).
5. The alert in the security log has an **Undo strip** button (owner or developer) and, after deletions, **Review restore**.

## Who is not counted

| Who | Covered for |
|---|---|
| Server owner, developers, Supreme Leaders, Vanguard itself | Everything |
| Full-bypass whitelist entries (user or role) | Everything |
| Rule-specific whitelist entries | Only the chosen rules (presets: Basic moderation, Role manager, Channel manager, Administrator) |
| Known verification bots (Bloxlink, RoVer, Carl-bot, Dyno, MEE6) and `/antinuke whitelist bots` | Ordinary member-role updates only |
| Changes approved through `/role` | That single change |

Granting **Administrator** or **Manage Server** is always checked unless the person has a full bypass. Role managers on the whitelist may hand out moderator-level roles. A role someone gives themselves never exempts that same action.

## Commands

| Command | What it does |
|---|---|
| `/antinuke status` | Rules, limits, whitelist and state, with Refresh, Incidents and Whitelist buttons |
| `/antinuke enable` / `disable` | Turn protection on (takes a baseline snapshot) or off (asks to confirm; stays off after restarts) |
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
