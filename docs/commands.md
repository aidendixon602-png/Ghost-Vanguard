# Commands

Generated from the bot itself (`npm run docs`). Type `/` in Discord and pick **Ghost Vanguard**; `/help` shows only slash commands you can use. Sensitive and admin slash replies are private; ordinary public utility replies stay public. Developer actions are available as `/dev` and `/network` slash commands (with `,` prefix aliases for compatibility). For the same list grouped by rank, see [ranks.md](ranks.md).

## /antinuke

Anti-nuke readiness, observe/enforce controls, rules and exceptions

| Command | What it does | Who |
|---|---|---|
| `/antinuke scan` | Safety scan: powerful roles, roles above Vanguard, bots with Administrator | Admin+ |
| `/antinuke settings` | Turn the extra protection layers on or off (all on by default) | Owner or Head Admin |
| `/antinuke status` | Is anti-nuke observing or enforcing? Review rules and whitelist | Head Admin+ |
| `/antinuke enable` | Enable enforcement after readiness check and confirmation | Head Admin+ |
| `/antinuke disable` | Turn anti-nuke off (stays off after restarts) | Owner or Head Admin |
| `/antinuke check` | Check Vanguard's permissions and role position | Head Admin+ |
| `/antinuke whitelist add` | Whitelist a user or role: pick what anti-nuke lets them do and for how long | Owner or Head Admin |
| `/antinuke whitelist remove` | Take a user or role off the whitelist completely | Owner or Head Admin |
| `/antinuke whitelist list` | Show everyone on the whitelist, what they skip and when it expires | Head Admin+ |
| `/antinuke whitelist check` | See exactly what anti-nuke lets someone do, and what would get them stripped | Head Admin+ |
| `/antinuke whitelist bots` | Let a verification bot (Bloxlink, RoVer) give verified roles without tripping anti-nuke | Owner or Head Admin |

## /mod

Moderation: ban, kick, timeout, bans, cases, notes, appeals

| Command | What it does | Who |
|---|---|---|
| `/mod appeals setup` | Turn appeals on or off and pick the staff channel they go to | Head Admin+ |
| `/mod appeals pending` | Appeals waiting for a decision | Moderator+ |
| `/mod bans lookup` | A user's ban records in this server | Moderator+ or Ban Members |
| `/mod bans case` | Show one ban record by case ID | Moderator+ or Ban Members |
| `/mod bans recent` | The latest ban records in this server | Moderator+ or Ban Members |
| `/mod bans stats` | Bans and unbans in the last 30 days | Moderator+ or Ban Members |
| `/mod case view` | Show one case: who, what, why and when | Helper+ or Moderate Members |
| `/mod case reason` | Change the reason recorded on a case | Moderator+ or Moderate Members |
| `/mod case delete` | Security admins: permanently delete a case record | Owner or Head Admin |
| `/mod case search` | Find cases by member, staff member, action, words in the reason or date | Helper+ or Moderate Members |
| `/mod case recent` | The latest cases in this server | Helper+ or Moderate Members |
| `/mod ban` | Ban a user (asks to confirm) | Moderator+ or Ban Members |
| `/mod unban` | Admins and owners: lift a ban by user ID (genrebans and hardbans need bot-wide staff) | Admin+ or Administrator (ordinary bans only; an Overseer+ can grant a one-server genreban exception; Supreme Leaders can lift genrebans from the ban-log controls; `/network ungenreban`/`/network unhardban` (`,ungenreban`/`,unhardban` aliases) require an exact `DEVELOPER_IDS` entry) |
| `/mod kick` | Kick a member | Moderator+ or Kick Members |
| `/mod timeout` | Time out a member for a number of minutes | Helper+ or Moderate Members (Helpers up to 60 minutes; Moderators longer) |
| `/mod untimeout` | Remove a timeout | Moderator+ or Moderate Members |
| `/mod warn` | Warn a member (sent by DM and recorded as a case) | Helper+ or Moderate Members |
| `/mod history` | Show a member's last 10 cases | Helper+ or Moderate Members |
| `/mod purge` | Delete up to 100 recent messages in this channel (asks to confirm) | Moderator+ or Manage Messages |
| `/mod nick set` | Give a member a nickname | Moderator+ or Manage Nicknames |
| `/mod nick reset` | Remove a member's nickname | Moderator+ or Manage Nicknames |
| `/mod notes add` | Write a note about a member | Helper+ or Moderate Members |
| `/mod notes list` | Read the notes on a member | Helper+ or Moderate Members |
| `/mod notes remove` | Delete a note by its number | Moderator+ or Moderate Members |
| `/mod softban` | Ban then immediately unban: kicks a member and deletes their recent messages | Moderator+ or Ban Members |
| `/mod tempban` | Ban a user for a set time; Vanguard lifts the ban automatically | Moderator+ or Ban Members |
| `/mod warnings status` | Show the warning levels, or how many warnings someone has | Helper+ |
| `/mod warnings setup` | Change the warning levels (0 turns a level off) | Head Admin+ |
| `/mod warnings pardon` | Wipe someone's active warnings (cases stay in their history) | Head Admin+ |
| `/mod massban` | Raid cleanup: ban up to 200 user IDs at once (whitelisted staff only) | Admin+ (must also be on the anti-nuke whitelist) |

## /security

Raids, lockdowns, automod, scam links and ping protection

| Command | What it does | Who |
|---|---|---|
| `/security status` | Show security health and configuration | Head Admin+ |
| `/security config` | Set the security log channel and Roblox verification options | Head Admin+ |
| `/security admin` | Server owner: add, remove or list security admins | Owner |
| `/security incidents` | View recent anti-nuke incidents | Head Admin+ |
| `/security quarantine` | Contain a member and save their roles | Head Admin+ |
| `/security release` | Restore a quarantined member’s saved roles | Owner or Head Admin |
| `/security antiping status` | Show staff mention protection and configured targets | Admin+ |
| `/security antiping enable` | Enable blocking mentions of configured staff | Admin+ |
| `/security antiping disable` | Disable staff mention blocking | Admin+ |
| `/security antiping protect` | Add a protected staff role mention or individual user | Admin+ |
| `/security antiping remove` | Remove a protected role or user | Admin+ |
| `/security antiping bypass` | Allow or disallow a role to mention protected staff | Admin+ |
| `/security automod status` | Show what automod is doing in this server | Admin+ |
| `/security automod spam` | Mass pings, repeated messages and message bursts | Admin+ |
| `/security automod invites` | Delete invite links to other Discord servers | Admin+ |
| `/security automod allow-server` | Allow (or stop allowing) invites to a partner server | Admin+ |
| `/security automod links` | Choose how links (websites) are handled | Admin+ |
| `/security automod link-list` | Add a website to the allowed or blocked list, or remove it | Admin+ |
| `/security automod ai` | AI moderation: catch harassment, hate, threats and NSFW text and images | Admin+ |
| `/security automod ai-ignore` | Channels or kinds of content AI moderation should skip | Admin+ |
| `/security automod alts` | Alert staff when a new member's Roblox account belongs to a banned or existing member | Admin+ |
| `/security automod quiet-hours` | Lock the server every day between two times, then unlock it | Admin+ |
| `/security emergency start` | Lock every channel, pause invites, turn on raid mode and ping Admins | Owner or Admin |
| `/security emergency stop` | All clear: undo everything emergency mode did | Owner or Admin |
| `/security emergency panel` | Post Emergency / All clear buttons in this channel (put it in a staff channel) | Owner or Admin |
| `/security emergency status` | Is emergency mode on? | Admin+ |
| `/security health` | Check protection, permissions, integrations and backups at a glance | Admin+ |
| `/security lockdown` | Lock every channel and post a notice; /security unlock restores everything exactly | Admin+ |
| `/security newaccounts status` | Show the new-account rule for this server | Admin+ |
| `/security newaccounts on` | Turn the new-account rule on or change it | Admin+ |
| `/security newaccounts off` | Stop handling new accounts | Admin+ |
| `/security raidmode on` | Start raid mode | Admin+ |
| `/security raidmode off` | End raid mode | Admin+ |
| `/security raidmode status` | Show whether raid mode is on and how many joins it handled | Admin+ |
| `/security scam status` | Show automatic protection, scan limits and readiness | Admin+ |
| `/security scam test` | Check text or an image without deletion, bans or AI requests | Admin+ |
| `/security scam enable` | Enable deletion and bans for confirmed scam matches | Admin+ |
| `/security scam disable` | Stop scam scanning in this server | Admin+ |
| `/security scam domain-add` | Block a domain and its subdomains; matches delete and ban | Admin+ |
| `/security scam domain-remove` | Remove a blocked domain | Admin+ |
| `/security scam image-add` | Register a confirmed scam image; exact matches delete and ban | Admin+ |
| `/security scam image-remove` | Remove a custom image reference | Admin+ |
| `/security scam list` | List blocked domains, image references and excluded channels | Admin+ |
| `/security scam exclude` | Exclude or include a channel and its threads | Admin+ |
| `/security scam vision` | Opt in to sending images to OpenAI for text scanning; alerts only | Admin+ |
| `/security slowmode` | Set how often members can send messages in a channel | Moderator+ or Manage Channels |
| `/security threats list` | The threat board for this server | Admin+ (Admin and above; the bot acts by itself above 25 points, always reversibly) |
| `/security threats view` | Everything recorded about one member | Admin+ (Admin and above; shows every scored incident and automatic action) |
| `/security threats clear` | Clear a member from the board (nothing else changes) | Owner or Head Admin (Head Admin and above; clears the board entry only, cases and bans stay) |
| `/security threats release` | Undo an automatic strike: unban and clear the board entry | Owner or Head Admin (Head Admin and above; unbans if they were struck) |
| `/security threats strike` | Counter-attack now: strip, put their damage back and ban | Owner or Head Admin (Head Admin and above; the manual version of the automatic counter-attack) |
| `/security unlock` | End the lockdown and restore every channel exactly as it was | Admin+ |
| `/security webhooks` | List every webhook in the server and delete ones you do not trust | Admin+ |

## /setup

Server setup: logs, staff ranks, welcome, config, permissions

| Command | What it does | Who |
|---|---|---|
| `/setup history list` | Show recent setting changes and who made them | Head Admin+ |
| `/setup history restore` | Server owner: undo a setting change by its number | Owner |
| `/setup config provider` | Enable or disable a configured verification provider | Owner |
| `/setup config permission-role` | Give a Discord role a Vanguard staff rank (Head Admin, Admin, Moderator, Helper) | Owner |
| `/setup config command` | Turn one Vanguard command on/off or change its cooldown | Owner |
| `/setup config feature` | Turn moderation, verification, AI or backups on/off | Owner |
| `/setup config backups` | Configure scheduled server layout backups | Owner |
| `/setup config workspace-setup` | Open the guided Workspace setup panel (channels, roles, sheet — no manual IDs) | Owner |
| `/setup config workspace-publish` | Post or update the configured persistent panels | Owner |
| `/setup config workspace-status` | Show Workspace setup status | Owner |
| `/setup config workspace-enable` | Enable the validated Workspace integration | Owner |
| `/setup config workspace-disable` | Disable Workspace and stop its reminders without deleting records | Owner |
| `/setup config workspace-sync` | Preview and synchronize recognized staff members | Owner |
| `/setup logs setup` | Create or reuse #bans and #ghost-vanguard-logging, check access and send a test | Admin+ |
| `/setup logs check` | Check both log channels and the bot permissions, then send a test embed | Admin+ |
| `/setup logs exclude` | Stop (or start again) logging events from a channel | Admin+ |
| `/setup logs bot-changes` | Skip routine bot changes, like member-count channel renames | Admin+ |
| `/setup logs status` | Show event logging settings | Admin+ |
| `/setup logs enable` | Turn on event logging | Admin+ |
| `/setup logs disable` | Turn off event logging (stored history is kept) | Admin+ |
| `/setup logs category` | Choose which kinds of events are logged | Admin+ |
| `/setup logs view` | Browse logged events from the last 30 days | Admin+ |
| `/setup panel` | Create or update the private control panel channel (buttons for staff) | Owner or Head Admin |
| `/setup permissions list` | Browse the roles that hold Vanguard command access | Head Admin+ |
| `/setup permissions discord` | Roles holding Administrator or Manage Roles, which can reorder the hierarchy | Head Admin+ |
| `/setup staff role` | Link a Discord role to a server rank (Head Admin, Admin, Moderator, Helper) | Owner |
| `/setup staff global` | Developer: make someone Supreme Leader, Overseer or Bot Manager in every server | Developer |
| `/setup staff report` | Staff activity: actions per staff member | Owner |
| `/setup staff list` | Show every rank in this server and bot-wide | Helper+ |
| `/setup staff check` | Show someone's Vanguard rank here | Helper+ |
| `/setup welcome setup` | Turn welcome messages on or off | Admin+ |
| `/setup welcome test` | Send the welcome message for yourself to check how it looks | Admin+ |

## /ticket

Support tickets: the panel, types, settings, stats and staff tools

| Command | What it does | Who |
|---|---|---|
| `/ticket panel` | Post the ticket menu members use to open tickets | Admin+ or Manage Guild |
| `/ticket settings` | View or change this server’s ticket settings | Admin+ or Manage Guild |
| `/ticket setup` | Set up the ticket desk: staff role, category, log channel and the ticket panel | Admin+ or Manage Guild |
| `/ticket stats` | Ticket statistics and the staff leaderboard | Admin+ or Manage Guild |
| `/ticket types add` | Add a ticket type to the menu | Admin+ or Manage Guild |
| `/ticket types edit` | Rename a ticket type or change its emoji or description | Admin+ or Manage Guild |
| `/ticket types remove` | Remove a ticket type from the menu | Admin+ or Manage Guild |
| `/ticket types list` | Show every ticket type | Admin+ or Manage Guild |
| `/ticket types reset` | Replace the ticket types with the defaults | Admin+ or Manage Guild |
| `/ticket claim` | Claim this ticket so you are the one handling it | Everyone (ticket staff role, Manage Server or a Vanguard rank) |
| `/ticket unclaim` | Release this ticket so another staff member can take it | Everyone (the staff member who claimed it, or an admin) |
| `/ticket transfer` | Hand this ticket to another staff member | Everyone (ticket staff only) |
| `/ticket priority` | Set how urgent this ticket is | Everyone (ticket staff only) |
| `/ticket close` | Close this ticket and save the transcript | Everyone (the member who opened the ticket, or ticket staff) |
| `/ticket closerequest` | Ask the member if their issue is solved and the ticket can close | Everyone (ticket staff only) |
| `/ticket add` | Add someone to this ticket | Everyone (ticket staff only) |
| `/ticket remove` | Remove someone from this ticket | Everyone (ticket staff only) |
| `/ticket rename` | Rename this ticket channel | Everyone (ticket staff only) |
| `/ticket history` | See a member's past tickets in this server | Everyone (ticket staff only) |
| `/ticket block` | Stop a member from opening tickets in this server | Everyone (ticket staff only; bots and staff cannot be blocked) |
| `/ticket unblock` | Let a blocked member open tickets again | Everyone (ticket staff only) |
| `/ticket blocked` | List members blocked from opening tickets | Everyone (ticket staff only) |

## /recovery

Server backups and snapshots: save, restore, copy layout

| Command | What it does | Who |
|---|---|---|
| `/recovery backup create` | Save a manual server backup | Head Admin+ |
| `/recovery backup list` | List this server's backups, newest first | Head Admin+ |
| `/recovery backup restore` | Preview restoring a backup, then confirm | Owner or Head Admin |
| `/recovery backup delete` | Delete backups: one (3), several (3,5,7), a range (2-6) or all | Owner or Head Admin |
| `/recovery copylayout` | Copy this server's roles and channels to another server Vanguard protects | Owner or Head Admin |
| `/recovery snapshot create` | Save roles, category/channel layout and permission overwrites | Head Admin+ |
| `/recovery snapshot list` | List this server's snapshots and backups, newest first | Head Admin+ |
| `/recovery snapshot restore` | Preview restoring a snapshot or backup, then confirm | Owner or Head Admin |
| `/recovery snapshot delete` | Delete snapshots/backups: one (3), several (3,5,7), a range (2-6) or all | Owner or Head Admin |
| `/recovery snapshot cleanup` | Delete old snapshots/backups in bulk by age and type (previews first) | Owner or Head Admin |

## /info

Look things up: users, roles, the server and the bot

| Command | What it does | Who |
|---|---|---|
| `/info bot` | About Vanguard: developer, uptime and protection statistics | Everyone |
| `/info ping` | Check that Vanguard is responding: latency, uptime and version | Everyone |
| `/info role` | Role details: members, position, key permissions and anti-nuke bypass | Everyone |
| `/info server` | Browse complete server details and Vanguard protection status | Everyone |
| `/info user` | Member details; staff also see cases, notes, bypasses and Roblox link | Everyone |

## /network

Developers: genrebans and hardbans across every Midtown server

| Command | What it does | Who |
|---|---|---|
| `/network genreban` | Developer: ban a user from every authorized server until ,ungenreban | Supreme Leader+ |
| `/network hardban` | Developer: permanently ban a user from every authorized server until ,unhardban | Supreme Leader+ |
| `/network exceptions list` | Active genreban exceptions, newest first | Supreme Leader+ |
| `/network exceptions revoke` | Cancel an exception: the genreban applies in that server again | Supreme Leader+ |
| `/network ungenreban` | Developer: revoke a genreban and lift it in every authorized server | Supreme Leader+ |
| `/network unhardban` | Developer: revoke a hardban and lift it in every authorized server | Developer |

## /dev

Bot developers: diagnostics, updates, servers and the database

| Command | What it does | Who |
|---|---|---|
| `/dev server list` | Developer: list every server Vanguard is authorized in | Bot Manager+ |
| `/dev server authorize` | Developer: authorize this server so Vanguard protects it | Overseer+ |
| `/dev autoreact add` | React to every message from a member (🐐 by default) | Supreme Leader+ |
| `/dev autoreact remove` | Stop auto-reacting to a member | Supreme Leader+ |
| `/dev autoreact list` | Members the bot auto-reacts to in this server | Supreme Leader+ |
| `/dev server ban` | Developer: ban a server from Vanguard | Developer |
| `/dev database status` | Show database health, storage, backup and migration status | Supreme Leader+ |
| `/dev database backup` | Create a verified database backup now | Supreme Leader+ |
| `/dev database backups` | List recent database backups | Supreme Leader+ |
| `/dev database restore-settings` | Developer: put back lost settings from an old backup file; anything newer is kept | Developer |
| `/dev database verify` | Recheck backup checksum and database integrity | Supreme Leader+ |
| `/dev server deauthorize` | Developer: remove this server's authorization and leave | Developer |
| `/dev diagnostics` | Inspect runtime health without secrets | Bot Manager+ |
| `/dev inspect` | Read-only overview of any server Vanguard knows | Overseer+ |
| `/dev broadcast` | Post an announcement to every authorized server's log channel | Bot Manager+ |
| `/dev status` | Show a custom bot status instead of the rotation | Bot Manager+ |
| `/dev status-reset` | Return to the normal rotating status | Bot Manager+ |
| `/dev update` | Automatic GitHub updates: see the status, or install now (Developer) | Supreme Leader+ |
| `/dev sync` | Force re-register slash commands globally (and instantly in this server) | Supreme Leader+ |
| `/dev server info` | Developer: show this server's authorization details | Bot Manager+ |
| `/dev server unban` | Developer: remove a server ban | Developer |

## /help

Browse every command you can use, by section

| Command | What it does | Who |
|---|---|---|
| `/help` | Browse every command you can use, by section | Everyone |

## /verify

Link your Roblox account and get your verified role

| Command | What it does | Who |
|---|---|---|
| `/verify` | Link your Roblox account and get your verified role | Everyone |

## /roblox

Roblox: look up accounts, blacklist, shared ban network and group rank sync

| Command | What it does | Who |
|---|---|---|
| `/roblox lookup` | Profile card: account age, past names, groups, linked Discord, blacklist status | Helper+ |
| `/roblox blacklist` | Block a Roblox account from verifying here (and flag it on join) | Moderator+ |
| `/roblox unblacklist` | Remove a Roblox account from this server's blacklist | Moderator+ |
| `/roblox blacklisted` | List blacklisted Roblox accounts | Helper+ |
| `/roblox network` | Share blacklists with your partner servers (both servers must add each other) | Owner or Head Admin |
| `/roblox partner` | Add or remove a partner server for the ban network (do it in both servers) | Owner or Head Admin |
| `/roblox group` | Set the Roblox group whose ranks give Discord roles | Head Admin+ |
| `/roblox bind` | Give a Discord role for a group rank | Head Admin+ |
| `/roblox unbind` | Stop giving a role from group ranks | Head Admin+ |
| `/roblox binds` | Show the group and its rank → role binds | Helper+ |
| `/roblox sync` | Re-check someone's Roblox verification and group roles now | Helper+ |
| `/roblox bloxlink-sync` | Ask Bloxlink to re-sync this member's linked roles and nickname | Admin+ |

## /ask

Ask the AI assistant a question (when AI is enabled)

| Command | What it does | Who |
|---|---|---|
| `/ask` | Ask the AI assistant a question (when AI is enabled) | Everyone |

## /role

Give or take a role from a member, with role rules and hierarchy enforced

| Command | What it does | Who |
|---|---|---|
| `/role add` | Give a member a role | Everyone (checked role by role: Manage Roles or a Moderator rank, and staff roles need `/role who-can-give`) |
| `/role remove` | Take a role from a member | Everyone (checked role by role, like `/role add`) |
| `/role restore` | Give a member back the roles they had before they left the server | Everyone (gives back only roles the person could give with `/role add`) |
| `/role who-can-give` | Choose who can give a role, or see the list (leave everything empty) | Owner or Head Admin (staff roles: owner only) |

## /restart

Gracefully restart the bot and update this message with downtime

| Command | What it does | Who |
|---|---|---|
| `/restart` | Gracefully restart the bot and update this message with downtime | Developer |

## Comma aliases (compatibility)

Every slash command above also works with a `,` prefix (e.g. `,dev status`). The legacy developer list below is kept for reference:

**Developer comma commands** · only IDs listed in `DEVELOPER_IDS` (the bot owner is not an implicit exception)
`,restart` — gracefully restart, then update this message with the actual downtime and readiness status.
`,authserver` — Developer: authorize this server so Vanguard protects it
`,autoreact add <user> [--emoji <emoji>]` — React to every message from a member (🐐 by default)
`,autoreact list` — Members the bot auto-reacts to in this server
`,autoreact remove <user>` — Stop auto-reacting to a member
`,banserver [--guild_id <guild_id>] [--reason <reason>]` — Developer: ban a server from Vanguard
`,database backup` — Create a verified database backup now
`,database backups` — List recent database backups
`,database restore-settings <attach file>` — Developer: put back lost settings from an old backup file; anything newer is kept
`,database status` — Show database health, storage, backup and migration status
`,database verify <backup>` — Recheck backup checksum and database integrity
`,deauthserver DEAUTHORIZE` — Developer: remove this server's authorization and leave
`,dev broadcast <message> [--title <title>] [--confirm <confirm>]` — Post an announcement to every authorized server's log channel
`,dev diagnostics` — Inspect runtime health without secrets
`,dev inspect <guild_id>` — Read-only overview of any server Vanguard knows
`,dev status <text> [--minutes <number>] [--presence online|idle|dnd]` — Show a custom bot status instead of the rotation
`,dev status-reset` — Return to the normal rotating status
`,dev sync [--guild_id <guild_id>]` — Force re-register slash commands globally (and instantly in this server)
`,genreban <user> [--reason <reason>] [--evidence <evidence>] [attach file] [--delete_messages 0|3600|86400|604800]` — Developer: ban a user from every authorized server until ,ungenreban
`,hardban <user> [--reason <reason>] [--evidence <evidence>] [attach file] [--delete_messages 0|3600|86400|604800]` — Developer: permanently ban a user from every authorized server until ,unhardban
`,netexception list [--user_id <user_id>]` — Active genreban exceptions, newest first
`,netexception revoke <number>` — Cancel an exception: the genreban applies in that server again
`,restart` — Gracefully restart the bot and update this message with downtime
`,serverauth` — Developer: show this server's authorization details
`,servers [--page <number>]` — Developer: list every server Vanguard is authorized in
`,staff global <user> supreme|overseer|botmanager|none` — Developer: make someone Supreme Leader, Overseer or Bot Manager in every server
`,unbanserver <guild_id>` — Developer: remove a server ban
`,ungenreban <user> [--reason <reason>]` — Developer: revoke a genreban and lift it in every authorized server
`,unhardban <user> [--reason <reason>] [--unban]` — Developer: revoke a hardban and lift it in every authorized server
`,update [status|now]` — Automatic GitHub updates: see the status, or install now (Developer)
Use quotes for multiword values, `--option value` for optional arguments, and attach the backup file for `,database restore-settings`.
Slash commands stay permission-checked; use `/help` for the non-developer command menu.
