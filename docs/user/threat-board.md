# The threat board: who may be attacking, and the counter-attack

Ghost Vanguard is balanced on purpose: **defence reacts, offence answers**. Anti-nuke contains an
incident the moment it happens; the threat board is the memory that decides whether the person behind
it is a one-off mistake or a repeat attacker, and it is the only thing that counter-attacks.

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

| Level | From | What the bot does by itself |
|---|---|---|
| 🟢 Quiet | 0 | Nothing. The board shows them. |
| 🟡 Watch | 25 | Nothing. Staff can step in first — this is the intended way to use a Watch entry. |
| 🟠 High | 55 | **Defence:** strip their dangerous roles and put back what the incident broke. |
| 🔴 Critical | 85 | **Counter-attack:** the strip and the restore, then ban them. |

## What is never touched

The board does not act against, and does not count as an attacker:

- anyone on the anti-nuke **whitelist**, and anything Discord actually recorded as **trusted**;
- the **bot itself** and the **server owner**;
- anyone in a server where anti-nuke is **off**, the server is **unauthorized**, or the protection mode
  is **observe** — then the board only records and displays, which is what observe mode is for;
- someone already actioned in the last **ten minutes**: one action per attacker per cooldown, so a
  raid cannot be answered with a loop of actions;
- someone already banned at a High level (their access is stripped instead, and the restore runs).

## Cooling down

A quiet attacker cools off. Scores **halve once per day** without a new incident, and an entry
disappears from the board **seven days** after its last incident. An entry cleared by staff starts
again from the next incident, so clearing a false alarm is respected rather than easily undone. The
events behind a cleared entry are kept as evidence.

## Commands

| Command | Rank | What it does |
|---|---|---|
| `/antinuke threats list` | Admin | The board: everyone above Watch, with their score, level and what was already done |
| `/antinuke threats view member:` | Admin | One member in full: every incident, every automatic action and the current plan |
| `/antinuke threats clear member:` | Head Admin | Clears the board entry. No ban or role is changed |
| `/antinuke threats release member:` | Head Admin | Undoes an automatic strike: unbans them and clears the entry, with the reason recorded |
| `/antinuke threats strike member: [reason]` | Head Admin | Counter-attacks now, regardless of level: strip, restore, ban |

Every automatic action appears in three places at once: the board itself, the server's log channel,
and the audit trail for the case — with what decided it. **Every action is reversible:** lifting the
ban (`/mod unban` or `/antinuke threats release`) plus clearing the entry puts the member back where
they were, and the roles the strip removed are saved first, so `/antinuke restore` can return them.

## Timing

The board is swept **once a minute** for every ready server. It also runs immediately after
anti-nuke incidents, confirmed scams and mention-protection hits, because those are the events that
produce points. The dashboard shows the same board live.
