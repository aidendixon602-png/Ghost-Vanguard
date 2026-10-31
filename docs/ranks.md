# Ranks

Generated from the bot itself (`npm run docs`). Every rank can also use everything listed under the ranks below it.

- **Developer** has full control of the bot. **Supreme Leader, Overseer and Bot Manager** are bot ranks that work in every server.
- **Server Owner** (whoever owns the Discord server) and the server ranks (Head Admin, Admin, Moderator, Helper) work only in that server. A Server Owner outranks Supreme Leaders there, but bot-wide tools always need a bot rank.
- **Developer is the top rank** (the bot owner and `DEVELOPER_IDS`). Restarts, installing updates, restoring data, removing servers, bot-wide ranks and every network-ban action are Developer only, so giving someone Supreme Leader or lower cannot affect the whole network.
- **Unbans:** ordinary bans are lifted by Admins and server owners; genrebans and hardbans, including one-server genreban exceptions, are Developer only.
- **Anti-nuke watches everyone.** Developers, server owners and whitelisted people are never punished (recorded quietly; `ALERT_EXEMPT=true` alerts on them too); every other rank, Supreme Leaders included, is punished.
- Check anyone with `/setup staff check user:@them`; see all ranks with `/setup staff list`.

## 🧰 Developer

The top rank: the bot owner (`BOT_OWNER_ID`) and anyone in `DEVELOPER_IDS`. Everything, including the tools that can take the bot down or reach every server at once: restarts, installing updates, restoring database settings, removing or banning servers, giving bot-wide ranks and managing network bans. Watched by anti-nuke, but never punished. Set only in `.env`.

- `/dev alerts`: Set up the global anti-nuke feed and DMs
- `/dev database restore-settings`: Restore lost settings from a backup file
- `/dev server ban`: Ban a server from the bot
- `/dev server deauthorize`: Remove this server and leave
- `/dev server unban`: Unban a server
- `/genreban`: Ban a user from every server
- `/hardban`: Permanently ban a user from every server
- `/netexception list`: List genreban exceptions
- `/netexception revoke`: Cancel a genreban exception
- `/restart`: Restart the bot
- `/setup staff global`: Give someone a bot-wide rank
- `/ungenreban`: Lift a genreban everywhere
- `/unhardban`: Lift a hardban everywhere

## 🏠 Server Owner

Whoever owns a Discord server, in that server only. Above Supreme Leader there: everything server-side, including security admins and undoing setting changes. No bot-wide tools (network bans, /dev, the database). Watched by anti-nuke, but never punished.

- `/setup history restore`: Undo a setting change
- `/setup security-admins`: Add, remove or list security admins

## 👑 Supreme Leader

Bot-wide, every server: diagnostics, update status, database health and backups. Cannot issue, lift or except network bans; those are Developer-only. Punished by anti-nuke like anyone else. Given with `/setup staff global` or `SUPREME_LEADER_IDS`.

- `/dev autoreact add`: Auto-react to a member's messages
- `/dev autoreact list`: List auto-react members
- `/dev autoreact remove`: Stop auto-reacting to a member
- `/dev database backup`: Back up the database now
- `/dev database backups`: List database backups
- `/dev database status`: Show database health
- `/dev database verify`: Verify a database backup
- `/dev sync`: Re-register the slash commands
- `/dev update`: Show update status or install now

## 🔭 Overseer

Bot-wide, every server: Bot Manager plus inspecting and authorizing servers. Network-ban exceptions are Developer-only. Given with `/setup staff global`.

- `/dev inspect`: Inspect any server the bot knows
- `/dev server authorize`: Authorize this server

## 🛠️ Bot Manager

Bot-wide, every server: Head Admin everywhere plus bot status, diagnostics and announcements. Given with `/setup staff global`.

- `/dev broadcast`: Announce to every server's log channel
- `/dev diagnostics`: Show runtime health
- `/dev server info`: Show this server's authorization
- `/dev server list`: List authorized servers
- `/dev status`: Set a custom bot status
- `/dev status-reset`: Go back to the rotating status

## 🛡️ Head Admin

Server rank: anti-nuke, whitelist, control panel, backups and staff ranks. Given by linking a role with `/setup staff role`, or `/setup security-admins` (owner). Discord's Administrator permission counts as Head Admin, except for actions that weaken protection.

- `/antinuke check`: Check the bot's permissions and role position
- `/antinuke disable`: Turn anti-nuke off (stays off after restarts)
- `/antinuke enable`: Turn anti-nuke enforcement on (runs a readiness check first)
- `/antinuke incidents`: Show recent anti-nuke incidents
- `/antinuke quarantine`: Strip a member's roles and save them
- `/antinuke release`: Give a quarantined member their saved roles back
- `/antinuke reset`: Restore one rule to its default threshold and state
- `/antinuke rule`: Tune one rule threshold or turn it on/off
- `/antinuke settings`: Turn the extra protection layers on or off
- `/antinuke status`: See whether anti-nuke is on, its rules and the whitelist
- `/antinuke threats clear`: Clear a member from the threat board _(Head Admin and above; clears the board entry only, cases and bans stay)_
- `/antinuke threats release`: Undo a strike (unban and clear) _(Head Admin and above; unbans if they were struck)_
- `/antinuke threats strike`: Strip, revert their damage and ban a member now _(Head Admin and above; manually strips, records and bans)_
- `/antinuke whitelist add`: Whitelist a user or role for some or all rules
- `/antinuke whitelist bots`: Let a verification bot give roles without tripping anti-nuke
- `/antinuke whitelist check`: See what anti-nuke allows someone and what would strip them
- `/antinuke whitelist list`: Show the whitelist and when entries expire
- `/antinuke whitelist remove`: Take a user or role off the whitelist
- `/mod appeals setup`: Turn ban appeals on or off
- `/mod cases delete`: Delete a case permanently
- `/mod warnings pardon`: Clear someone's active warnings
- `/mod warnings setup`: Change the warning levels
- `/recovery backup create`: Save a server backup
- `/recovery backup delete`: Delete backups (3, 3,5,7, 2-6 or all)
- `/recovery backup list`: List backups
- `/recovery backup restore`: Preview and restore a backup
- `/recovery copylayout`: Copy roles and channels to another server
- `/recovery snapshot cleanup`: Delete old snapshots by age (previews first)
- `/recovery snapshot create`: Save roles, channels and permissions
- `/recovery snapshot delete`: Delete snapshots (3, 3,5,7, 2-6 or all)
- `/recovery snapshot list`: List snapshots and backups
- `/recovery snapshot restore`: Preview and restore a snapshot
- `/roblox bind`: Give a role for a group rank
- `/roblox group`: Set the Roblox group for rank roles
- `/roblox network`: Share blacklists with partner servers
- `/roblox partner`: Add or remove a partner server
- `/roblox unbind`: Remove a group rank role
- `/role who-can-give`: Choose who can give a role _(staff roles: owner only)_
- `/setup config backups`: Schedule server layout backups
- `/setup config command`: Turn a command on or off, or change its cooldown
- `/setup config feature`: Turn moderation, verification, AI or backups on or off
- `/setup config permission-role`: Give a role a staff rank (older method)
- `/setup config provider`: Turn a verification provider on or off
- `/setup history list`: Show recent setting changes
- `/setup panel`: Create or update the staff control panel
- `/setup permissions discord`: Show roles with Administrator or Manage Roles
- `/setup permissions list`: Show roles with bot command access
- `/setup security`: Set the security log and Roblox verification options
- `/setup staff role`: Link a role to a staff rank
- `/setup status`: Show security health and settings

## 🔧 Admin

Server rank: lifting ordinary bans and accepting appeals, raid tools, automod, scam protection and logging. Given with `/setup staff role`; Discord's Administrator permission also works for unbans.

- `/antinuke scan`: Scan for risky roles, roles above the bot and admin bots
- `/antinuke threats list`: Show the threat board _(Admin and above; scores and levels are informational and never trigger automatic enforcement)_
- `/antinuke threats view`: Show everything recorded about a member _(Admin and above; shows every scored incident and staff action)_
- `/automod ai`: Turn AI moderation of text and images on or off
- `/automod ai-ignore`: Pick channels or content that AI moderation skips
- `/automod allow-server`: Allow, or stop allowing, invites to a partner server
- `/automod alts`: Alert staff when a new member's Roblox account is an alt
- `/automod antiping bypass`: Let a role ping protected staff, or stop it
- `/automod antiping disable`: Turn staff ping protection off
- `/automod antiping enable`: Turn staff ping protection on
- `/automod antiping protect`: Protect a staff role or user from pings
- `/automod antiping remove`: Stop protecting a role or user
- `/automod antiping status`: Show staff ping protection
- `/automod invites`: Delete invites to other Discord servers
- `/automod link-list`: Add or remove a website on the allow or block list
- `/automod links`: Choose how website links are handled
- `/automod quiet-hours`: Lock the server between two times every day
- `/automod scam disable`: Stop scam scanning here
- `/automod scam domain-add`: Block a domain and its subdomains
- `/automod scam domain-remove`: Unblock a domain
- `/automod scam enable`: Delete and ban on confirmed scam matches
- `/automod scam exclude`: Exclude or include a channel
- `/automod scam image-add`: Add a confirmed scam image
- `/automod scam image-remove`: Remove a scam image
- `/automod scam list`: List blocked domains, images and excluded channels
- `/automod scam status`: Show scam protection status and limits
- `/automod scam test`: Test text or an image without taking action
- `/automod scam vision`: Let OpenAI read text in images (alerts only)
- `/automod spam`: Set limits for mass pings, repeats and message bursts
- `/automod status`: Show what automod is doing here
- `/mod massban`: Ban up to 200 user IDs at once _(must also be on the anti-nuke whitelist)_
- `/mod unban`: Lift a ban (not genrebans or hardbans) _(Admins may lift ordinary bans here; ban-log buttons are server-owner/Developer only (500 ms cooldown; successful actions post who clicked in #bans); network-ban lifts and exceptions are Developer only)_
- `/raid emergency panel`: Post Emergency and All clear buttons here
- `/raid emergency start`: Lock down, pause invites, turn on raid mode, ping Admins
- `/raid emergency status`: Show whether emergency mode is on
- `/raid emergency stop`: All clear: undo emergency mode
- `/raid health`: Check protection, permissions and backups
- `/raid lockdown`: Lock every channel and post a notice
- `/raid mode off`: Turn raid mode off
- `/raid mode on`: Turn raid mode on
- `/raid mode status`: Show raid mode and how many joins it handled
- `/raid newaccounts off`: Turn the new-account rule off
- `/raid newaccounts on`: Turn the new-account rule on or change it
- `/raid newaccounts status`: Show the new-account rule
- `/raid unlock`: End the lockdown and restore every channel
- `/raid webhooks`: List webhooks and delete untrusted ones
- `/roblox bloxlink-sync`: Re-sync someone through Bloxlink
- `/setup logs bot-changes`: Skip routine bot changes in the logs
- `/setup logs category`: Choose which events are logged
- `/setup logs check`: Check the log channels and permissions
- `/setup logs disable`: Turn event logging off
- `/setup logs enable`: Turn event logging on
- `/setup logs exclude`: Stop or resume logging a channel
- `/setup logs setup`: Create the log channels and send a test
- `/setup logs status`: Show logging settings
- `/setup logs view`: Browse logged events (last 30 days)
- `/setup staff report`: Show actions per staff member
- `/setup welcome setup`: Turn welcome messages on or off
- `/setup welcome test`: Preview the welcome message
- `/ticket panel`: Post the ticket panel
- `/ticket settings`: View or change ticket settings
- `/ticket setup`: Set up the ticket desk and its panel
- `/ticket stats`: Show ticket stats and the staff leaderboard
- `/ticket types add`: Add a ticket type
- `/ticket types edit`: Edit a ticket type
- `/ticket types list`: List ticket types
- `/ticket types remove`: Remove a ticket type
- `/ticket types reset`: Reset ticket types to the defaults

## 🔨 Moderator

Server rank, or Discord's matching permission (Ban/Kick/Timeout Members, Manage Messages): bans, kicks, purges, denying appeals. Cannot lift bans.

- `/mod appeals pending`: Show appeals waiting for a decision
- `/mod ban`: Ban a user
- `/mod bans case`: Show a ban record by case ID
- `/mod bans lookup`: Show a user's ban records
- `/mod bans recent`: Show the latest ban records
- `/mod bans stats`: Show bans and unbans from the last 30 days
- `/mod cases reason`: Change a case's reason
- `/mod kick`: Kick a member
- `/mod nick reset`: Reset a member's nickname
- `/mod nick set`: Set a member's nickname
- `/mod notes remove`: Delete a note
- `/mod purge`: Delete up to 100 recent messages here
- `/mod slowmode`: Set a channel's slowmode
- `/mod softban`: Kick a member and delete their recent messages
- `/mod tempban`: Ban a user for a set time
- `/mod untimeout`: Remove a member's timeout
- `/roblox blacklist`: Blacklist a Roblox account
- `/roblox unblacklist`: Remove a Roblox account from the blacklist

## 🤝 Helper

Server rank: warnings, short timeouts, cases and notes. Given with `/setup staff role`.

- `/mod cases recent`: Show the latest cases
- `/mod cases search`: Search cases by member, staff, action, reason or date
- `/mod cases view`: Show a case
- `/mod history`: Show a member's last 10 cases
- `/mod notes add`: Add a note about a member
- `/mod notes list`: Show a member's notes
- `/mod timeout`: Time out a member _(Helpers up to 60 minutes; Moderators longer)_
- `/mod warn`: Warn a member (DMed and logged as a case)
- `/mod warnings status`: Show warning levels or someone's warnings
- `/roblox binds`: Show group rank roles
- `/roblox blacklisted`: List blacklisted Roblox accounts
- `/roblox lookup`: Look up a Roblox account
- `/roblox sync`: Re-check someone's verification now
- `/setup staff check`: Show someone's rank
- `/setup staff list`: Show every staff rank

## 👤 Everyone

Any member. Some of these check more inside the command (noted next to them).

- `/ask`: Ask the AI assistant a question
- `/help`: Browse the commands you can use
- `/info bot`: About the bot
- `/info ping`: Check the bot's latency and uptime
- `/info role`: Show a role's details
- `/info server`: Show server details and protection
- `/info user`: Show a member's details
- `/role add`: Give a member a role _(checked role by role: Manage Roles or a Moderator rank, and staff roles need `/role who-can-give`)_
- `/role remove`: Take a role from a member _(checked role by role, like `/role add`)_
- `/role restore`: Give back the roles a member had before leaving _(gives back only roles the person could give with `/role add`)_
- `/ticket add`: Add someone to this ticket _(ticket staff only)_
- `/ticket block`: Block a member from opening tickets _(ticket staff only; bots and staff cannot be blocked)_
- `/ticket blocked`: List blocked members _(ticket staff only)_
- `/ticket claim`: Claim this ticket _(ticket staff role, Manage Server or a Vanguard rank)_
- `/ticket close`: Close this ticket and save the transcript _(the member who opened the ticket, or ticket staff)_
- `/ticket closerequest`: Ask the member if the ticket can close _(ticket staff only)_
- `/ticket history`: Show a member's past tickets _(ticket staff only)_
- `/ticket priority`: Set this ticket's priority _(ticket staff only)_
- `/ticket remove`: Remove someone from this ticket _(ticket staff only)_
- `/ticket rename`: Rename this ticket _(ticket staff only)_
- `/ticket transfer`: Hand this ticket to another staff member _(ticket staff only)_
- `/ticket unblock`: Unblock a member _(ticket staff only)_
- `/ticket unclaim`: Unclaim this ticket _(the staff member who claimed it, or an admin)_
- `/verify`: Link your Roblox account
