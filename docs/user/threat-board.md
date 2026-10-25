# The threat board: scoring and staff response

Ghost Vanguard's threat board is a per-server incident memory for staff. Anti-nuke responds to its
own triggers independently; the board records scores and evidence so staff can distinguish a one-off
mistake from a repeat attacker. **Threat scores never automatically contain, strike or post a
"Threat board acted" card.** Staff keep the manual controls below.

Everything the board knows is per server and lives in three tables (`threat_scores`, `threat_events`,
`threat_actions`). Nothing is guessed: a score comes from incidents the bot itself confirmed.

## Points

Every confirmed incident adds points to that member's score in that server.

| Incident | Points |
|---|---|
| Mass ban | 40 |
| Added a bot / granted dangerous permissions | 35 |
| Mass kick | 30 |
| Deleted channels / roles, tampered with AutoMod | 25 |
| Pruned members, changed webhooks | 20 |
| Changed server settings, created roles, posted a scam | 15 |
| Mention-spammed staff, join flood, created channels, gave out roles, mass timeouts | 10 |
| Changed channels or roles | 5 |
| Anything the board does not recognise | 5 |

| Level | From | Staff triage meaning |
|---|---|---|
| 🟢 Quiet | 0 | Below the watch threshold |
| 🟡 Watch | 25 | Review the recorded evidence |
| 🟠 High | 55 | Higher-priority review |
| 🔴 Critical | 85 | Highest-priority review |

These levels do not start enforcement. In particular, High does not automatically strip and Critical
does not automatically ban. No automatic threat-board action is recorded and no automatic board card
is sent to the server log. Manual staff actions are still recorded in `threat_actions`.

## Cooling down

A quiet attacker cools off. Scores **halve once per day** without a new incident, and an entry
disappears from the board **seven days** after its last incident. An entry cleared by staff starts
again from the next incident, so clearing a false alarm is respected rather than easily undone. The
events behind a cleared entry are kept as evidence.

## Commands

| Command | Rank | What it does |
|---|---|---|
| `/antinuke threats list` | Admin | The board, scores, levels and previous staff actions |
| `/antinuke threats view member:` | Admin | One member's incident and staff-action history |
| `/antinuke threats clear member:` | Head Admin | Clears the board entry. No ban or role is changed |
| `/antinuke threats release member:` | Head Admin | Manually unbans them and clears the entry, with the reason recorded |
| `/antinuke threats strike member: [reason]` | Head Admin | Manually strips, records a case and bans, regardless of level |

Staff actions remain reversible: lifting a ban (`/mod unban` or `/antinuke threats release`) plus
clearing the entry puts the member back where they were. Roles removed by a strip are saved first,
so the normal role-restoration controls can return them.

## Timing

A once-a-minute maintenance pass in each ready server only decays old scores and expires inactive
entries. It has no containment, ban or logging dependency. Scoring continues from anti-nuke
incidents, confirmed scams and mention-protection hits, and the dashboard shows the same board.
