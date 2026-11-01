# Commands

Generated from the bot itself (`npm run docs`). Type `/` in Discord and pick **Ghost Vanguard**; `/help` shows only slash commands you can use. Sensitive and admin slash replies are private; ordinary public utility replies stay public. Developer actions are available as `/dev`, `/genreban`, `/ungenreban`, `/hardban`, `/unhardban`, `/netexception` and `/restart` slash commands. For the same list grouped by rank, see [ranks.md](ranks.md).

## /antinuke

Protect your server, review incidents and manage trusted users

| Command | What it does | Who |
|---|---|---|
| `/antinuke scan` | Scan for risky roles, roles above the bot and admin bots | Admin+ |
| `/antinuke settings` | Turn the extra protection layers on or off | Server Owner |
| `/antinuke status` | See whether anti-nuke is on, its rules and the whitelist | Head Admin+ |
| `/antinuke rule` | Tune one rule threshold or turn it on/off | Server Owner |
| `/antinuke reset` | Restore one rule to its default threshold and state | Server Owner |
| `/antinuke enable` | Turn anti-nuke enforcement on (runs a readiness check first) | Server Owner |
| `/antinuke disable` | Turn anti-nuke off (stays off after restarts) | Server Owner |
| `/antinuke check` | Check the bot's permissions and role position | Head Admin+ |
| `/antinuke incidents` | Show recent anti-nuke incidents | Head Admin+ |
| `/antinuke quarantine` | Strip a member's roles and save them | Head Admin+ |
| `/antinuke release` | Give a quarantined member their saved roles back | Owner or Head Admin |
| `/antinuke threats list` | Show the threat board | Admin+ (Admin and above; scores and levels are informational and never trigger automatic enforcement) |
| `/antinuke threats view` | Show everything recorded about a member | Admin+ (Admin and above; shows every scored incident and staff action) |
| `/antinuke threats clear` | Clear a member from the threat board | Owner or Head Admin (Head Admin and above; clears the board entry only, cases and bans stay) |
| `/antinuke threats release` | Undo a strike (unban and clear) | Owner or Head Admin (Head Admin and above; unbans if they were struck) |
| `/antinuke threats strike` | Strip, revert their damage and ban a member now | Owner or Head Admin (Head Admin and above; manually strips, records and bans) |
| `/antinuke whitelist add` | Whitelist a user or role for some or all rules | Server Owner |
| `/antinuke whitelist remove` | Take a user or role off the whitelist | Server Owner |
| `/antinuke whitelist list` | Show the whitelist and when entries expire | Head Admin+ |
| `/antinuke whitelist admin` | Separate whitelist for granting Administrator and protected permissions | Server Owner |
| `/antinuke whitelist check` | See what anti-nuke allows someone and what would strip them | Head Admin+ |
| `/antinuke whitelist bots` | Let a verification bot give roles without tripping anti-nuke | Server Owner |

## /automod

Manage spam, links, scam protection and message filters

| Command | What it does | Who |
|---|---|---|
| `/automod antiping status` | Show staff ping protection | Admin+ |
| `/automod antiping enable` | Turn staff ping protection on | Admin+ |
| `/automod antiping disable` | Turn staff ping protection off | Admin+ |
| `/automod antiping protect` | Protect a staff role or user from pings | Admin+ |
| `/automod antiping remove` | Stop protecting a role or user | Admin+ |
| `/automod antiping bypass` | Let a role ping protected staff, or stop it | Admin+ |
| `/automod status` | Show what automod is doing here | Admin+ |
| `/automod spam` | Set limits for mass pings, repeats and message bursts | Admin+ |
| `/automod invites` | Delete invites to other Discord servers | Admin+ |
| `/automod allow-server` | Allow, or stop allowing, invites to a partner server | Admin+ |
| `/automod links` | Choose how website links are handled | Admin+ |
| `/automod link-list` | Add or remove a website on the allow or block list | Admin+ |
| `/automod words` | Turn blocked phrase filtering on or off | Admin+ |
| `/automod word-list` | Manage blocked words and phrases | Admin+ |
| `/automod ai` | Turn AI moderation of text and images on or off | Admin+ |
| `/automod ai-ignore` | Pick channels or content that AI moderation skips | Admin+ |
| `/automod alts` | Alert staff when a new member's Roblox account is an alt | Admin+ |
| `/automod quiet-hours` | Lock the server between two times every day | Admin+ |
| `/automod scam status` | Show scam protection status and limits | Admin+ |
| `/automod scam test` | Test text or an image without taking action | Admin+ |
| `/automod scam enable` | Delete and ban on confirmed scam matches | Admin+ |
| `/automod scam disable` | Stop scam scanning here | Admin+ |
| `/automod scam domain-add` | Block a domain and its subdomains | Admin+ |
| `/automod scam domain-remove` | Unblock a domain | Admin+ |
| `/automod scam image-add` | Add a confirmed scam image | Admin+ |
| `/automod scam image-remove` | Remove a scam image | Admin+ |
| `/automod scam list` | List blocked domains, images and excluded channels | Admin+ |
| `/automod scam exclude` | Exclude or include a channel | Admin+ |
| `/automod scam vision` | Let OpenAI read text in images (alerts only) | Admin+ |

## /raid

Respond to raids, lock channels and inspect server health

| Command | What it does | Who |
|---|---|---|
| `/raid emergency start` | Lock down, pause invites, turn on raid mode, ping Admins | Owner or Admin |
| `/raid emergency stop` | All clear: undo emergency mode | Owner or Admin |
| `/raid emergency panel` | Post Emergency and All clear buttons here | Owner or Admin |
| `/raid emergency status` | Show whether emergency mode is on | Admin+ |
| `/raid health` | Check protection, permissions and backups | Admin+ |
| `/raid lockdown` | Lock every channel and post a notice | Admin+ |
| `/raid newaccounts status` | Show the new-account rule | Admin+ |
| `/raid newaccounts on` | Turn the new-account rule on or change it | Admin+ |
| `/raid newaccounts off` | Turn the new-account rule off | Admin+ |
| `/raid mode on` | Turn raid mode on | Admin+ |
| `/raid mode off` | Turn raid mode off | Admin+ |
| `/raid mode status` | Show raid mode and how many joins it handled | Admin+ |
| `/raid unlock` | End the lockdown and restore every channel | Admin+ |
| `/raid webhooks` | List webhooks and delete untrusted ones | Admin+ |

## /mod

Moderate members and review cases, notes and appeals

| Command | What it does | Who |
|---|---|---|
| `/mod appeals setup` | Turn ban appeals on or off | Head Admin+ |
| `/mod appeals pending` | Show appeals waiting for a decision | Moderator+ |
| `/mod bans lookup` | Show a user's ban records | Moderator+ or Ban Members |
| `/mod bans case` | Show a ban record by case ID | Moderator+ or Ban Members |
| `/mod bans recent` | Show the latest ban records | Moderator+ or Ban Members |
| `/mod bans stats` | Show bans and unbans from the last 30 days | Moderator+ or Ban Members |
| `/mod cases view` | Show a case | Helper+ or Moderate Members |
| `/mod cases reason` | Change a case's reason | Moderator+ or Moderate Members |
| `/mod cases delete` | Delete a case permanently | Owner or Head Admin |
| `/mod cases search` | Search cases by member, staff, action, reason or date | Helper+ or Moderate Members |
| `/mod cases recent` | Show the latest cases | Helper+ or Moderate Members |
| `/mod ban` | Ban a user | Moderator+ or Ban Members |
| `/mod unban` | Lift a ban (not genrebans or hardbans) | Admin+ or Administrator (Admins may lift ordinary bans here; ban-log buttons are server-owner/Developer only (500 ms cooldown; successful actions post who clicked in #bans); genreban and hardban lifts, and genreban exceptions, are Developer only) |
| `/mod kick` | Kick a member | Moderator+ or Kick Members |
| `/mod timeout` | Time out a member | Helper+ or Moderate Members (Helpers up to 60 minutes; Moderators longer) |
| `/mod untimeout` | Remove a member's timeout | Moderator+ or Moderate Members |
| `/mod warn` | Warn a member (DMed and logged as a case) | Helper+ or Moderate Members |
| `/mod history` | Show a member's last 10 cases | Helper+ or Moderate Members |
| `/mod purge` | Delete up to 100 recent messages here | Moderator+ or Manage Messages |
| `/mod nick set` | Set a member's nickname | Moderator+ or Manage Nicknames |
| `/mod nick reset` | Reset a member's nickname | Moderator+ or Manage Nicknames |
| `/mod notes add` | Add a note about a member | Helper+ or Moderate Members |
| `/mod notes list` | Show a member's notes | Helper+ or Moderate Members |
| `/mod notes remove` | Delete a note | Moderator+ or Moderate Members |
| `/mod softban` | Kick a member and delete their recent messages | Moderator+ or Ban Members |
| `/mod tempban` | Ban a user for a set time | Moderator+ or Ban Members |
| `/mod warnings status` | Show warning levels or someone's warnings | Helper+ |
| `/mod warnings setup` | Change the warning levels | Head Admin+ |
| `/mod warnings pardon` | Clear someone's active warnings | Head Admin+ |
| `/mod massban` | Ban up to 200 user IDs at once | Admin+ (must also be on the anti-nuke whitelist) |
| `/mod slowmode` | Set a channel's slowmode | Moderator+ or Manage Channels |

## /setup

Set up logs, staff roles, welcome messages and controls

| Command | What it does | Who |
|---|---|---|
| `/setup history list` | Show recent setting changes | Head Admin+ |
| `/setup history restore` | Undo a setting change | Server Owner |
| `/setup config provider` | Turn a verification provider on or off | Server Owner |
| `/setup config permission-role` | Server owner: give a Discord role a Vanguard rank | Server Owner |
| `/setup config command` | Turn a command on or off, or change its cooldown | Server Owner |
| `/setup config feature` | Turn moderation, verification, AI or backups on or off | Server Owner |
| `/setup config backups` | Schedule server layout backups | Server Owner |
| `/setup logs setup` | Set up log channels and reuse existing event logs | Admin+ |
| `/setup logs route` | Choose a private channel for a log type, or reset its destination | Admin+ |
| `/setup logs merge` | Group Vanguard's log channels, leaving other bots' logs alone | Admin+ |
| `/setup logs cleanup-archive` | Preview and delete channels in the old log archive | Server Owner |
| `/setup logs check` | Check the log channels and permissions | Admin+ |
| `/setup logs exclude` | Stop or resume logging a channel | Admin+ |
| `/setup logs bot-changes` | Skip routine bot changes in the logs | Admin+ |
| `/setup logs status` | Show logging settings | Admin+ |
| `/setup logs enable` | Turn event logging on | Admin+ |
| `/setup logs disable` | Turn event logging off | Admin+ |
| `/setup logs category` | Choose which events are logged | Admin+ |
| `/setup logs view` | Browse logged events (last 30 days) | Admin+ |
| `/setup panel` | Create or update the staff control panel | Server Owner |
| `/setup permissions list` | Show roles with bot command access | Head Admin+ |
| `/setup permissions discord` | Show roles with Administrator or Manage Roles | Server Owner |
| `/setup status` | Show security health and settings | Head Admin+ |
| `/setup security` | Set the security log and Roblox verification options | Server Owner |
| `/setup security-admins` | Developer: add, remove or list security admins | Developer |
| `/setup staff role` | Link a Discord role to a server rank, below your own | Server Owner |
| `/setup staff user` | Assign a server rank to one user ID, below your own | Server Owner |
| `/setup staff global` | Developer: give a bot-wide rank in every server | Developer |
| `/setup staff report` | Show actions per staff member | Server Owner |
| `/setup staff list` | Show every staff rank | Helper+ |
| `/setup staff check` | Show someone's rank | Helper+ |
| `/setup welcome setup` | Turn welcome messages on or off | Admin+ |
| `/setup welcome test` | Preview the welcome message | Admin+ |

## /ticket

Set up support tickets and manage open requests

| Command | What it does | Who |
|---|---|---|
| `/ticket panel` | Post the ticket panel | Admin+ or Manage Guild |
| `/ticket settings` | View or change ticket settings | Admin+ or Manage Guild |
| `/ticket setup` | Set up the ticket desk and its panel | Admin+ or Manage Guild |
| `/ticket stats` | Show ticket stats and the staff leaderboard | Admin+ or Manage Guild |
| `/ticket types add` | Add a ticket type | Admin+ or Manage Guild |
| `/ticket types edit` | Edit a ticket type | Admin+ or Manage Guild |
| `/ticket types remove` | Remove a ticket type | Admin+ or Manage Guild |
| `/ticket types list` | List ticket types | Admin+ or Manage Guild |
| `/ticket types reset` | Reset ticket types to the defaults | Admin+ or Manage Guild |
| `/ticket claim` | Claim this ticket | Everyone (ticket staff role, Manage Server or a Vanguard rank) |
| `/ticket unclaim` | Unclaim this ticket | Everyone (the staff member who claimed it, or an admin) |
| `/ticket transfer` | Hand this ticket to another staff member | Everyone (ticket staff only) |
| `/ticket priority` | Set this ticket's priority | Everyone (ticket staff only) |
| `/ticket close` | Close this ticket and save the transcript | Everyone (the member who opened the ticket, or ticket staff) |
| `/ticket closerequest` | Ask the member if the ticket can close | Everyone (ticket staff only) |
| `/ticket add` | Add someone to this ticket | Everyone (ticket staff only) |
| `/ticket remove` | Remove someone from this ticket | Everyone (ticket staff only) |
| `/ticket rename` | Rename this ticket | Everyone (ticket staff only) |
| `/ticket history` | Show a member's past tickets | Everyone (ticket staff only) |
| `/ticket block` | Block a member from opening tickets | Everyone (ticket staff only; bots and staff cannot be blocked) |
| `/ticket unblock` | Unblock a member | Everyone (ticket staff only) |
| `/ticket blocked` | List blocked members | Everyone (ticket staff only) |

## /recovery

Save and restore server layouts and backups

| Command | What it does | Who |
|---|---|---|
| `/recovery backup create` | Save a server backup | Head Admin+ |
| `/recovery backup list` | List backups | Head Admin+ |
| `/recovery backup restore` | Preview and restore a backup | Owner or Head Admin |
| `/recovery backup delete` | Delete backups (3, 3,5,7, 2-6 or all) | Owner or Head Admin |
| `/recovery copylayout` | Copy roles and channels to another server | Owner or Head Admin |
| `/recovery snapshot create` | Save roles, channels and permissions | Head Admin+ |
| `/recovery snapshot list` | List snapshots and backups | Head Admin+ |
| `/recovery snapshot restore` | Preview and restore a snapshot | Owner or Head Admin |
| `/recovery snapshot delete` | Delete snapshots (3, 3,5,7, 2-6 or all) | Owner or Head Admin |
| `/recovery snapshot cleanup` | Delete old snapshots by age (previews first) | Owner or Head Admin |

## /info

Look up members, roles, server information and bot status

| Command | What it does | Who |
|---|---|---|
| `/info bot` | About the bot | Everyone |
| `/info ping` | Check the bot's latency and uptime | Everyone |
| `/info role` | Show a role's details | Everyone |
| `/info server` | Show server details and protection | Everyone |
| `/info user` | Show a member's details | Everyone |

## /dev

Manage bot diagnostics, updates, servers and data

| Command | What it does | Who |
|---|---|---|
| `/dev server list` | List authorized servers | Developer |
| `/dev server authorize` | Authorize this server | Developer |
| `/dev autoreact add` | Auto-react to a member's messages | Developer |
| `/dev autoreact remove` | Stop auto-reacting to a member | Developer |
| `/dev autoreact list` | List auto-react members | Developer |
| `/dev server ban` | Ban a server from the bot | Developer |
| `/dev database status` | Show database health | Developer |
| `/dev database backup` | Back up the database now | Developer |
| `/dev database backups` | List database backups | Developer |
| `/dev database restore-settings` | Restore lost settings from a backup file | Developer |
| `/dev database verify` | Verify a database backup | Developer |
| `/dev server deauthorize` | Remove this server and leave | Developer |
| `/dev diagnostics` | Show runtime health | Developer |
| `/dev inspect` | Inspect any server the bot knows | Developer |
| `/dev broadcast` | Announce to every server's log channel | Developer |
| `/dev status` | Set a custom bot status | Developer |
| `/dev status-reset` | Go back to the rotating status | Developer |
| `/dev alerts` | Set up the global anti-nuke feed and DMs | Developer |
| `/dev update` | Show update status or install now | Developer |
| `/dev sync` | Re-register the slash commands | Developer |
| `/dev server info` | Show this server's authorization | Developer |
| `/dev server unban` | Unban a server | Developer |

## /help

Browse the commands you can use

| Command | What it does | Who |
|---|---|---|
| `/help` | Browse the commands you can use | Everyone |

## /verify

Link your Roblox account

| Command | What it does | Who |
|---|---|---|
| `/verify` | Link your Roblox account | Everyone |

## /roblox

Roblox: look up accounts, blacklist sharing and group rank sync

| Command | What it does | Who |
|---|---|---|
| `/roblox lookup` | Look up a Roblox account | Helper+ |
| `/roblox blacklist` | Blacklist a Roblox account | Moderator+ |
| `/roblox unblacklist` | Remove a Roblox account from the blacklist | Moderator+ |
| `/roblox blacklisted` | List blacklisted Roblox accounts | Helper+ |
| `/roblox sharing` | Share blacklists with partner servers | Owner or Head Admin |
| `/roblox partner` | Add or remove a partner server | Owner or Head Admin |
| `/roblox group` | Set the Roblox group for rank roles | Head Admin+ |
| `/roblox bind` | Give a role for a group rank | Head Admin+ |
| `/roblox unbind` | Remove a group rank role | Head Admin+ |
| `/roblox binds` | Show group rank roles | Helper+ |
| `/roblox sync` | Re-check someone's verification now | Helper+ |
| `/roblox bloxlink-sync` | Re-sync someone through Bloxlink | Admin+ |

## /ask

Ask the AI assistant a question

| Command | What it does | Who |
|---|---|---|
| `/ask` | Ask the AI assistant a question | Everyone |

## /role

Give or take a role from a member, with role rules and hierarchy enforced

| Command | What it does | Who |
|---|---|---|
| `/role add` | Give a member a role | Everyone (ordinary roles require Manage Roles, Administrator or a Vanguard Moderator rank; bot permission roles require a Developer; other privileged roles need owner approval) |
| `/role remove` | Take a role from a member | Everyone (checked role by role, like `/role add`) |
| `/role restore` | Give back the roles a member had before leaving | Everyone (gives back only roles the person could give with `/role add`) |
| `/role who-can-give` | Choose who can give a role | Owner or Head Admin (staff roles: owner only) |
| `/role blacklist add` | Blacklist a role so only listed people can give it | Server Owner |
| `/role blacklist remove` | Take a role off the blacklist | Server Owner |
| `/role blacklist list` | Show every blacklisted role and who may give it | Server Owner |
| `/role blacklist who-can-give` | Allow or stop one person or role from giving a blacklisted role | Server Owner |

## /restart

Restart the bot · Developer

| Command | What it does | Who |
|---|---|---|
| `/restart` | Restart the bot | Developer |

## /genreban

Ban a user from every server · Developer

| Command | What it does | Who |
|---|---|---|
| `/genreban` | Ban a user from every server | Developer |

## /hardban

Permanently ban a user from every server · Developer

| Command | What it does | Who |
|---|---|---|
| `/hardban` | Permanently ban a user from every server | Developer |

## /netexception

Developer: servers that let a genrebanned user back in (their server only)

| Command | What it does | Who |
|---|---|---|
| `/netexception list` | List genreban exceptions | Developer |
| `/netexception revoke` | Cancel a genreban exception | Developer |

## /ungenreban

Lift a genreban everywhere · Developer

| Command | What it does | Who |
|---|---|---|
| `/ungenreban` | Lift a genreban everywhere | Developer |

## /unhardban

Lift a hardban everywhere · Developer

| Command | What it does | Who |
|---|---|---|
| `/unhardban` | Lift a hardban everywhere | Developer |
