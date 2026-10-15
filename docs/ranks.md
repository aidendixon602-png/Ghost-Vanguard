# Ranks

Generated from the bot itself (`npm run docs`). Every rank can also use everything listed under the ranks below it.

- **Bot-wide ranks** (Developer, Supreme Leader, Overseer, Bot Manager) work in every server.
- **Server ranks** (Owner, Head Admin, Admin, Moderator, Helper) work only in the server they were given in.
- **Developer is the top rank** (the bot owner and `DEVELOPER_IDS`). Restarts, installing updates, restoring data, removing servers, bot-wide ranks and lifting hardbans are Developer only, so giving someone Supreme Leader or lower cannot break the bot.
- **Unbans:** ordinary bans are lifted by Admins and server owners; genrebans by a Supreme Leader or Developer (or a one-server exception from an Overseer+); hardbans only by a Developer.
- **Anti-nuke** ignores only Developers, Supreme Leaders, the server owner and whitelisted people. Every other rank is still watched.
- Check anyone with `/setup staff check user:@them`; see all ranks with `/setup staff list`.

## 🧰 Developer

The top rank: the bot owner (`BOT_OWNER_ID`) and anyone in `DEVELOPER_IDS`. Everything, including the tools that can take the bot down or reach every server at once: restarts, installing updates, restoring database settings, removing or banning servers, giving bot-wide ranks and lifting hardbans. Ignored by anti-nuke. Set only in `.env`.

- `/dev database restore-settings`: Developer: put back lost settings from an old backup file; anything newer is kept
- `/dev restart`: Developer: restart the bot (about 10 seconds offline); settings are kept
- `/dev server ban`: Developer: ban a server from Vanguard
- `/dev server deauthorize`: Developer: remove this server's authorization and leave
- `/dev server unban`: Developer: remove a server ban
- `/network unhardban`: Developer: revoke a hardban and lift it in every authorized server
- `/setup staff global`: Developer: make someone Supreme Leader, Overseer or Bot Manager in every server

## 👑 Supreme Leader

Bot-wide, every server: everything except the Developer-only tools. Diagnostics, update status, database health and backups, genrebans and hardbans, lifting genrebans. Ignored by anti-nuke. Given with `/setup staff global` or `SUPREME_LEADER_IDS`.

- `/dev autoreact add`: React to every message from a member (🐐 by default)
- `/dev autoreact list`: Members the bot auto-reacts to in this server
- `/dev autoreact remove`: Stop auto-reacting to a member
- `/dev database backup`: Create a verified database backup now
- `/dev database backups`: List recent database backups
- `/dev database status`: Show database health, storage, backup and migration status
- `/dev database verify`: Recheck backup checksum and database integrity
- `/dev update`: Automatic GitHub updates: see the status, or install now (Developer) _(anyone with /dev sees the status; installing now needs a Developer)_
- `/network exceptions list`: Active genreban exceptions, newest first
- `/network exceptions revoke`: Cancel an exception: the genreban applies in that server again _(exceptions are granted by Overseers and higher through `/mod unban`)_
- `/network genreban`: Developer: ban a user from every authorized server until /network ungenreban
- `/network hardban`: Developer: permanently ban a user from every authorized server until /network unhardban
- `/network ungenreban`: Supreme Leader+: revoke a genreban and lift it in every authorized server

## 🔭 Overseer

Bot-wide, every server: Bot Manager plus inspecting and authorizing servers, and letting a genrebanned person back into one server. Given with `/setup staff global`.

- `/dev inspect`: Read-only overview of any server Vanguard knows
- `/dev server authorize`: Developer: authorize this server so Vanguard protects it

## 🛠️ Bot Manager

Bot-wide, every server: Head Admin everywhere plus bot status, diagnostics and announcements. Given with `/setup staff global`.

- `/dev broadcast`: Post an announcement to every authorized server's log channel
- `/dev diagnostics`: Inspect runtime health without secrets
- `/dev server info`: Developer: show this server's authorization details
- `/dev server list`: Developer: list every server Vanguard is authorized in
- `/dev status`: Show a custom bot status instead of the rotation
- `/dev status-reset`: Return to the normal rotating status

## 🏠 Server Owner

The owner of a server, in that server: everything a Head Admin can do, plus security admins and undoing setting changes. Cannot lift genrebans or hardbans. Ignored by anti-nuke.

- `/security admin`: Server owner: add, remove or list security admins
- `/setup history restore`: Server owner: undo a setting change by its number

## 🛡️ Head Admin

Server rank: anti-nuke, whitelist, control panel, backups and staff ranks. Given by linking a role with `/setup staff role`, or `/security admin` (owner). Discord's Administrator permission counts as Head Admin, except for actions that weaken protection.

- `/antinuke check`: Check Vanguard's permissions and role position
- `/antinuke disable`: Turn anti-nuke off (stays off after restarts)
- `/antinuke enable`: Turn anti-nuke on (saves a backup of the server first)
- `/antinuke settings`: Turn the extra protection layers on or off (all on by default)
- `/antinuke status`: Is anti-nuke on? Its 17 rules, their limits and the whitelist
- `/antinuke whitelist add`: Whitelist a user or role: pick what anti-nuke lets them do and for how long
- `/antinuke whitelist bots`: Let a verification bot (Bloxlink, RoVer) give verified roles without tripping anti-nuke
- `/antinuke whitelist check`: See exactly what anti-nuke lets someone do, and what would get them stripped
- `/antinuke whitelist list`: Show everyone on the whitelist, what they skip and when it expires
- `/antinuke whitelist remove`: Take a user or role off the whitelist completely
- `/mod appeals setup`: Turn appeals on or off and pick the staff channel they go to
- `/mod case delete`: Security admins: permanently delete a case record
- `/mod warnings pardon`: Wipe someone's active warnings (cases stay in their history)
- `/mod warnings setup`: Change the warning levels (0 turns a level off)
- `/recovery backup create`: Save a manual server backup
- `/recovery backup delete`: Delete backups: one (3), several (3,5,7), a range (2-6) or all
- `/recovery backup list`: List this server's backups, newest first
- `/recovery backup restore`: Preview restoring a backup, then confirm
- `/recovery copylayout`: Copy this server's roles and channels to another server Vanguard protects
- `/recovery snapshot cleanup`: Delete old snapshots/backups in bulk by age and type (previews first)
- `/recovery snapshot create`: Save roles, category/channel layout and permission overwrites
- `/recovery snapshot delete`: Delete snapshots/backups: one (3), several (3,5,7), a range (2-6) or all
- `/recovery snapshot list`: List this server's snapshots and backups, newest first
- `/recovery snapshot restore`: Preview restoring a snapshot or backup, then confirm
- `/roblox bind`: Give a Discord role for a group rank
- `/roblox group`: Set the Roblox group whose ranks give Discord roles
- `/roblox network`: Share blacklists with your partner servers (both servers must add each other)
- `/roblox partner`: Add or remove a partner server for the ban network (do it in both servers)
- `/roblox unbind`: Stop giving a role from group ranks
- `/role who-can-give`: Choose who can give a role, or see the list (leave everything empty) _(staff roles: owner only)_
- `/security config`: Set the security log channel and Roblox verification options
- `/security incidents`: View recent anti-nuke incidents
- `/security quarantine`: Contain a member and save their roles
- `/security release`: Restore a quarantined member’s saved roles
- `/security status`: Show security health and configuration
- `/setup config backups`: Configure scheduled server layout backups
- `/setup config command`: Turn one Vanguard command on/off or change its cooldown
- `/setup config feature`: Turn moderation, verification, AI or backups on/off
- `/setup config permission-role`: Give a Discord role a Vanguard staff rank (Head Admin, Admin, Moderator, Helper)
- `/setup config provider`: Enable or disable a configured verification provider
- `/setup history list`: Show recent setting changes and who made them
- `/setup panel`: Create or update the private control panel channel (buttons for staff)
- `/setup permissions discord`: Roles holding Administrator or Manage Roles, which can reorder the hierarchy
- `/setup permissions list`: Browse the roles that hold Vanguard command access
- `/setup staff role`: Link a Discord role to a server rank (Head Admin, Admin, Moderator, Helper)

## 🔧 Admin

Server rank: lifting ordinary bans and accepting appeals, raid tools, automod, scam protection and logging. Given with `/setup staff role`; Discord's Administrator permission also works for unbans.

- `/antinuke scan`: Safety scan: powerful roles, roles above Vanguard, bots with Administrator
- `/mod massban`: Raid cleanup: ban up to 200 user IDs at once (whitelisted staff only) _(must also be on the anti-nuke whitelist)_
- `/mod unban`: Admins and owners: lift a ban by user ID (genrebans and hardbans need bot-wide staff) _(ordinary bans only; a genreban needs an Overseer+ for a one-server exception, or a Supreme Leader+ to lift it everywhere; a hardban needs a Developer)_
- `/security antiping bypass`: Allow or disallow a role to mention protected staff
- `/security antiping disable`: Disable staff mention blocking
- `/security antiping enable`: Enable blocking mentions of configured staff
- `/security antiping protect`: Add a protected staff role mention or individual user
- `/security antiping remove`: Remove a protected role or user
- `/security antiping status`: Show staff mention protection and configured targets
- `/security automod ai`: AI moderation: catch harassment, hate, threats and NSFW text and images
- `/security automod ai-ignore`: Channels or kinds of content AI moderation should skip
- `/security automod allow-server`: Allow (or stop allowing) invites to a partner server
- `/security automod alts`: Alert staff when a new member's Roblox account belongs to a banned or existing member
- `/security automod invites`: Delete invite links to other Discord servers
- `/security automod link-list`: Add a website to the allowed or blocked list, or remove it
- `/security automod links`: Choose how links (websites) are handled
- `/security automod quiet-hours`: Lock the server every day between two times, then unlock it
- `/security automod spam`: Mass pings, repeated messages and message bursts
- `/security automod status`: Show what automod is doing in this server
- `/security emergency panel`: Post Emergency / All clear buttons in this channel (put it in a staff channel)
- `/security emergency start`: Lock every channel, pause invites, turn on raid mode and ping Admins
- `/security emergency status`: Is emergency mode on?
- `/security emergency stop`: All clear: undo everything emergency mode did
- `/security health`: Check protection, permissions, integrations and backups at a glance
- `/security lockdown`: Lock every channel and post a notice; /security unlock restores everything exactly
- `/security newaccounts off`: Stop handling new accounts
- `/security newaccounts on`: Turn the new-account rule on or change it
- `/security newaccounts status`: Show the new-account rule for this server
- `/security raidmode off`: End raid mode
- `/security raidmode on`: Start raid mode
- `/security raidmode status`: Show whether raid mode is on and how many joins it handled
- `/security scam disable`: Stop scam scanning in this server
- `/security scam domain-add`: Block a domain and its subdomains; matches delete and ban
- `/security scam domain-remove`: Remove a blocked domain
- `/security scam enable`: Enable deletion and bans for confirmed scam matches
- `/security scam exclude`: Exclude or include a channel and its threads
- `/security scam image-add`: Register a confirmed scam image; exact matches delete and ban
- `/security scam image-remove`: Remove a custom image reference
- `/security scam list`: List blocked domains, image references and excluded channels
- `/security scam status`: Show automatic protection, scan limits and readiness
- `/security scam test`: Check text or an image without deletion, bans or AI requests
- `/security scam vision`: Opt in to sending images to OpenAI for text scanning; alerts only
- `/security unlock`: End the lockdown and restore every channel exactly as it was
- `/security webhooks`: List every webhook in the server and delete ones you do not trust
- `/setup logs bot-changes`: Skip routine bot changes, like member-count channel renames
- `/setup logs category`: Choose which kinds of events are logged
- `/setup logs check`: Check both log channels and the bot permissions, then send a test embed
- `/setup logs disable`: Turn off event logging (stored history is kept)
- `/setup logs enable`: Turn on event logging
- `/setup logs exclude`: Stop (or start again) logging events from a channel
- `/setup logs setup`: Create or reuse #bans and #midtown-vanguard-logging, check access and send a test
- `/setup logs status`: Show event logging settings
- `/setup logs view`: Browse logged events from the last 30 days
- `/setup staff report`: Staff activity: actions per staff member
- `/setup welcome setup`: Turn welcome messages on or off
- `/setup welcome test`: Send the welcome message for yourself to check how it looks

## 🔨 Moderator

Server rank, or Discord's matching permission (Ban/Kick/Timeout Members, Manage Messages): bans, kicks, purges, denying appeals. Cannot lift bans.

- `/mod appeals pending`: Appeals waiting for a decision
- `/mod ban`: Ban a user (asks to confirm)
- `/mod bans case`: Show one ban record by case ID
- `/mod bans lookup`: A user's ban records in this server
- `/mod bans recent`: The latest ban records in this server
- `/mod bans stats`: Bans and unbans in the last 30 days
- `/mod case reason`: Change the reason recorded on a case
- `/mod kick`: Kick a member
- `/mod nick reset`: Remove a member's nickname
- `/mod nick set`: Give a member a nickname
- `/mod notes remove`: Delete a note by its number
- `/mod purge`: Delete up to 100 recent messages in this channel (asks to confirm)
- `/mod softban`: Ban then immediately unban: kicks a member and deletes their recent messages
- `/mod tempban`: Ban a user for a set time; Vanguard lifts the ban automatically
- `/mod untimeout`: Remove a timeout
- `/roblox blacklist`: Block a Roblox account from verifying here (and flag it on join)
- `/roblox unblacklist`: Remove a Roblox account from this server's blacklist
- `/security slowmode`: Set how often members can send messages in a channel

## 🤝 Helper

Server rank: warnings, short timeouts, cases and notes. Given with `/setup staff role`.

- `/mod case recent`: The latest cases in this server
- `/mod case search`: Find cases by member, staff member, action, words in the reason or date
- `/mod case view`: Show one case: who, what, why and when
- `/mod history`: Show a member's last 10 cases
- `/mod notes add`: Write a note about a member
- `/mod notes list`: Read the notes on a member
- `/mod timeout`: Time out a member for a number of minutes _(Helpers up to 60 minutes; Moderators longer)_
- `/mod warn`: Warn a member (sent by DM and recorded as a case)
- `/mod warnings status`: Show the warning levels, or how many warnings someone has
- `/roblox binds`: Show the group and its rank → role binds
- `/roblox blacklisted`: List blacklisted Roblox accounts
- `/roblox lookup`: Profile card: account age, past names, groups, linked Discord, blacklist status
- `/roblox sync`: Re-check someone's Roblox verification and group roles now
- `/setup staff check`: Show someone's Vanguard rank here
- `/setup staff list`: Show every rank in this server and bot-wide

## 👤 Everyone

Any member. Some of these check more inside the command (noted next to them).

- `/ask`: Ask the AI assistant a question (when AI is enabled)
- `/help`: Browse every command you can use, by section
- `/info bot`: About Vanguard: developer, uptime and protection statistics
- `/info ping`: Check that Vanguard is responding: latency, uptime and version
- `/info role`: Role details: members, position, key permissions and anti-nuke bypass
- `/info server`: Browse complete server details and Vanguard protection status
- `/info user`: Member details; staff also see cases, notes, bypasses and Roblox link
- `/role add`: Give a member a role _(checked role by role: Manage Roles or a Moderator rank, and staff roles need `/role who-can-give`)_
- `/role remove`: Take a role from a member _(checked role by role, like `/role add`)_
- `/role restore`: Give a member back the roles they had before they left the server _(gives back only roles the person could give with `/role add`)_
- `/verify`: Sync your linked Roblox account, role and nickname
