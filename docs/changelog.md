# Changelog

## 3.1.1: security alerts DM the bot Developers
- **Anti-nuke alerts, protected-role and protected-user alerts are now DMed to every bot Developer** (`BOT_OWNER_ID` and `DEVELOPER_IDS`) as well as `TRUSTED_DM_IDS`. Each person gets one DM even if they are on both lists, and the same rate limit applies.
- Backup files and other bot DMs still go only to `TRUSTED_DM_IDS`.
- `/dev alerts` shows exactly who gets the DMs.

## 3.1.0: stronger anti-nuke, alerts everywhere, and settings locked in .env
- **Ranks:** Developer (the bot owner and `DEVELOPER_IDS`) has full control. **Server Owner** (whoever owns the Discord server) now outranks Supreme Leaders in their own server, but bot-wide tools (`/dev`, `/restart`, the database, network bans, server authorization, bot-wide ranks) only ever look at bot ranks. Giving bot-wide ranks is Developer only.
- **Anti-nuke watches everyone.** The server owner, Developers and whitelisted people are no longer skipped: when they hit a limit you get a blue **Anti-nuke Alert (not punished)** card everywhere, but nothing is stripped or undone. Supreme Leaders and every other rank are punished like anyone else.
- **Global anti-nuke feed:** every trigger in every server also goes to one channel (`GLOBAL_ALERT_CHANNEL_ID`, or `/dev alerts channel:`), with the server, the person, the action, the limit, the punishment, every role they held before the strip and a **Jump to Server** button.
- **Anti-nuke DMs:** the same card is DMed to `TRUSTED_DM_IDS` for every strip, rate-limited so a raid can't flood your DMs. `/dev alerts dm:false` turns it off.
- **New settings locked in `.env`** (nobody can change them from Discord; restart after editing):
  - `ANTINUKE_LOCK=true`: only Developers can turn anti-nuke off or change its layers, and servers someone switched off come back on at every start.
  - `PROTECTED_USERS`: staff can't ban, kick, time out, strip or take roles from these people. Manual bans, timeouts and role removals are undone and alerted; kicks are alerted.
  - `PROTECTED_ROLES` + `PROTECTED_ROLE_ASSIGNERS`: only the listed people and Developers may give these roles; anyone else's grant is taken back and alerted.
  - `COMMAND_BLACKLIST`: block specific people from specific commands in every server (`*` = everything).
  - `GLOBAL_ALERT_CHANNEL_ID` / `GLOBAL_ALERT_WARNINGS`: the global feed channel.
- The startup Access block shows all of these, so you can confirm they loaded.

## Unreleased: no more hard-coded legacy names, and honest provider errors
- **One name, one place.** The product name now comes from a single constant, so the startup panel, embed footers, the mention-protection notice and the default log channel all say Ghost Vanguard. New servers get **#ghost-vanguard-logging**.
- **Existing servers keep the channel they have.** A server still using the older **#midtown-vanguard-logging** reuses it instead of getting a second log channel, and setup says so ("existing channel reused (still named #…)"). Vanguard never renames a channel by itself: rename it yourself, or run `/setup logs setup logging_channel:` and pick any channel.
- **Provider errors now say which kind they are.**
  - HTTP 401/403: the key was rejected for this server — check `ROVER_API_KEY` / `BLOXLINK_API_KEY` and its access there.
  - HTTP 429/5xx: temporary — requests pause for a minute and then resume.
  - HTTP 400 and other client errors: a request or configuration problem, not an outage. The message says to check the key, the provider's access to the server and the member's link, and the server is paused for 5 minutes instead of being told to wait for a pause that was never set.
  - Verification roles are still never removed on a provider error, and console warnings still omit keys and response bodies.

## Unreleased: reusable Workspace management system
- Added a guild-scoped, button-first Workspace for submissions, reviews, linked records, directives/tasks, staff synchronization and live reports.
- Added durable sessions and panels, exact Discord-ID checks, idempotent counters, retry-safe linked Record IDs, audit history, setup validation, module visibility, authorization isolation and scheduled reminder state.
- Added generic profiles plus the opt-in Midtown Archives preset (guild `1556485316838293587`, configured spreadsheet ID, `America/Los_Angeles`, row 7 headers and rows 8–207). Channel and role IDs remain setup selectors; none are invented.
- Added Google Sheets v4 access-token/service-account authentication through environment variables, RAW literal writes, live header checks and controlled prepared-row expansion.
- Added `/setup config workspace-setup`, `publish`, `status`, `enable`, `disable` and `sync`, plus member/staff/task/review controls. See [docs/workspace.md](workspace.md).

## Unreleased: comma-prefix Developer actions and private admin replies
- Developer-only and bot-wide risky actions use comma-prefix commands; their slash entries are hidden and stale slash calls are rejected. Ordinary slash utilities remain available under their normal policies.
- Every comma command requires the exact user ID in `DEVELOPER_IDS`, including the bot owner. `BOT_OWNER_ID` alone is not a prefix-command exception.
- Sensitive, staff and admin slash replies are ephemeral; ordinary public utility replies stay public. Use `/help` for slash commands and `,help` for the Developer comma-command list.

## 3.0.0: Ghost Vanguard — the two bots are one, and the balance is the point
- **The product is called Ghost Vanguard.** Midtown Vanguard and the separate Midtown Desk ticket bot are now one bot with one name, one database and one set of ranks. At the time of this release, the repository was still named `midtown-vanguard`; it has since been renamed `Ghost-Vanguard`.
- **One language.** The ticket desk was ported from the Python Midtown Desk into this codebase, so there is a single Node.js/TypeScript bot to run; midtown-desk is retired. Its desk-owner tools (desk-wide authorization, maintenance, broadcast, backup) were deliberately not ported — Ghost Vanguard already has `/setup`, `/recovery` and `/dev` for those.
- **The threat board: defence and counter-attack, balanced.**
  - Every confirmed incident now scores the member behind it: mass ban 40, bot additions and dangerous grants 35, mass kicks 30, deletions and AutoMod tampering 25, prunes and webhook changes 20, server and role changes and confirmed scams 15, anti-ping, join floods, channel or role creation, role grants and mass timeouts 10, small changes 5, anything unrecognised 5.
  - Levels: 🟢 Quiet, 🟡 Watch (25+), 🟠 High (55+), 🔴 Critical (85+).
  - **Watch records and shows; High strips their dangerous roles and puts the damage back; Critical does that and then bans.** Defence reacts, offence answers — and staff can always step in one step earlier.
  - It never acts on whitelisted people, the bot itself, the server owner, an unauthorized or protection-off server, or in observe mode, and never twice against the same person within ten minutes.
  - A quiet attacker cools off: scores halve once per quiet day and entries expire seven days after the last incident. Clearing a false alarm is respected — that member starts again from their next incident.
  - **Every automatic action is logged and reversible:** it is written to the board, the server's log channel and the case, and `/security threats release` unbans and clears it.
  - New commands: `/security threats list`, `view`, `clear`, `release` (Head Admin+) and `strike` (Head Admin+). `/security threats list` and `view` need Admin.
  - The board is swept every minute for every ready server, and it is fed straight from anti-nuke, confirmed scam detection and mention protection.
- **Ticket desk, ported and rebuilt for this bot.** Panel-driven tickets with per-type categories, claim/unclaim/transfer, priority, renames, a 60-second per-member cooldown and an open-ticket limit; closing posts a full transcript, waits five seconds, then deletes the channel; the requester is DMed a rating, idle tickets close themselves and staff get a weekly report. New: `/ticket panel`, `settings`, `setup`, `stats`, `types`, `claim`, `close`, `history` and a block list.
- **A dashboard.** One self-contained page — no build step, no external fonts, scripts or images, so it runs on a host with no internet — showing servers, protection, the threat board, the ticket desk and recent incidents, refreshing every 15 seconds. The bot serves it on its health port next to `/healthz`; `npm run dashboard` serves the same routes standalone against the same database, and `npm run dashboard:demo` shows it with seeded sample data. Read-only (GET only) and per-server scoped; set `DASHBOARD_TOKEN` to require a token.
- **A style of its own.** The Ghost Vanguard mark, and one palette used everywhere: violet `#6d5ae6` for structure, teal `#2aa5a0` for defence, red `#e0483f` for the counter-attack.
- **Under the hood:** three new tables (`threat_scores`, `threat_events`, `threat_actions`), schema version stays 3, and the weekly report's window is now inclusive at both ends.

## 2.38.0: Developer is the top rank; who can lift which ban
- **Developer is now the top rank.** It is the bot owner (`BOT_OWNER_ID`) and anyone in `DEVELOPER_IDS`, set only in `.env`. Supreme Leader is the rank below it.
- **Developer-only tools.** Nobody below Developer can use these, whatever their rank or Discord permissions:
  - `/dev restart` and installing an update now (`/dev update action: now`); anyone with `/dev` can still see the status
  - `/dev database restore-settings`
  - `/dev server deauthorize`, `ban` and `unban`
  - `/setup staff global` (bot-wide ranks)
  - `/network unhardban` and lifting a hardban from its ban record
- **Supreme Leaders** keep everything else: diagnostics, update status, database health and backups, server info, genrebans, hardbans and lifting genrebans. Give this to someone who needs bot-wide tools but should not be able to break the bot.
- **Lifting ordinary bans is for Admins and owners.** `/mod unban` needs the Admin rank, Discord's Administrator permission or the server owner. Ban Members alone no longer unlocks it. Moderators can still ban.
  - The **Unban / Reban buttons** on ban records now work for Admins and owners, not only developers.
  - **Accepting a ban appeal** (which unbans) needs Admin too. Moderators can still deny.
- **Network bans need bot-wide staff:**
  - Genreban: lifted everywhere by a Supreme Leader or Developer. A one-server exception needs an **Overseer or higher**; server owners and Head Admins can no longer grant it.
  - Hardban: lifted only by a Developer.
- `/setup staff list`, the startup Access block, `/help`, the README and `docs/ranks.md` show Developer at the top.
- **Automatic updates: `UPDATE_REPO` now accepts the full GitHub link** as well as `owner/repo`. Before, a full link silently turned updates off. When updates are off, the launcher and `/dev update` now say exactly why.

## 2.37.0: no built-in access, and a startup access check
- **Removed the built-in Supreme Leader** (`843909457616044092`). It used to have full control in every server, and received the daily database backup, unless `SUPREME_LEADER_IDS` was set.
- **Supreme Leaders now come only from:**
  - `BOT_OWNER_ID`
  - `SUPREME_LEADER_IDS`
  - ranks given with `/setup staff global`
- **Every start prints an Access block** under the banner: owner, Supreme Leaders, developers, bot-wide ranks and who gets bot DMs. If an unexpected ID shows up, remove it.

## 2.36.1: bot DMs go only to people you trust
- **New `TRUSTED_DM_IDS`:** the only people the bot ever DMs about itself. That covers:
  - the **daily database backup file** (`.db.gz`)
  - "back online" notices and backup-failure alerts
  - empty-database warnings and genreban-exception notices
- It defaults to **`BOT_OWNER_ID` only**.
- **Supreme Leaders and developers no longer get these DMs because of their rank.** Add them to `TRUSTED_DM_IDS` if you want them to.

## 2.36.0 (documentation)
- **Rewrote the README** in a cleaner style:
  - an overview and design principles
  - capabilities grouped by protection, moderation and operations
  - an access model table
  - a configuration reference
  - getting started, operations (updates, backups) and development
- **SECURITY.md** now has a reporting policy, a table for responding to a leaked secret, and deployment-integrity guidance.
- **Updated every doc that still used command names from before the reorganization:**
  - `/trust` → `/antinuke whitelist`
  - `/snapshot` → `/recovery snapshot`
  - `/scam` → `/security scam`
  - `/authserver` → `/dev server authorize`
  - and others
- **`docs/security-controls.md` is rewritten** for the current anti-nuke (heads-up, warn first, strip, Undo strip). It used to describe removed preset and toggle commands.

## 2.36.0: genreban exceptions for one server
- **`/mod unban` on a genrebanned user** now lets a server's **owner or Head Admin** (a Vanguard rank, not just Discord's Administrator permission) let them back into **their server only**:
  - it asks for confirmation first
  - they are unbanned there and the bot stops re-banning them in that server
  - the genreban stays in force in every other Midtown server
  - a case is recorded and the server's log gets a note
  - every developer gets a DM with the reason and how to cancel it
- **Moderators and Admins** still cannot. They are told to ask the owner or a Head Admin.
- **Hardbans never have exceptions.** Hardbanning someone who has an exception makes the hardban apply everywhere, including that server.
- **New `/network exceptions list` and `revoke`** (developers): see every exception and cancel any of them. If the person is in that server, they are banned again straight away.

## 2.35.1: complete, always-current command and rank lists
- **New [docs/ranks.md](ranks.md):** every rank (Supreme Leader, Developer, Overseer, Bot Manager, Server Owner, Head Admin, Admin, Moderator, Helper, Everyone) with every command it unlocks.
- **[docs/commands.md](commands.md) is regenerated** with everything new: `/setup panel`, `/role restore`, `/role who-can-give`, `/antinuke whitelist check`, `/dev database restore-settings` and more.
- **Both docs come from the code** (`npm run docs`), and a test fails if they fall out of date, so they always match the bot.
- **`/help` and the docs now say who can really use developer tools.** Bot Manager and Overseer tools show "Bot Manager+" / "Overseer+" instead of "Developer".
- **Security fix:** `/security admin` (which hands out Head Admin access) and `/setup history restore` were labelled "Server owner" but also worked for a Head Admin rank. They are now owner-only, while Bot Managers and above still pass.
- The README's "Who can use what" covers every rank, including bot-wide ones.

## 2.35.0: control panel
**`/setup panel`** creates a private **#vanguard-control** channel with a button panel, so staff can act without typing commands.

| Button | What it does |
|---|---|
| 🟢 **Restore Roles** | Pick a member and give back roles the bot removed (an anti-nuke strip or a panel strip), or the roles they had before leaving |
| 🔴 **Strip Roles** | Pick a member and remove their staff/admin roles. They are saved first, so Restore Roles can undo it |
| ↩️ **Revert Action** | Pick a recent anti-nuke strip or a ban the bot made (last 7 days) and undo it |
| 📋 **View Logs** | Recent panel actions, anti-nuke alerts and moderation cases: who, whom, what and when |
| 🔄 **Refresh Panel** | Updates the panel message in place |

**Security**
- **Who can see it:** the channel is hidden from everyone except the server owner, security admins, admin permission roles and Head Admin/Admin staff roles.
- **Who can use it:** the buttons use the same "security" access level as `/antinuke`. Discord's Administrator permission alone is not enough, and developer-only tools are unchanged.
- **Confirmation:** strip, restore and revert always ask first, then check everything again at the moment you confirm.
- **Role hierarchy:** never acts on roles at or above the bot, on members above the person pressing it, on yourself, on the owner or on developers.
- **Staff and admin roles:** only the owner or a developer gives these back, or someone allowed by `/role who-can-give`. Genrebans and hardbans can never be reverted here.
- **Logged:** every action is saved and posted to the security log with the staff member's ID, the target, the action and the time.

**Behaviour**
- Running `/setup panel` again updates the same channel's access and edits the same panel message. It never creates duplicates, and it posts a new panel only if the old message was deleted.
- The buttons have fixed IDs, so they keep working after restarts and updates.
- The panel refreshes itself after every action.

## 2.34.0: gentler anti-nuke, still watching
**Nobody is banned or kicked by anti-nuke any more.** Every rule now **strips** (removes their staff roles), which stops an attack just as well, and a false alarm can be undone in one click with **Undo strip**.

| Rule | Before | Now |
|---|---|---|
| Ban | 3 in 60s → ban | **5 in 60s → strip** (bans undone) |
| Kick | 3 in 120s → ban | **5 in 120s → strip** |
| Channel Delete | 2 in 120s → ban | **3 in 120s → strip** |
| Channel Create | 4 in 120s → kick | **6 in 120s → strip** (warns first) |
| Bot Add | 1 → ban | **1 → strip** (the bot is still removed) |
| Webhook | 1 → kick | **3 in 60s → strip** (warns first) |
| Role Create | 5 in 120s | **8 in 120s** |
| Role Invite | 6 in 60s | **8 in 60s** |
| Server Update | 3 in 120s | **5 in 120s** |
| Timeout | 8 in 120s | **10 in 120s** |
| Channel / Role Update | 10 in 60s | **15 in 60s** |

**Still instant:** Permission Grant (giving Administrator etc.), Member Prune, AutoMod.

**New: heads-up.** One step before any limit, a blue **Anti-nuke heads-up** is posted in the security log ("@user is close to the Channel Delete limit: 2 of 3 in 120s. Nothing has been done."). Staff can see trouble coming without anyone being punished, at most once per person and rule per window.

## 2.33.4: reasons are optional
- `reason` is now optional on `/mod ban`, `unban`, `kick`, `timeout`, `untimeout`, `/mod tempban`, `softban`, `massban`, `/network genreban`, `hardban`, `ungenreban` and `unhardban`. If it's left empty, **"No reason given"** is recorded in the case, the ban record and the audit log.
- `/mod warn` still needs a reason, because the reason is the warning that gets DMed. `/case reason` and the Roblox blacklist also still need one.

## 2.33.3: every ban command handles someone who is already banned
- **`/mod tempban`** on someone already banned keeps their ban and gives it an **end date**: they are unbanned automatically when the time is up. A case is recorded, and their ban record shows "Temporary ban" with the end time.
- **`/mod massban`** records the reason (a case, plus the ban record in `#bans`) for every account that was already banned, instead of skipping it silently.
- **`/mod softban`** still won't run on someone already banned, because a softban ends by unbanning and would set them free. The message now says so and points to `/mod ban` for adding a reason.
- **Genrebans and hardbans** are never changed by any of these. Only a developer can change them.
- `/network genreban` and `hardban` already covered people banned by hand (since 2.27), and the #bans Reban button already checks Discord first.

## 2.33.2: banning someone who is already banned
- `/mod ban` used to refuse with "No change: already done" when the person was already banned (by hand in Discord, by another bot like Midtown Utilities, or before the ban log existed). That left no way to record why.
- Now Discord's ban is left as it is (no second ban, no DM), but your **reason and evidence are recorded**:
  - a case is saved
  - their ban record in `#bans` is updated, or a new **BAN-xxxx** record is started if they had none
  - if nobody was known to be behind the original ban, you are listed as the moderator
- The reply says so: "They were already banned on Discord, so the ban itself did not change. Your reason was added to BAN-0007."
- Genrebans and hardbans are still left alone. Only a developer can change those.

## 2.33.1: cleaner console
- **Updates** are 3 short lines: `↻ Update found: <commit> · <what changed>`, `📦 Dependencies updated · 35 added · 10s`, `✔ Installed`. npm's spinner garbage (`\|/-\|/-`) is gone.
- **Dependencies are no longer reinstalled** when only the version number changed, so most updates start about 10 seconds faster.
- **Roles above the bot** are grouped under one heading with the fix written once: `• Midtown Tower Cafe — Cafe Owner, admin`.
- **Backups** are one line (`✔ Database backup saved · startup · 1.1 MB`) without the long ID.
- **No second clock:** Wispbyte already stamps each line, so the bot's own (differently zoned) time is hidden when running under `launch.js`.
- **The invite link** is one labelled row.
- Each level has its own mark: `✖ ERROR`, `⚠ WARN`, `• INFO`.
- The launcher's crash and rollback messages are marked ⚠ / ✖.
- The launcher changes show after one Restart from the Wispbyte panel. The bot's own lines change straight away.

## 2.33.0: `/role who-can-give` replaces allow, policy and rules
`/role allow`, `/role policy` and `/role rules` were confusing, so they are now one command:
- **`/role who-can-give`** with nothing filled in shows the list: each role, and who can give it.
- **`/role who-can-give role:@Helper`** lets every moderator give an ordinary role (owner or Head Admin).
- **`/role who-can-give role:@Moderator who:@Head Mods`** lets that role or one person give a staff role (one with ban, kick, admin and so on). Only the server owner can do this. One step is enough: givers with a moderator rank no longer also need the allow list.
- Add **`remove:True`** to take it away.
- Setups saved with the old commands keep working exactly as before.
- Error messages from `/role add` now point to `/role who-can-give`.

## 2.32.0: give rejoining members their roles back in one click
- When someone leaves, Vanguard remembers their roles for 90 days (not bot or integration roles).
- When they rejoin, a **Member Rejoined** card in the log lists the roles they had, with a green **↩️ Restore roles** button.
- **`/role restore user:`** does the same from a command.
- Every role goes through the same checks as `/role add`, so the person pressing it only gives back what they could give by hand:
  - **ordinary roles:** anyone with Manage Roles, Administrator or a Vanguard moderator rank
  - **staff and admin roles** (Ban, Kick, Administrator…): the owner, a developer, or someone with an approved `/role policy` rule
  - **always skipped:** roles above the bot, integration roles and deleted roles, with the reason listed
- If some roles needed more access, the button stays so the owner can finish the job. Once everything is back, it turns into "Roles restored".
- Anti-nuke knows these are approved changes, so restoring roles never counts toward Role Invite.

## 2.31.0: warnings before strips, trusted bots, whitelist check, settings restore
- **Warn before strip.** Everyday rules (Role Invite, Role Create, Role Update, Channel Create, Channel Update, Server Update, Timeout) now give a **warning** the first time:
  - the change is undone, a yellow **Anti-nuke Warning** is posted, and the person is DMed telling them to slow down or ask for a whitelist
  - doing it again within an hour gets the normal punishment
  - bans, kicks, deletes, bot adds, webhooks, dangerous permission grants, prunes and AutoMod are still instant
  - bots never get a warning
  - `/antinuke status` marks these rules `[warns first]`
- **Trusted verification bots.** Bloxlink, RoVer, Carl-bot, Dyno and MEE6 can give ordinary roles (verified, levels, reaction roles) without counting toward Role Invite. Giving roles with dangerous permissions is still checked. Switch one off for a server with `/antinuke whitelist bots allowed:false`.
- **`/antinuke whitelist check @user`** shows exactly what anti-nuke lets someone do, including whitelists that come from their roles, with expiry times. It also shows what would still get them punished, whether they were warned in the last hour, and whether they're quarantined.
- **`/dev database restore-settings`** (developers): upload an old `vanguard.db` or a daily `vanguard-YYYY-MM-DD.db.gz` backup and it puts back lost settings: whitelists, staff ranks, permission roles, command and feature switches, logging, auto-react, `/role` rules, anti-ping, scam and new-account settings.
  - It shows a preview first and makes a safety backup before changing anything.
  - Anything set now is kept, and whitelist entries removed on purpose since the backup stay removed.
  - Running it twice adds nothing the second time.
- **Cleaner console.** The 18 "scam startup" and "protection startup" lines on every restart are gone. The console only shows servers that need fixing, as one WARN line each (for example roles above the bot).

## 2.30.0: Undo strip button
- When anti-nuke strips someone, the alert now has a green **↩️ Undo strip** button for false alarms.
- **Only the server owner or a developer** can use it. It asks for confirmation first, then gives back every role that was removed (staff and admin roles included) and ends their quarantine, so anti-nuke stops re-removing staff roles from them.
- It works once per incident: the button turns into "Strip undone", and a **Strip undone** note is posted to the log saying who undid it.
- Anti-nuke still watches them afterwards. If what they did is normal for them, add them with `/antinuke whitelist add`.

## 2.29.3: `/dev restart` works on older launchers
- `/dev restart` said "needs the bot to be started with `node launch.js`" even when it was. Automatic updates replace the bot's code, but the `launch.js` already running on the host stays the version it started with, and launchers from before 2.27.4 don't understand the restart request.
- Now, if the launcher doesn't answer, the bot shuts down cleanly with a "please start me again" exit code, which every version of `launch.js` handles. It only does this after the bot has been up for 2.5 minutes, so the launcher can't mistake it for a crashing update and roll back.
- When an update changes `launch.js` itself, the console now says so and suggests one Restart from the Wispbyte panel to load it.

## 2.29.2: whitelisted staff can promote moderators
The **Permission Grant** rule stripped people the first time they gave out any role with Ban, Kick, Manage Channels, Manage Webhooks or Manage Server, even staff on the whitelist. Now:
- **Whitelisted role managers** (the *Role manager* or *Administrator* preset, or "Give roles to people") can give, create and edit moderator-level roles. **Administrator** and **Manage Server** are still checked for anyone without a full bypass.
- **Only real new permissions count.** Giving someone a role whose powers they already had from another role is no longer a "dangerous grant".
- People who aren't whitelisted are checked exactly as before.
- If Discord is slow to answer while anti-nuke looks someone up, the check carries on instead of being skipped.

## 2.29.1: log fixes from a full check
- **New roles** list only the permissions that matter (administrator, ban, kick, manage server…) plus a count of everyday ones, instead of 20+ names.
- **Channel permission changes** show one clear state per permission (allowed / denied / reset). Before, flipping a permission from denied to allowed printed two lines that contradicted each other.
- Role logs say **Created By** / **Deleted By** / **Updated By** to match what happened.
- Bad permission data from Discord is skipped instead of shown wrong.

## 2.29.0: clearer anti-nuke alerts and permission logs
- **New anti-nuke alert:** "**@user was stripped for triggering anti-nuke.**" with **Action**, **Punishment**, **Limit**, **Changes reverted** and **Target** fields, and the full detail underneath. The footer shows the incident number and user ID.
  - If the punishment didn't work (for example the bot role is too low), it says so: "triggered anti-nuke but could **not** be banned".
  - In watch-only mode it says what *would* have happened.
- **Role permission logs:** "Role Updated" now lists every permission, such as `administrator` granted or `ban members` revoked, instead of just "changed". It has **Role** and **Updated By** fields and a "Role ID" footer. Channel permission changes are listed the same way (allowed / denied / reset).

## 2.28.1: anti-nuke is less trigger-happy
Staff were being stripped for normal work. The everyday rules now allow more before acting:

| Rule | Before | Now |
|---|---|---|
| Role Invite (giving roles) | 1 in 60s | **6 in 60s** |
| Server Update | 1 in 60s | **3 in 120s** |
| Channel Create | 2 in 120s | **4 in 120s** |
| Timeout | 5 in 120s | **8 in 120s** |
| Channel Update | 5 in 20s | **10 in 60s** |
| Role Update | 5 in 20s | **10 in 60s** |

- **Still strict:** giving or adding Administrator or other dangerous permissions (Permission Grant) is still stripped and reverted on the first try. Ban, Kick, Bot Add, Channel/Role Delete, Webhook, Member Prune and AutoMod are unchanged.
- Approved `/role` changes still don't count toward Role Invite at all.

## 2.28.0: commands reorganized
- **`/antinuke`:** `status · enable · disable · check · scan · settings · whitelist`. `rules` and `test` are gone (`status` shows the rules and limits); `audit` is now **`scan`**, `extras` is now **`settings`**.
- **`/network`** (new, developers): `genreban · ungenreban · hardban · unhardban`, instead of four separate top-level commands.
- **`/dev server`** (new group): `authorize · deauthorize · info · list · ban · unban`, replacing `/dev authserver`, `deauthserver`, `serverauth`, `servers`, `banserver`, `unbanserver`.
- **`/setup permissions`** (was `/setup perm`), **`/mod notes`** (was `/mod note`).
- **Removed duplicates:** `/security mention` (same as `/security antiping`) and `/security roblox-block` (same as `/roblox blacklist`).
- Groups are ordered by how often staff use them. Every message, help page and doc points to the new names, and `docs/commands.md` is generated from the bot so it can't drift.
- Saved settings, permissions and command on/off switches are unchanged: they use the same internal names.

## 2.27.4
- **`/dev restart`** (developers only): restarts the bot from Discord after a confirmation. About 10 seconds offline; settings are kept. `launch.js` stops the bot cleanly and starts it again, so no Wispbyte panel is needed.

## 2.27.3
- **Cleaner system notices.** "Back online", "Saved protection loaded", "Anti-nuke protection on" and snapshot messages use fields instead of a block of text, and snapshots say who made them ("Midtown Vanguard (automatic)") instead of a raw ID.
- "Back online" counts the whole whitelist (users, roles and per-rule entries), not only full-bypass users.
- **Data-loss protection:**
  - starting with an empty database while already in servers now warns in each server and DMs the developers with how to restore
  - if `data/vanguard.db` is missing but its automatic backups are there, `launch.js` puts the newest backup back before starting
- A restart test now checks every kind of saved setting survives (whitelist, ranks, logging, automod, raid mode, cases, ban log, network bans and more).
- Ban log "Approved by" is shorter: `@developer (developer) · HB-00002`.

## 2.27.2
- **`/antinuke trust` is now `/antinuke whitelist`**, with clearer subcommands:
  - `add` (was `manage`) opens the panel: pick who, what anti-nuke lets them do, and for how long
  - `remove` (new) takes a user or role off the whitelist in one step
  - `list` shows everyone on it
  - `bots` (was `verification-bot`) lets Bloxlink/RoVer give verified roles
- Saved whitelist entries are unchanged. Every message that mentioned the old command now points to the new one.

## 2.27.1
- **Setup messages are staff-only.** The welcome panel, the authorization countdown and the "left" note only go to a channel `@everyone` can't see: the Vanguard logging channel first, then the security log channel, then a private channel named like admin/staff/mod/logs, then any private channel. With no private channel, the server owner gets a DM instead. Nothing is posted publicly.

## 2.27.0
- **`/mod bans`** searches the ban log without scrolling `#bans`:
  - `lookup user` shows every ban record for someone here, plus any active genreban/hardban
  - `case id` shows one record by case ID (`BAN-0005` or `5`) with a link to its message
  - `recent` lists the latest 10
  - `stats` covers the last 30 days: bans, unbans, still banned, by type, and who banned most
- **`/dev update`** shows the auto-update status (running commit, fallback, last check, skipped versions), or **checks and installs now** instead of waiting for the next 5-minute check.

## 2.26.2
- **Genrebans and hardbans work on users who are already banned.** Before, a server where the user was already banned by its own staff was skipped ("left as it is"). Now the existing ban stays, the genreban/hardban covers it (re-applied if anyone unbans them), a case is recorded, and the result counts as a success.
- **The ban record is upgraded, not duplicated.** The same case (e.g. BAN-0004) now shows the hardban or genreban: type, record ID (also in the footer, e.g. `BAN-0004 • HB-00005`), approval and evidence, with an entry in its history. A ban from before the ban log gets a new record.
- **Lifting the network ban puts the record back.** If the server's own ban was there first, it stays and the record shows that ban again, with a history entry saying the hardban was lifted.

## 2.26.1
- **Cleaner ban log prompts.** Unban and Reban confirmations now look like the ban record: avatar, user, case, ban type, original reason and a short "What happens" list, with **🔓 Unban** / **🔓 Unban everywhere** / **🔨 Reban** buttons. Results show as matching cards instead of plain text.

## 2.26.0
- **Ban log buttons work for genrebans and hardbans.** A developer pressing **Unban** on a network-ban record is now asked to lift it everywhere (same as `/unhardban` / `/ungenreban`) instead of being told to use the command.
- **Anti-nuke:** creating a new role that already has Administrator (or Manage Server, Ban, Kick, Manage Channels, Manage Webhooks) now counts as a Permission Grant straight away: the creator is stripped and the role deleted. Ordinary new roles still count toward the 5-in-2-minutes limit.
- **Updates:** `launch.js` reinstalls packages whenever `package-lock.json` changes, including after the host pulls from GitHub.
- `/dev diagnostics` shows the running GitHub commit and whether automatic updates are on.

## 2.25.2
- **One welcome message per invite.** The countdown shown while waiting for authorization turns into the welcome panel (or a "has left" note) instead of a new message being posted.
- **Restarts are silent.** Only a real invite posts a welcome; reconnecting or restarting never does.
- `/dev authserver` no longer tells people to run `/antinuke enable` (it's already on).

## 2.25.1
- **New welcome panel:** protection status, a live setup checklist with a progress bar, and **Set up logs**, **Re-check** and **Commands** buttons.
- Posted at most once every 6 hours per server; buttons have a 15-second cooldown.
- The authorization countdown is an embed with a live timer.

## 2.25.0
- **`/role` is its own command:** `add`, `remove`, `allow`, `policy`, `rules`.
- Protected roles need an owner-approved rule; hierarchy and self-grant checks; fresh data from Discord right before every change.
- **Anti-nuke + `/role`:** a 30-second approval for that exact change, so approved changes don't trigger Permission Grant. Hand-made changes are still checked.
- Every role change is logged after Discord confirms it.
- Developers pass every permission check without Administrator; bot-wide staff ranks are developer-level.
- `/help` shows who can use each command.

## 2.24.0
- **`#bans`:** one record per ban (BAN-0001) with user, reason, evidence, moderator, approval, duration and expiry. Tracks bans from commands, other bots and Discord itself.
- Developer-only **Unban / Reban** buttons with confirmation; records update in place and keep working after restarts.
- **`#midtown-vanguard-logging`:** compact embeds for messages, roles, channels, nicknames, timeouts, bans, kicks and bot actions. Unverifiable details are shown as "Unavailable".
- `/setup logs setup | check | exclude | bot-changes`.
- Failed log posts are kept and retried for 7 days without duplicates; tokens and keys are hidden from logs.
- Optional `evidence` on `/mod ban` and `/tempban`.

## 2.23.0
- `/dev autoreact` for developers.

## 2.22.4

**Quieter restarts.** Startup messages in each server's log channel are now posted only when there is something to say. The bot remembers what it last posted in each server across restarts.
- **"Midtown Vanguard is back online"** is posted on the very first start, after an outage of 15 minutes or more, or when its summary changed (anti-nuke on/off, mode, rules, trusted users, event logging). A quick restart with nothing changed posts nothing.
- **"Saved protection loaded"** is posted only when the mode, disabled rules, missing permissions or roles above the bot change. A hierarchy warning shows once, not on every restart.
- **"Automatic scam protection ready"** is posted only when that status changes. Problems ("needs attention") are always shown once, and recovery is shown.
- **Activity while the bot was offline** is still reported every time it finds any.
- **Servers already set up** stay quiet on the first quick restart after this update.

## 2.22.3

**Discord Administrators manage their own server without a Vanguard role.** Anyone with Discord's **Administrator** permission (checked live on every command and button, never by role name) now counts as Head Admin in that server for everyday management:
- moderation, cases, warnings and history
- server configuration and logging
- anti-nuke status and settings (enable, rules, checks)
- creating and viewing backups and snapshots
- automod, raid mode, lockdowns, health and diagnostics

Administrator alone does **not** unlock the following; they still need the server owner, an explicit Vanguard staff rank or security-admin grant, or a developer:
- **Developer-only commands**, `/genreban`, `/hardban` and their unbans. Server permissions never grant these.
- **Weakening protection:** turning anti-nuke off, anti-nuke extras, trust list and whitelist changes, releasing quarantined members, emergency controls, approving quarantined bots.
- **Destructive recovery:** restoring backups, snapshots or config history; deleting backups, snapshots or cases.
- **Granting permissions:** `/security admin`, staff ranks, permission roles.
- **Beyond this server:** copying layouts, Roblox network partners, and bot-wide staff ranks. `/setup staff global` is now Supreme Leader only, and server owners no longer see it.

Server owners keep full control of their own server, including restricted server actions behind confirmation, but nothing developer-only. Anti-nuke still watches Administrators exactly as before: only the owner, developers and the trust list are exempt.

## 2.22.2

- **Genrebanned and hardbanned users get a DM.** It's sent before any server bans them, so Discord still allows it, and gives the ban type, the reason, the record ID (for example `GB-00012`), how many servers it covers, and that only a Midtown Vanguard developer can lift it. The command's result says whether the DM was delivered. A user with closed DMs is still banned.
- **Log messages name the server.** Every genreban/hardban message in a server's log channel (applied, re-applied, lifted) now starts with that server's name and ID.
- **Host start script with a one-time import:** the startup command `cd /home/container/midtown-vanguard && sh scripts/start.sh` installs dependencies and starts the bot. If `data/import/vanguard.db` exists, it first merges one server's setup (default: Midtown Tower Cafe; set `IMPORT_GUILD` to change it) from that database into `data/vanguard.db`, keeps the old database as `data/vanguard-before-merge-<time>.db`, and renames the import folder so it runs once. `scripts/merge-guild.mjs` does the same by hand.

## 2.22.1

- **Removed `/duty` and duty shifts.** `/duty on`, `off`, `status`, `hours`, `leaderboard`, `end` and `role` are gone, along with the 12-hour automatic shift close and the duty hours in `/setup staff report` and the weekly activity report. Staff rank-change logging (promotions and demotions in the security log) is unchanged. Old shift rows stay in the database, and anyone still holding the on-duty role keeps it until removed by hand.

## 2.22.0

**Removed**
- **`/csb` and its Google Sheets and Trello logging.** That covers the command, forms, Sheets/Trello clients, `csb:setup`/`csb:check`, the `config/csb-*.json` files, and the `CSB_*`, `TRELLO_*` and `GOOGLE_SERVICE_ACCOUNT_FILE` settings. `/duty` shifts and rank-change logs still go to the security log, but no longer to a "Staff Log" sheet. New databases no longer create the `csb_*` tables. Existing databases keep any old CSB rows until `npm run database:drop-csb -- --confirm DROP-CSB` removes them; it previews first, exports every row to JSON and saves a full database copy.

**Ban commands: loading and clear results**
- **Every ban command shows its progress and result.** That covers `/mod ban`, `/mod unban`, `/mod tempban`, `/mod softban`, `/mod massban`, `/dev banserver`, `/dev unbanserver` and the new network-ban commands. Each shows a ⏳ working message, then whether it **succeeded, partially succeeded or failed**. Failures are named plainly: missing permissions, role hierarchy, invalid user ID, already banned, not allowed, or another error with a log reference. A ban is never reported as done unless Discord confirmed it.
- **Multi-target commands show progress and counts.** `/mod massban` and the network bans show a progress bar, how many succeeded and failed, and every failed server or account with its reason.
- **No duplicate bans.** `/mod ban`, `/mod tempban` and `/mod massban` report a user who is already banned instead of banning again or recording a duplicate case. Cases now also store the target's username at the time, plus evidence where given.
- **Softban fixes.** `/mod softban` refuses anyone who is already banned, because its unban step would lift their real ban. If its unban step fails, it now says they are still banned instead of reporting success.

**Genrebans and hardbans (new, developer-only)**
- **`/genreban user reason [evidence] [evidence_file] [delete_messages]`** bans a user from every authorized server. `user` takes a user ID, @mention or username; IDs work even for people in no server. While active, the user is banned again if they join any authorized server, including servers authorized later. **`/ungenreban`** revokes it and lifts only genreban bans.
- **`/hardban …`** is the same, but permanent. The user is banned again whenever anyone unbans them or they join, and every server is re-checked after each restart and every 10 minutes. It replaces an active genreban. **`/unhardban user reason [unban]`** revokes it.
- **Who can use them:** only Bot Developers (`DEVELOPER_IDS`) and Supreme Leaders, through the existing rank system at rank 7. Server owners, admins and moderators cannot use them, and Vanguard ranks or role names cannot grant them.
- **Records:** saved in `network_bans`, with one row per server outcome in `network_ban_results`. Each record holds the user ID, username, reason, evidence, moderator, time and status, plus who revoked it, when and why. Records are never deleted, and only one active ban per user and type is allowed, which the database itself enforces. Record IDs look like `GB-00012` and `HB-00003`. Every server also gets a moderation case and a log message.

**Only the matching unban can lift a ban**
- The bot tags each ban it places with its type. `/ungenreban` and `/unhardban` lift only their own type, and never a ban a server's own staff placed.
- `/mod unban`, accepted appeals and expiring tempbans never lift a genreban or hardban, and appeals are closed for anyone with one. Staff cannot bypass a hardban: unbanning by hand is undone immediately.

**Other**
- `openai` 7.27.0 → 7.32.0.
- The 2.3.3 `WISPBYTE-STARTUP-FIX.md` is folded into `docs/hosting.md`.

## 2.9.0

- Google Sheets replaces Trello for production CSB logging, with separate Bans and Genre Bans tabs.
- Stable IDs and deterministic row writes prevent duplicate submissions after lost responses. Existing rows are located by ID after sorting.
- A durable update queue recovers row changes after a failed response or restart. Direct ownership edits are preserved; resync requires HR Ownership.
- Added interactive `csb:setup` and live `csb:check -- --write-test --enable`. No new npm dependencies are required.
- Existing SQLite records and action history can be exported through `/csb reconcile`; legacy Trello destinations are recorded in history.


## 2.8.0

- **`/snapshot cleanup older_than_days [type] [keep_latest] [confirm]`:** delete old recovery points in bulk. Filter by type (manual snapshots, manual backups, scheduled backups, automatic pre-restore backups, layout-copy templates, or all). The newest `keep_latest` matching points (default 1) are always kept, so a server is never left without a recovery point. Without `confirm: DELETE` it only previews what would be deleted. It runs under the recovery lock (never during a restore), audits every deletion, and posts a summary to the security log. Server roles, channels and restore mappings are not affected.

## 2.7.0

- **Setup advice when added to a server:** right after the authorization notice, the bot posts a short "Thanks for adding Midtown Vanguard" message recommending the Administrator permission and dragging its role above every other role, with why each matters and the current status (for example "Administrator not granted · role #3 of 12 from the top"). When both are already done it says so instead. It is sent for new invites and when the bot is re-added to a server, never on restarts, and is skipped quietly if there is no channel where the bot can post embeds.

## 2.6.0

New developer-only `/dev` subcommands (only accounts in `DEVELOPER_IDS` can use them; `/dev diagnostics` is unchanged):

- **`/dev inspect guild_id`:** read-only overview of any server Vanguard knows: authorization, anti-nuke state and mode, log channel and event logging, active lockdown, incidents in the last 7 days, trusted users and snapshots. Unauthorized servers only show their authorization details.
- **`/dev broadcast message [title] [confirm]`:** posts an announcement to every authorized server's log channel. Without `confirm: SEND` it only previews the message and how many servers it would reach.
- **`/dev status text [minutes] [presence]`** and **`/dev status-reset`:** show a custom bot status (for example a maintenance notice), optionally for a set time and with Online, Idle or Do Not Disturb, instead of the rotating status. It survives restarts until it expires or is reset.

## 2.5.0

- **`/lockdown`:** locks every text, announcement, forum, voice and stage channel and posts a notice (your message, or a default one) in every public text channel. `@everyone` loses Send Messages, threads and reactions (and Connect and Speak in voice), and any role or member overwrite that grants those back has the grant removed, except staff (Administrator, Manage Server, Manage Channels, Manage Messages or Timeout Members) and the bot. Categories are not touched.
- **`/unlock`:** puts back exactly the permission bits the lockdown changed, removes `@everyone` overwrites it had to create, keeps any other permission edits staff made during the lockdown, deletes the notices (unless `keep_notices`), and can post a message. If a channel can't be restored, the lockdown stays recorded and `/unlock` can be run again.
- The original permissions are saved in the database **before** each channel is changed, so a lockdown can always be undone, even after a crash or restart mid-lockdown. Lockdowns are logged to the security log, or the event log when moderation logging is on, and can't overlap a restore or layout copy.

## 2.4.0

- **Server event log (`/logs`):** records who did what in each server: bans, kicks, timeouts and prunes; joins, leaves and role changes; role, channel and permission changes; server settings, invites, webhooks, emojis, bots and AutoMod; moderator message deletions, bulk deletes and pins. Events are posted to the security log channel or a channel of your choice, and kept for 30 days to browse with `/logs view` (filter by category or user). Off by default; turn on with `/logs enable`. Each category can be switched off with `/logs category`. Bans and kicks done through `/moderation` are credited to the moderator, and the bot's own restores and containment are not logged here.
- **Back-online notice:** after every restart, each server's log channel gets a message showing that its anti-nuke settings were restored (on/off, mode, rules, trusted users, event logging) and how long the bot was offline. Settings were already saved in the database; this makes it visible.
- **Downtime report:** when the bot comes back, it reads Discord's audit log for the time it was offline, adds those events to the event log, and reports destructive actions anti-nuke could not respond to, flagging anyone at or above a rule's limit.
- **Leaves of uncached members** are now delivered by Discord (member partials), so the event log sees every leave.
- **From the Wispbyte repair (kept):** `/ask` loads the OpenAI library only when used, command-load errors show their cause, and a failed start releases its database lock.

## 2.3.3

- **Cleaner console:** startup prints one summary block (version, account, servers, commands, integrations, health URL and the invite link on its own line) instead of a dozen separate lines. Log lines have colored levels in a terminal, dimmed field names and readable sizes ("384 KB"). Set `NO_COLOR=1` to turn colors off or `FORCE_COLOR=1` to force them on. `LOG_FORMAT=json` output is unchanged.
- **Clearer configuration errors:** missing `.env` settings are listed under one "cannot start" heading.

## 2.3.2

- **Rich presence:** the bot now uses a custom status, so Discord shows the text as written ("🛡️ Protecting 12 servers") instead of "Watching Protecting 12 guilds". The rotation shows protected servers, members, verified Roblox accounts (hidden when there are none) and a `/help` hint, with correct plurals and thousands separators.
- **Reliable rotation:** the status changes every minute as intended. Previously the minute timer and a one-minute minimum gap clashed, so updates were often skipped. Joining or leaving a server now refreshes the status within about 15 seconds.

## 2.3.1

- **Security fix: moderation through the bot is covered by anti-nuke.** `/moderation` bans and kicks appear in the audit log as done by the bot, which anti-nuke exempts, so a compromised moderator could mass-ban without triggering anything. The bot records the moderator's ID at the start of the reason, and anti-nuke now counts those bans and kicks against the moderator. Trusted moderators stay exempt, and the bot's own restores and containment are unaffected.
- **`/moderation warn`** says when the warning DM could not be delivered. The warning is still recorded.
- **`/moderation ban`** has an optional `delete_messages` choice to also delete the user's messages from the last hour, 24 hours or 7 days.

## 2.3.0

Anti-nuke additions. There are now 15 rules.

- **Dangerous permission grants (`dangerous_grant`):** fires on the first grant of Administrator, Manage Server, Manage Roles or Manage Webhooks, whether the permission is added to a role or a role carrying it is given to a member. In enforce mode the grantor is contained and the grant is undone: the new permissions are removed from the role, or the new roles from the member. The verification-bot exemption does not cover these grants. Moderator-level permissions are deliberately excluded so promotions do not trigger it.
- **Member prune (`member_prune`):** fires on a single prune.
- **AutoMod tampering (`automod_tamper`):** fires when an AutoMod rule is deleted or switched off. Other AutoMod edits are ignored.
- **Single-event rules ignore the "All" threshold.** The three rules above fire on the first event even if "All" was set higher. An explicit per-rule setting still applies.
- **`/antinuke bots`:** choose whether containment removes an offending bot's dangerous roles (default) or kicks it. Kicking only happens during automatic incident containment in enforce mode, never on manual quarantine. It falls back to role removal if the bot cannot be kicked. Stored in the new `antinuke_options` table, created automatically.
- **Review restore button:** an incident alert offers **Review restore** when the actor deleted channels or roles in the last 10 minutes. It opens the standard restore preview from the newest snapshot taken before the first deletion (layout-copy templates are skipped), with the matching components selected. It restores the whole snapshot for those components, not only the deleted objects, so read the preview before confirming.
- **Alerts with buttons:** the log outbox can now deliver buttons. Older queued alerts are still delivered.

## 2.2.6

- **Rejected verification keys:** when RoVer or Bloxlink rejects the API key (HTTP 401 or 403), the log names the provider, the `.env` setting and the server, and the member sees that the key was rejected instead of a generic "unavailable" message. Lookups to that provider pause for that server for 5 minutes instead of failing on every member join. Outages (429 and 5xx) keep their existing handling.

## 2.2.5

- **Formatting:** every source and test file was re-laid out from its syntax tree: one statement per line, consistent spacing, multi-line blocks, nested command-builder chains indented by depth, and blank lines between declarations. Each file was checked to have an identical syntax tree, literals and comments before and after, and the compiled output is structurally identical to 2.2.4. Some very long single expressions are still long lines.
- **Template privacy:** `.env.example` no longer contains a real Discord ID or username, and `Setup.ps1` asks for `DEVELOPER_IDS` instead of assuming it is set.

## 2.2.4

- **Rate limits:** a restore now waits out Discord rate limits of up to 15 minutes (previously 60 seconds) before stopping. Longer waits still stop the restore with saved mappings, a report and released locks. The cap is one constant, `MAX_RATE_LIMIT_WAIT_MS`.
- **Pacing:** `SNAPSHOT_ACTION_DELAY_MS` works again. It was hardcoded to `0` and the setting was ignored. The default is still `0`.
- **Code layout:** `src/` is grouped into `bot/`, `database/`, `security/`, `recovery/`, `integrations/` and `ui/`. Behavior is unchanged. Commands are still discovered from `src/commands` and `dist/commands`.
- **Docs:** the nine overlapping notes in the project root are consolidated into `docs/`, and out-of-date statements (a 2000 ms default delay, a 60-second wait limit) are corrected.
- **Cleanup:** removed `Fix-Vanguard.ps1`, a one-time patch whose changes were already part of the source. The internal version string now matches `package.json`.
- **Tests:** pacer and rate-limit tests cover the cap boundary, the retry limit and the delay setting.

## 2.2.3

Recovery repair. A long Discord wait stops the restore, saves partial object mappings and the destination backup reference, writes a report, and releases the operation lock. Running the restore again continues without duplicates.

## 2.2.2

Complete administration and persistence update: relational guild configuration, verified database backups and migrations, configuration history, `/guild-config`, `/database`, server and bot information pages, and the recovery audit history. See [features.md](features.md).

## 2.2.1

Command cleanup. The legacy `/server` command was removed in favor of `/server-info` (its protection page now shows the pending authorization deadline) and `/bot-info`. `/antinuke rule`, `/antinuke-rule`, `/snapshot restore`, `/backup restore`, `/serverauth` and `/dev diagnostics` were kept because each serves a distinct permission or workflow. Of the 24 original command definitions, 23 remain. Startup synchronization replaces obsolete global definitions and leaves other bots' commands alone. Role restore uses `colors.primaryColor`, which fixes the deprecated `color` warning; older snapshots stay compatible.

## 2.10.1 — Scam scanner review fixes

- Ordinary messages with no links, images or scam wording are skipped without any Discord API call. Previously every message in every server was re-fetched.
- Text and link checks always run. Only image downloads share a bounded queue (2 at once, up to 25 waiting) instead of being dropped when more than two messages arrived together.
- Links disguised with fullwidth/ideographic dots, invisible characters or Markdown escapes are normalized before domain matching.
- Forwarded messages (message snapshots) are scanned.
- A confirmed sender who already left the server is banned by user ID.
- Oversized phone photos are skipped before download. Unreadable or oversized images no longer raise "Possible scam" alerts by themselves.
- Duplicate-event detection uses stable attachment IDs rather than signed CDN URLs; image fingerprints are cached per attachment.

## 2.11.0 — Fixed anti-nuke preset

- The 17-rule anti-nuke preset is fixed. Saved custom limits, shared "All" limits and per-rule toggles from older versions are ignored and cleared.
- Removed `/antinuke rule`, `toggle`, `preset`, `mode`, `bots`, `/antinuke-rule` and the status panel's *Edit Rules* button.
- Anti-nuke is enabled automatically in enforce mode on every authorized server (at startup and after authorization), with a baseline snapshot on first enable.
- `/disable` is remembered across restarts (new `antinuke_options.staff_disabled` column, added automatically). `/enable` switches it back on.
- Whitelist management (`/trust`, *Manage Whitelist*) is unchanged.

## 2.12.0 — Snapshot/backup rework and command review

- Snapshot and backup numbers are per server (#1, #2…), with no gaps from other servers; the next number is the highest remaining + 1, so deleting all restarts at #1. Existing databases are renumbered automatically on first start.
- `/snapshot delete` and `/backup delete` accept one number, a list, a range or `all`, with a single confirmation. Bulk deletions are posted to the security log.
- `/snapshot view` is now `/snapshot list`; `/backup` gains `list` and `delete`. `restore` takes `number:`.
- Points are labelled (Snapshot, Anti-nuke baseline, Backup, Scheduled, Pre-restore, Layout copy). Anti-nuke baselines are a cleanup type; `older_than_days:0` and `keep_latest:0` are allowed.
- Review fixes: `/security status` showed internal snapshot IDs; `/scam` configuration changes are now posted to the security log; `/config-history list` shows names, page count and how to roll back.

## 2.12.1 — Whitelist panel fixes

- Removing a bypass is always allowed, including from yourself or a role you hold. Granting one to yourself or a held role still needs another admin, the server owner, the bot owner or a developer. The server owner can now grant their own.
- Bot (managed) roles such as Bloxlink can be whitelisted and removed; only @everyone is refused. Same rules in `/trust`.
- The whitelist panel has a duration picker (24 hours, 7 days, 30 days, permanent). Picking someone already listed changes their duration instead of silently turning a permanent bypass into 24 hours.
- Panel clicks no longer hit the 1.5-second command cooldown.

## 2.13.0 — 12 new commands, reorganized /help

New (45 commands total):
- Moderation: `/case` (view, re-word, delete, recent), `/note` (private staff notes), `/tempban` (auto-unban), `/softban`, `/role` (add/remove), `/nick`.
- Security: `/raidmode` (kick or time out accounts younger than N days while on; auto-off timer; batched log summaries), `/massban` (up to 200 IDs; whitelisted staff/owner/developers only), `/slowmode`.
- Info: `/userinfo` (staff also see cases, notes, bypass, Roblox link, temp bans), `/roleinfo`, `/ping`.

Changes:
- Case numbers and note numbers are per server (#1, #2…); existing cases are renumbered automatically on first start.
- Anti-nuke now counts every action Vanguard performs for a staff member (role changes, slowmode, nicknames, bans) against that staff member, so no command can be used to get around it.
- `/help` uses a fixed section order: Anti-nuke, Moderation, Security & Raids, Backups & Recovery, Logs & History, Server Setup, Roblox Verification, Information & Tools, HR, Developer. Command descriptions rewritten in plain language. `docs/commands.md` is generated from the code.

## 2.14.0 — New-account rule (ban evasion)

- New `/newaccounts` (status, on, off). On by default in every server: Discord accounts younger than 7 days are held (timed out) when they join until the account is old enough. Options: minimum age 1–90 days; action hold, kick or alert only.
- Staff alerts include account age and **Let in / Kick / Ban** buttons (each needs the matching Discord permission). Names resembling an account on the server's ban list are flagged as possible ban evasion.
- Bots and whitelisted accounts are skipped; raid mode takes over while it is on. At most five individual alerts per minute per server; the rest are summarized.
- Holds and kicks are recorded as cases. A Discord timeout also persists if the member leaves and rejoins.
- Startup now shows Discord's actual login error (for example an invalid token) with the fix.

## 2.14.1 — Rule-only whitelist

- `/trust add` has a `rule` option: pick one rule and the user/role skips only that rule; every other rule still applies. Leave it empty for the full bypass. Run it again to add more rules.
- The confusing `kind` option is gone. Verification bots (Bloxlink, RoVer) use the new `/trust verification-bot`.
- `/trust list`, the status panel and Manage Whitelist show what each entry skips ("all rules" or "<Rule> only").
- A role someone just gave themselves still cannot exempt that same action.

## 2.15.0 — Staff ranks

- Eight ranks, each including everything below: Supreme Leader (BOT_OWNER_ID), Bot Developer (DEVELOPER_IDS), Overseer and Bot Manager (bot-wide, `/staff global`, Supreme Leader only), then per server Head Admin, Admin, Moderator, Helper (`/staff role` links a Discord role). Server owner ranks just above Head Admin in their server.
- Helper: warn, timeout up to 60 min, history, notes, view cases, staff view of /userinfo. Moderator: bans, kicks, temp/soft bans, timeouts, purge, /role, /nick, /slowmode, case reasons. Admin: raid mode, lockdown, mass ban, new-account rule, scam, logs, anti-ping, health. Head Admin: anti-nuke, whitelist, backups, security, guild config, permissions, /staff for lower ranks. Bot Manager: bot status, broadcasts, server list. Overseer: inspect and authorize any server. Bot Developer: all developer tools.
- Ranks add access; existing Discord-permission moderators and security admins keep working (security admins count as Head Admin).
- Ranks never grant anti-nuke bypass. `/massban` still also requires the anti-nuke whitelist. Switched-off commands/features stay off for every rank.
- `/staff list` and `/staff check` show who has what.

## 2.15.1 — Quarantine fix

- Fixed: a member still quarantined from an old anti-nuke incident lost any staff role they were given, even when the owner gave it. Now, when a whitelisted person (owner, developer or trusted admin) gives a quarantined member a staff role, Vanguard ends the quarantine and logs "Quarantine lifted".
- Grants by anyone else are still removed, and the log now says "Quarantine still active" and how to release them (`/security release`).

## 2.15.2 — Enable no longer blocked by role order

- `/antinuke enable` (and `/enable`) only refuses when Vanguard is missing permissions. Roles above Vanguard are now a warning with a fix hint, because they only stop Vanguard from containing members who hold them.

## 2.15.3 — Restart without the lease error

- Starting right after stopping the bot no longer fails with "Another Vanguard instance holds the database lease". Vanguard waits up to 35 seconds for the old run's lease to run out. A second copy that is still running is still refused.

## 2.15.4 — permission-role uses the new ranks

- `/guild-config permission-role` now offers Head Admin, Admin, Moderator, Helper or Remove access (the same ranks as `/staff role`). Picking one replaces any old "Security admin / Moderation only" setting on that role.
- `/perm list` shows the new ranks first, then any old settings still in place.

## 2.15.5 — Two Supreme Leaders

- Supreme Leader is now BOT_OWNER_ID plus `SUPREME_LEADER_IDS` (default 843909457616044092). Both have full control, including `/staff global`.
- `/staff list` shows the bot owner under Bot Developer as well; extra Supreme Leaders are listed once, under Supreme Leader.

## 2.16.0 — Whitelist presets

- `/trust add` and `/trust remove` have four ★ presets in the **rule** option:
  - **Basic moderation:** bans, kicks and timeouts.
  - **Role manager:** give roles, create, edit and delete roles.
  - **Channel manager:** create, edit and delete channels and webhooks.
  - **Administrator:** everything except adding bots, dangerous permission grants and member prunes.
- A preset only skips its own rules; every other rule still applies. Adding bots, dangerous permission grants and member prunes are never in a preset.
- `/trust list` shows one line per person or role and names the preset they have.

## 2.16.1 — Simpler whitelist removal

- `/trust remove` with **rule** left empty now removes everything that user or role has: the all-rules bypass, presets and single rules. Pick a preset or rule only to remove just that one. The whitelist panel's Remove works the same way.

## 2.16.2 — Whitelist list you can page and refresh

- `/trust list` now has **< Prev**, **Refresh** and **Next >** buttons. Refresh shows changes made since you opened it.
- Roles come first, marked 🛡️; users are marked 👤.
- Whitelisted roles that were deleted from the server are marked so you can remove them.

## 2.16.3 — Give Supreme Leader by command

- `/staff global` can now give or remove **Supreme Leader**. Only a Supreme Leader can use it.
- Built-in Supreme Leaders (BOT_OWNER_ID and SUPREME_LEADER_IDS) cannot be changed by the command.
- Older databases are upgraded automatically; existing Overseers and Bot Managers are kept.

## 2.16.4 — Clearer /trust choices

- The **rule** option is now called **allow**. It starts with **Everything** (full bypass), then the four ★ presets.
- After the presets, single actions are grouped as Moderation, Roles, Channels, Server and ⚠ Danger, in plain words such as "Roles · Give roles to people".
- `/trust remove` starts with **Everything they have**.
- `/trust list` and the logs use the same plain names.

## 2.17.0 — New whitelist panel

- `/trust add` and `/trust remove` are replaced by **`/trust manage`**, a panel:
  1. Pick a user or a role.
  2. Tick what they may do: Everything, ★ presets, or single actions. You can tick several.
  3. Pick how long: permanent, 1 hour, 24 hours, 7 days or 30 days.
  4. Press **Save**.
- Picking someone loads what they already have, so you can see and edit it.
- **Save** replaces their old bypass with exactly what is ticked. **Remove all** clears it.
- **View whitelist** opens the list.
- The **Manage Whitelist** button in `/antinuke status` opens the same panel.
- Names are combined where possible, for example "Basic moderation + Delete channels".

## 2.18.0 — Security, staff and HR tools

**Security** (`/automod`; spam guard, invite blocker and alt check are on by default)
- **Spam guard:** catches 5+ people or roles pinged in one message (a reply ping doesn't count), 6 messages in 5 seconds, or the same message 4 times in 30 seconds. The messages are deleted and the sender gets a 10-minute timeout. Both limits can be changed.
- **Invite blocker:** deletes invites to other Discord servers; invites to your own server are allowed. Three invites in 10 minutes earns a timeout. If Discord can't be reached to check an invite, the message is left alone.
- **Alt-account check:** when someone joins, their linked Roblox account is checked (needs RoVer or Bloxlink). Staff get an alert with Kick and Ban buttons if that account belongs to a banned member or is already linked to another Discord account here. A member coming back after their own ban ended isn't flagged.
- **Quiet hours** (`/automod quiet-hours`): locks the server every day at set times and unlocks it again. It never lifts a lockdown that staff started by hand.
- Staff and whitelisted users are never touched.

**Staff tools**
- **Weekly staff report** in the security log: actions per staff member and duty hours. `/staff report` shows it on demand; `weekly:false` turns the weekly post off.
- **Ban appeals** (`/appeals setup`): `/moderation ban` and `/tempban` DM the user the reason with an **Appeal** button. Appeals arrive in your chosen channel with **Accept (unban)** and **Deny**. Each user can have one open appeal, and must wait 7 days after a denial. An accepted appeal also lifts their Roblox blacklist entry.
- **`/case search`:** search by member, staff member, action, words in the reason, or number of days back.
- **History on rejoin:** when someone with past cases or staff notes rejoins, staff get an alert.

**Server & HR**
- **Rank-change log:** gaining or losing a ranked staff role is posted as a promotion or demotion, with who made the change. In the HR server it is also added to a **Staff Log** tab in the CSB spreadsheet.
- **`/duty`:** on, off, status, hours, leaderboard, end (Admins), and role (Admins; must be a role with no powers). Shifts are capped at 12 hours and appear in the Staff Log sheet.
- **`/welcome`:** a greeting with `{user}`, `{name}`, `{server}` and `{count}`, plus a **Verify with Roblox** button.

**Bot health**
- Supreme Leaders get a **back online** DM when the bot restarts after 3 or more minutes offline.
- **Uptime alert:** set `HEARTBEAT_URL` (a free check at healthchecks.io). If the bot stops pinging, that service alerts you.
- **Daily database backup** is sent by DM to the Supreme Leaders, gzipped. Set `DAILY_BACKUP_DM=false` to turn it off. It starts 24 hours after this update.

## 2.18.1 — Partner servers, link rules, automod status

- **`/automod allow-server`:** allow invites to partner servers. Paste an invite link or the server ID.
- **`/automod links`:** off, block list (remove only sites you block), or allow list (only sites you allow; starts with common safe sites like YouTube, Roblox and Tenor).
- **`/automod link-list`:** allow, block or remove a site. Sub-domains are included.
- Removed links count as strikes, like invites: 3 in 10 minutes earns a timeout.
- **`/automod status`:**
  - It warns when Vanguard is missing Manage Messages or Timeout Members.
  - It also tells you when automod is ignoring you (owner, ranked staff or Manage Messages), so you test with a normal account.

## 2.19.0 — Organized commands

- Discord always lists a bot's commands A→Z, and bots cannot change that order. So the 51 commands are now grouped under a few main ones, and the `/` list is short:
  - **`/antinuke`:** status, on/off, `trust` (whitelist)
  - **`/mod`:** ban, kick, timeout, warn, purge, history, tempban, softban, massban, `case`, `note`, `appeals`, `role`, `nick`
  - **`/security`:** status, config, quarantine…, lockdown, unlock, slowmode, health, `automod`, `raidmode`, `newaccounts`, `scam`, `antiping`, `mention`
  - **`/recovery`:** `snapshot`, `backup`, copylayout
  - **`/setup`:** `staff`, `welcome`, `logs`, `config`, `perm`, `history`
  - **`/info`:** user, role, server, bot, ping
  - **`/dev`:** developer tools
  - These stay on their own: `/help`, `/verify`, `/duty`, `/ask`, `/csb`.
- Everything works the same: same permissions, ranks and settings. Only the names changed (e.g. `/automod links` → `/security automod links`, `/trust manage` → `/antinuke trust manage`). Bot messages and docs use the new names.
- **`/help` is redesigned:** an overview page shows every category with an emoji, a one-line description and how many commands you can use. Each category lists one command per line, 12 per page, with an Overview button.
- `docs/commands.md` is now a table of every command.

## 2.20.0 — Batch 1: emergency, AI moderation, warnings, message logs, Roblox tools

**Anti-nuke**
- **`/security emergency start|stop|panel|status`:** one action locks every channel, pauses invites, turns on raid mode and pings Admin and Head Admin roles.
  - `stop` undoes only what emergency mode changed.
  - `panel` posts Emergency and All clear buttons; Emergency asks to confirm once.
- **Webhook guard:**
  - Every new webhook not made by Vanguard is reported with a **Delete webhook** button.
  - `/security webhooks` lists all webhooks with a menu to delete them.

**Moderation**
- **AI moderation (report only):** `/security automod ai enabled:true`.
  - Uses OpenAI's moderation model with `OPENAI_API_KEY`.
  - Flagged messages are sent to staff with Delete, Warn and Timeout 1h buttons; the buttons are removed once someone acts.
  - Self-harm messages get a gentle "check on them" alert instead.
  - Staff are never checked. At most 120 checks a minute per server.
- **Warning points:** `/mod warnings status|setup|pardon`.
  - Default: 3 warnings in 30 days gives a 1-hour timeout, 5 gives a kick, and the ban level is off.
  - Warnings from a Helper cannot trigger a ban.
- **Message logs:** deleted, edited and bulk-deleted messages are logged with their text when event logging is on (`/setup logs`, "messages" category).

**Roblox** (`/roblox`)
- `lookup`: account age, past names, groups, linked Discord accounts and blacklist status.
- `blacklist`, `unblacklist` and `blacklisted`.
- **Ban network:** `/roblox partner` (both servers must add each other), then `/roblox network share use`.
  - Partners only see a plain reason.
  - Temporary bans are not shared.
  - Unbanning withdraws the shared entry.
- **Group rank sync:** `/roblox group`, `bind`, `unbind`, `binds` and `sync`.
  - Discord roles follow the member's Roblox group rank when they verify, and about every 15 minutes after that.
  - A rank can only give plain roles.

## 2.21.0 — Batch 2: anti-nuke extras and AI moderation upgrades

**Anti-nuke (enforce mode only; observe mode only reports)**
- **Raid auto-trigger:** a join flood switches raid mode on by itself for 1 hour (configurable). It keeps your raid settings (account age, kick or timeout).
- **Server settings lock:** name, icon, banner, invite background, verification level, content filter, notification default and system/rules/updates/AFK channels are put back when someone who is not whitelisted changes them. User and role whitelists (`Server · Edit server settings`) are respected. Anything that cannot be restored (deleted image or channel) is listed instead of stopping the rest.
- **Bot quarantine:** a new bot with powerful permissions loses them straight away unless the server owner, a Supreme Leader or a Developer added it. Approve gives back only the removed permissions; the person who added the bot cannot approve it, and a Head Admin can only approve permissions they have themselves.
- **`/antinuke antinuke-plus audit`:** safety score, powerful roles, roles above Vanguard, bots with Administrator, webhooks.
- **`/antinuke antinuke-plus extras`:** turn each layer on or off, and set the raid auto-trigger hours.
- Turning raid mode on or off no longer resets its account-age and action settings.

**AI moderation**
- Reads images as well as text (PNG, JPEG, GIF, WebP). If OpenAI refuses an image, the text is still checked.
- Sensitivity (low / normal / high), ignored categories, and ignored channels or categories (`/security automod ai-ignore`). Content involving minors is never ignored.
- Modes: report (default), delete (80%+ sure) and strict (also a 1-hour timeout at 90%+). Self-harm is always a kind report, never a punishment.
- Alerts show the 3 messages before it and have Delete, Warn, Timeout and Not a problem buttons. One alert per person per 2 minutes; in delete and strict modes later messages are still removed.
- At most 120 checks a minute per server.
