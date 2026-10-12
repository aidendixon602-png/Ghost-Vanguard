# Midtown Vanguard commands

Type `/` in Discord and pick Midtown Vanguard. The main commands are: `/antinuke` `/mod` `/security` `/recovery` `/setup` `/info` `/dev` `/help` `/verify` `/roblox` `/ask` `/genreban` `/ungenreban` `/hardban` `/unhardban`.

Grouped the same way as `/help`. Generated from the code by `scripts/commands-doc.ts`.

## 🛡️ Anti-nuke

_Stops raids and nukes; manage the whitelist_

| Command | What it does |
| --- | --- |
| `/antinuke enable` | Turn anti-nuke on (saves a backup of the server first) |
| `/antinuke disable` | Turn anti-nuke off (stays off after restarts) |
| `/antinuke rules` | Show the 17 anti-nuke rules and the whitelist |
| `/antinuke status` | Show whether anti-nuke is on, its rules and the whitelist |
| `/antinuke check` | Check Vanguard's permissions and role position |
| `/antinuke test` | List each rule's trigger limit (no actions taken) |
| `/antinuke audit` | Safety score: powerful roles, roles above Vanguard, bots with Administrator |
| `/antinuke extras` | Turn the extra layers on or off (all on by default) |
| `/antinuke trust manage` | Open the whitelist panel: pick who, tick what they may do, pick how long, Save |
| `/antinuke trust verification-bot` | Let a verification bot (Bloxlink, RoVer) give verified roles without tripping anti-nuke |
| `/antinuke trust list` | Show everyone on the whitelist, what they skip and when it expires |

## 🔨 Moderation

_Ban, kick, timeout, cases, notes and appeals_

| Command | What it does |
| --- | --- |
| `/mod ban` | Ban a user (asks to confirm) |
| `/mod unban` | Lift a local ban by user ID (genrebans/hardbans need a developer) |
| `/mod kick` | Kick a member |
| `/mod timeout` | Time out a member for a number of minutes |
| `/mod untimeout` | Remove a timeout |
| `/mod warn` | Warn a member (sent by DM and recorded as a case) |
| `/mod history` | Show a member's last 10 cases |
| `/mod purge` | Delete up to 100 recent messages in this channel (asks to confirm) |
| `/mod tempban` | Ban a user for a set time; Vanguard lifts the ban automatically |
| `/mod softban` | Ban then immediately unban: kicks a member and deletes their recent messages |
| `/mod massban` | Raid cleanup: ban up to 200 user IDs at once (whitelisted staff only) |
| `/mod case view` | Show one case: who, what, why and when |
| `/mod case reason` | Change the reason recorded on a case |
| `/mod case delete` | Security admins: permanently delete a case record |
| `/mod case search` | Find cases by member, staff member, action, words in the reason or date |
| `/mod case recent` | The latest cases in this server |
| `/mod warnings status` | Show the warning levels, or how many warnings someone has |
| `/mod warnings setup` | Change the warning levels (0 turns a level off) |
| `/mod warnings pardon` | Wipe someone's active warnings (cases stay in their history) |
| `/mod note add` | Write a note about a member |
| `/mod note list` | Read the notes on a member |
| `/mod note remove` | Delete a note by its number |
| `/mod appeals setup` | Turn appeals on or off and pick the staff channel they go to |
| `/mod appeals pending` | Appeals waiting for a decision |
| `/mod nick set` | Give a member a nickname |
| `/mod nick reset` | Remove a member's nickname |

## 🚨 Security

_Automod, raid mode, lockdowns and scam links_

| Command | What it does |
| --- | --- |
| `/security status` | Show security health and configuration |
| `/security config` | Set the security log channel and Roblox verification options |
| `/security admin` | Server owner: add, remove or list security admins |
| `/security incidents` | View recent anti-nuke incidents |
| `/security quarantine` | Contain a member and save their roles |
| `/security release` | Restore a quarantined member’s saved roles |
| `/security roblox-block` | Block or unblock a Roblox account ID |
| `/security emergency start` | Lock every channel, pause invites, turn on raid mode and ping Admins |
| `/security emergency stop` | All clear: undo everything emergency mode did |
| `/security emergency panel` | Post Emergency / All clear buttons in this channel (put it in a staff channel) |
| `/security emergency status` | Is emergency mode on? |
| `/security automod status` | Show what automod is doing in this server |
| `/security automod spam` | Mass pings, repeated messages and message bursts |
| `/security automod invites` | Delete invite links to other Discord servers |
| `/security automod allow-server` | Allow (or stop allowing) invites to a partner server |
| `/security automod links` | Choose how links (websites) are handled |
| `/security automod link-list` | Add a website to the allowed or blocked list, or remove it |
| `/security automod ai` | AI moderation: catch harassment, hate, threats and NSFW text and images |
| `/security automod ai-ignore` | Channels or kinds of content AI moderation should skip |
| `/security automod alts` | Alert staff when a new member's Roblox account belongs to a banned or existing member |
| `/security automod quiet-hours` | Lock the server every day between two times, then unlock it |
| `/security raidmode on` | Start raid mode |
| `/security raidmode off` | End raid mode |
| `/security raidmode status` | Show whether raid mode is on and how many joins it handled |
| `/security newaccounts status` | Show the new-account rule for this server |
| `/security newaccounts on` | Turn the new-account rule on or change it |
| `/security newaccounts off` | Stop handling new accounts |
| `/security lockdown` | Lock every channel and post a notice; /security unlock restores everything exactly |
| `/security unlock` | End the lockdown and restore every channel exactly as it was |
| `/security slowmode` | Set how often members can send messages in a channel |
| `/security scam status` | Show automatic protection, scan limits and readiness |
| `/security scam test` | Check text or an image without deletion, bans or AI requests |
| `/security scam enable` | Enable deletion and bans for confirmed scam matches |
| `/security scam disable` | Stop scam scanning in this server |
| `/security scam domain-add` | Block a domain and its subdomains; matches delete and ban |
| `/security scam domain-remove` | Remove a blocked domain |
| `/security scam image-add` | Register a confirmed scam image; exact matches delete and ban |
| `/security scam image-remove` | Remove a custom image reference |
| `/security scam list` | List blocked domains, image references and excluded channels |
| `/security scam exclude` | Exclude or include a channel and its threads |
| `/security scam vision` | Opt in to sending images to OpenAI for text scanning; alerts only |
| `/security antiping status` | Show staff mention protection and configured targets |
| `/security antiping enable` | Enable blocking mentions of configured staff |
| `/security antiping disable` | Disable staff mention blocking |
| `/security antiping protect` | Add a protected staff role mention or individual user |
| `/security antiping remove` | Remove a protected role or user |
| `/security antiping bypass` | Allow or disallow a role to mention protected staff |
| `/security mention status` | Show staff mention protection and configured targets |
| `/security mention enable` | Enable blocking mentions of configured staff |
| `/security mention disable` | Disable staff mention blocking |
| `/security mention protect` | Add a protected staff role mention or individual user |
| `/security mention remove` | Remove a protected role or user |
| `/security mention bypass` | Allow or disallow a role to mention protected staff |
| `/security webhooks` | List every webhook in the server and delete ones you do not trust |
| `/security health` | Check protection, permissions, integrations and backups at a glance |

## ⚙️ Server Setup

_Staff ranks, welcome, logs and permissions_

| Command | What it does |
| --- | --- |
| `/setup staff role` | Link a Discord role to a server rank (Head Admin, Admin, Moderator, Helper) |
| `/setup staff global` | Supreme Leader: make someone Supreme Leader, Overseer or Bot Manager in every server |
| `/setup staff report` | Staff activity: actions per staff member |
| `/setup staff list` | Show every rank in this server and bot-wide |
| `/setup staff check` | Show someone's Vanguard rank here |
| `/setup welcome setup` | Turn welcome messages on or off |
| `/setup welcome test` | Send the welcome message for yourself to check how it looks |
| `/setup logs status` | Show event logging settings |
| `/setup logs enable` | Turn on event logging |
| `/setup logs disable` | Turn off event logging (stored history is kept) |
| `/setup logs category` | Choose which kinds of events are logged |
| `/setup logs view` | Browse logged events from the last 30 days |
| `/setup config provider` | Enable or disable a configured verification provider |
| `/setup config permission-role` | Give a Discord role a Vanguard staff rank (Head Admin, Admin, Moderator, Helper) |
| `/setup config command` | Turn one Vanguard command on/off or change its cooldown |
| `/setup config feature` | Turn moderation, verification, AI or backups on/off |
| `/setup config backups` | Configure scheduled server layout backups |
| `/setup perm list` | Browse the roles that hold Vanguard command access |
| `/setup perm discord` | Roles holding Administrator or Manage Roles, which can reorder the hierarchy |
| `/setup history list` | Show recent setting changes and who made them |
| `/setup history restore` | Server owner: undo a setting change by its number |

## 💾 Backups

_Save and restore the server layout_

| Command | What it does |
| --- | --- |
| `/recovery snapshot create` | Save roles, category/channel layout and permission overwrites |
| `/recovery snapshot list` | List this server's snapshots and backups, newest first |
| `/recovery snapshot restore` | Preview restoring a snapshot or backup, then confirm |
| `/recovery snapshot delete` | Delete snapshots/backups: one (3), several (3,5,7), a range (2-6) or all |
| `/recovery snapshot cleanup` | Delete old snapshots/backups in bulk by age and type (previews first) |
| `/recovery backup create` | Save a manual server backup |
| `/recovery backup list` | List this server's backups, newest first |
| `/recovery backup restore` | Preview restoring a backup, then confirm |
| `/recovery backup delete` | Delete backups: one (3), several (3,5,7), a range (2-6) or all |
| `/recovery copylayout` | Copy this server's roles and channels to another server Vanguard protects |

## 🎮 Roblox

_Verification, lookups, blacklist and group ranks_

| Command | What it does |
| --- | --- |
| `/verify` | Sync your linked Roblox account, role and nickname |
| `/roblox lookup` | Profile card: account age, past names, groups, linked Discord, blacklist status |
| `/roblox blacklist` | Block a Roblox account from verifying here (and flag it on join) |
| `/roblox unblacklist` | Remove a Roblox account from this server's blacklist |
| `/roblox blacklisted` | List blacklisted Roblox accounts |
| `/roblox network` | Share blacklists with your partner servers (both servers must add each other) |
| `/roblox partner` | Add or remove a partner server for the ban network (do it in both servers) |
| `/roblox group` | Set the Roblox group whose ranks give Discord roles |
| `/roblox bind` | Give a Discord role for a group rank |
| `/roblox unbind` | Stop giving a role from group ranks |
| `/roblox binds` | Show the group and its rank → role binds |
| `/roblox sync` | Re-check someone's Roblox verification and group roles now |

## ℹ️ Information

_Look up users, roles, the server and the bot_

| Command | What it does |
| --- | --- |
| `/help` | Browse every command you can use, by section |
| `/info user` | Member details; staff also see cases, notes, bypasses and Roblox link |
| `/info role` | Role details: members, position, key permissions and anti-nuke bypass |
| `/info server` | Browse complete server details and Vanguard protection status |
| `/info bot` | About Vanguard: developer, uptime and protection statistics |
| `/info ping` | Check that Vanguard is responding: latency, uptime and version |
| `/ask` | Ask the AI assistant a question (when AI is enabled) |

## 🧰 Developer

_Bot developers only_

| Command | What it does |
| --- | --- |
| `/dev diagnostics` | Inspect runtime health without secrets |
| `/dev inspect` | Read-only overview of any server Vanguard knows |
| `/dev broadcast` | Post an announcement to every authorized server's log channel |
| `/dev status` | Show a custom bot status instead of the rotation |
| `/dev status-reset` | Return to the normal rotating status |
| `/dev database status` | Show database health, storage, backup and migration status |
| `/dev database backup` | Create a verified database backup now |
| `/dev database backups` | List recent database backups |
| `/dev database verify` | Recheck backup checksum and database integrity |
| `/dev authserver` | Developer: authorize this server so Vanguard protects it |
| `/dev serverauth` | Developer: show this server's authorization details |
| `/dev servers` | Developer: list every server Vanguard is authorized in |
| `/dev deauthserver` | Developer: remove this server's authorization and leave |
| `/dev banserver` | Developer: ban a server from Vanguard |
| `/dev unbanserver` | Developer: remove a server ban |
| `/genreban` | Developer: ban a user from every authorized server until /ungenreban |
| `/ungenreban` | Developer: revoke a genreban and lift it in every authorized server |
| `/hardban` | Developer: permanently ban a user from every authorized server until /unhardban |
| `/unhardban` | Developer: revoke a hardban and lift it in every authorized server |


## /role (2.25)

| Command | What it does | Who |
|---|---|---|
| `/role add` | Give a member a role | Developers, owner, Administrator / Manage Roles (ordinary roles below them), moderators (allow-listed roles) |
| `/role remove` | Take a role from a member | Same as above |
| `/role allow` | Let configured moderators give and take a role | Owner, Head Admin |
| `/role policy` | Approve who may grant a protected (admin/moderation) role | Owner only |
| `/role rules` | Show the allow list and approved rules | Moderator+, Manage Roles |

Protected roles: any role with Administrator, Ban, Kick, Timeout, Manage Roles, Manage Channels, Manage Server or Manage Webhooks, plus Vanguard staff roles and the quarantine role.

## Logging (2.24)

| Command | What it does |
|---|---|
| `/setup logs setup` | Create or reuse `#bans` and `#midtown-vanguard-logging`, check permissions, send a test embed |
| `/setup logs check` | Re-run the permission check and test |
| `/setup logs exclude` | Stop or resume logging a channel |
| `/setup logs bot-changes` | Skip or log routine bot changes (member counters) |

## Developer extras (2.23)

| Command | What it does |
|---|---|
| `/dev autoreact add / remove / list` | React (🐐 by default) to every message from chosen members, per server |
