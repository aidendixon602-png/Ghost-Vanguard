import { PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';
import { developers } from './developers.js';
/**
 * Vanguard staff ranks. Each rank can do everything the ranks below it can.
 * Developer (BOT_OWNER_ID + DEVELOPER_IDS) is the top rank: full control, including the destructive bot tools.
 * Server Owner: whoever owns a Discord server, in that server only. Above Supreme Leader there, but never any bot-wide tool.
 * Bot-wide (by user ID): Supreme Leader, Overseer, Bot Manager. Per server (by role): Head Admin, Admin, Moderator, Helper.
 * Per server (by Discord role, /setup staff role): headadmin, admin, moderator, helper.
 * The server owner ranks just above headadmin in their own server.
 */
export const RANKS = { helper: 1, moderator: 2, admin: 3, headadmin: 4, botmanager: 5, overseer: 6, supreme: 7, owner: 7.5, developer: 8 };
export const RANK_LABEL = {
    helper: 'Helper', moderator: 'Moderator', admin: 'Admin', headadmin: 'Head Admin', owner: 'Server Owner',
    botmanager: 'Bot Manager', overseer: 'Overseer', supreme: 'Supreme Leader', developer: 'Developer',
};
export const SERVER_LEVELS = ['helper', 'moderator', 'admin', 'headadmin'];
export const GLOBAL_LEVELS = ['botmanager', 'overseer', 'supreme'];
/** BOT_OWNER_ID plus SUPREME_LEADER_IDS. */
export const supremeLeaders = () => [...new Set([config.ownerId, ...config.supremeExtra].filter(Boolean))];
export const isSupreme = (id) => supremeLeaders().includes(id);
export function rankName(value) {
    return Object.entries(RANKS).filter(([, v]) => v <= value).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
/**
 * Discord Administrators count as Head Admin in their own server for everyday management:
 * moderation, cases, server configuration, logging, anti-nuke settings and status, creating
 * and viewing backups, and diagnostics. No Vanguard staff role is needed for that.
 *
 * Administrator alone never unlocks the actions below. They need the server owner, an
 * explicit Vanguard staff rank (or security-admin grant), or a developer:
 *  - anything that switches off or weakens protection, or exempts someone from it;
 *  - restoring or deleting backups and snapshots, and copying layouts between servers;
 *  - granting permissions or staff ranks;
 *  - anything that reaches beyond this server.
 * Developer-only commands are never unlocked by any server permission.
 */
export const ADMINISTRATOR_RANK = RANKS.headadmin;
export const ADMIN_RESTRICTED = new Set([
    // Switching protection off, weakening it, or exempting people from it
    'antinuke/disable', 'disable', 'antinuke-plus/settings', 'trust/add', 'trust/remove', 'trust/bots', 'tp', 'trustlist',
    'security/release', 'emergency/start', 'emergency/stop', 'emergency/panel', 'emergency', 'botq',
    // Acting on the threat board (contain, strike, release, clear) can ban people, so Discord's
    // Administrator permission alone is not enough; the board itself stays readable for Admins.
    'threats/strike', 'threats/release', 'threats/clear',
    // Destructive restoration and deleting recovery points
    'backup/restore', 'snapshot/restore', 'config-history/restore', 'restore', 'layoutselect', 'incident',
    'backup/delete', 'snapshot/delete', 'snapshot/cleanup', 'snapshotdelete', 'case/delete',
    // Granting permissions or ranks
    'security/admin', 'staff/role', 'guild-config/permission-role', 'perm', 'role/who-can-give', 'panel', 'vgpanel',
    // Beyond this server
    'copylayout', 'staff/global', 'roblox/sharing', 'roblox/partner',
]);
export const isAdminRestricted = (key) => !!key && ADMIN_RESTRICTED.has(key.replace(/\/$/, ''));
/** True when this member holds Discord's Administrator permission (checked live, never by role name). */
export const hasAdministrator = (member) => {
    try {
        return !!member?.permissions?.has?.(PermissionFlagsBits.Administrator);
    }
    catch {
        return false;
    }
};
/**
 * The highest rank this person holds here. 0 means no Vanguard rank.
 * Pass the command key ("backup/restore") so Discord Administrator is not counted for
 * restricted actions; without a key it is counted.
 */
export function rankOf(store, guildId, userId, member, key) {
    // Bot-wide tools only ever look at bot ranks: owning a server or a server role never unlocks them.
    if (isBotWide(key))
        return botRank(store, userId);
    const explicit = explicitRank(store, guildId, userId, member);
    return guildId && hasAdministrator(member) && !isAdminRestricted(key) ? Math.max(explicit, ADMINISTRATOR_RANK) : explicit;
}
/** Bot-wide rank only: Developer, Supreme Leader, Overseer, Bot Manager. Server ownership and server roles never count. */
export function botRank(store, userId) {
    // Developers (the bot owner and DEVELOPER_IDS) are the top rank.
    if (developers.has(userId))
        return RANKS.developer;
    let rank = isSupreme(userId) ? RANKS.supreme : 0;
    // Bot-wide ranks given with /setup staff global.
    const global = store.db.prepare('SELECT level FROM bot_staff WHERE user_id=?').get(userId);
    if (global?.level && GLOBAL_LEVELS.includes(global.level))
        rank = Math.max(rank, RANKS[global.level]);
    return rank;
}
/**
 * Commands that act on the bot itself or on every server at once. Only bot ranks unlock them, so a Server
 * Owner (above Supreme Leader in their own server) still cannot restart the bot, network-ban or touch the database.
 */
const BOT_WIDE = new Set(['dev', 'restart', 'database', 'autoreact', 'authserver', 'deauthserver', 'serverauth', 'authorizedservers', 'banserver', 'unbanserver',
    'genreban', 'ungenreban', 'hardban', 'unhardban', 'netexception', 'staff/global']);
export const isBotWide = (key) => !!key && (BOT_WIDE.has(key.replace(/\/$/, '')) || BOT_WIDE.has(key.split('/')[0]));
/** Rank from Vanguard itself: bot ranks, the server owner, grants and staff roles (no Discord permissions). */
export function explicitRank(store, guildId, userId, member) {
    let rank = botRank(store, userId);
    if (rank >= RANKS.developer || !guildId)
        return rank;
    // Server Owner: whoever owns this Discord server, in this server only (above Supreme Leader here).
    // Both ids must be present: a member object without them must never count as the owner.
    if (member?.guild && member.id && member.id === member.guild.ownerId)
        rank = Math.max(rank, RANKS.owner);
    // Older access settings still count: security admins = Head Admin, Vanguard moderator roles = Moderator.
    if (store.hasGrant(guildId, userId, 'admin'))
        rank = Math.max(rank, RANKS.headadmin);
    const roles = [...(member?.roles?.cache?.keys() ?? [])];
    if (roles.length) {
        const marks = roles.map(() => '?').join(',');
        for (const row of store.db.prepare(`SELECT level FROM staff_roles WHERE guild_id=? AND role_id IN (${marks})`).all(guildId, ...roles))
            if (row.level in RANKS)
                rank = Math.max(rank, RANKS[row.level]);
        for (const row of store.db.prepare(`SELECT access FROM permission_roles WHERE guild_id=? AND role_id IN (${marks})`).all(guildId, ...roles))
            rank = Math.max(rank, row.access === 'admin' ? RANKS.headadmin : row.access === 'moderator' ? RANKS.moderator : 0);
    }
    return rank;
}
/** Minimum rank per command, subcommand ("command/sub") or button prefix. Missing = ranks don't apply. */
export const COMMAND_RANK = {
    // Helper
    'moderation/warn': 1, 'antinuke-plus': 4, 'antinuke-plus/scan': 3, botq: 4, 'warnings/status': 1, warnings: 4, emergency: 3, webhooks: 3, webhook: 3, aimod: 1, roblox: 4, 'roblox/lookup': 1, 'roblox/sync': 1, 'roblox/bloxlink-sync': 3, 'roblox/blacklist': 2, 'roblox/unblacklist': 2, 'roblox/blacklisted': 1, 'roblox/binds': 1, 'case/search': 1, 'appeals/pending': 2, appeal: 2, 'staff/report': 3, automod: 3, welcome: 3, appeals: 4, 'moderation/timeout': 1, 'moderation/history': 1, 'note/add': 1, 'note/list': 1, 'case/view': 1, 'case/recent': 1,
    // Moderator. Lifting a ban is Admin: Moderators can ban, but only Admins and owners undo bans.
    'moderation/unban': 3,
    moderation: 2, bans: 2, tempban: 2, softban: 2, 'role/who-can-give': 4, nick: 2, slowmode: 2, 'case/reason': 2, 'note/remove': 2, newacct: 2,
    // Admin. The ticket desk is set up and configured by Admins; answering tickets only needs the
    // ticket staff role, which /ticket checks inside the command.
    'ticket-setup': 3, 'ticket-panel': 3, 'ticket-type': 3, 'ticket-settings': 3, 'ticket-stats': 3,
    // Reading the threat board is for Admins (it names suspects and staff action history); acting on it is Head Admin.
    'threats': 3, 'threats/list': 3, 'threats/view': 3,
    'threats/strike': 4, 'threats/release': 4, 'threats/clear': 4,
    raidmode: 3, vgwelcome: 3, vgcommands: 0, lockdown: 3, unlock: 3, massban: 3, newaccounts: 3, scam: 3, logs: 3, antiping: 3, mention: 3, health: 3,
    // Head Admin
    // Owner-level actions that also sit under Head Admin commands: handing out security admins, undoing setting changes.
    'security/admin': 7.5, 'config-history/restore': 7.5,
    antinuke: 4, panel: 4, vgpanel: 4, enable: 4, disable: 4, trust: 4, snapshot: 4, backup: 4, copylayout: 4, security: 4, 'guild-config': 4,
    'config-history': 4, perm: 4, 'case/delete': 4, staff: 4, anpanel: 4, trustlist: 4, tp: 4, snapshotdelete: 4, snapshotcancel: 4, snapshotpage: 4,
    restore: 4, layoutselect: 4, layoutcancel: 4, incident: 4, permui: 4,
    // Bot Manager
    authorizedservers: 5, serverauth: 5, 'dev/diagnostics': 5, 'dev/status': 5, 'dev/status-reset': 5, 'dev/broadcast': 5, 'staff/list': 1, 'staff/check': 1,
    // Overseer
    'dev/inspect': 6, authserver: 6,
    // Bot developer tools: available as /dev slash commands.
    dev: 7, 'dev/update': 7, database: 7, autoreact: 7,
    // Every network-ban action is Developer-only: issue, revoke, exceptions and ban-log lifts.
    genreban: 8, ungenreban: 8, hardban: 8, netexception: 8,
    // Developer only (the bot owner and DEVELOPER_IDS): anything that can take the bot down, rewrite its data or
    // reach every server at once. No Discord permission, server role or lower rank unlocks these.
    restart: 8, 'dev/restart': 8, 'dev/alerts': 8, 'database/restore-settings': 8, deauthserver: 8, banserver: 8, unbanserver: 8, unhardban: 8,
    // Giving bot-wide ranks: Developers only.
    'staff/global': 8,
    'logs/cleanup-archive': RANKS.owner,
};
/** Developer-only commands: nothing but the Developer rank unlocks them. */
export const needsDeveloper = (key) => (requiredRank(key) ?? 0) >= RANKS.developer;
export const DEVELOPER_ONLY_MESSAGE = 'Only a **Developer** (the bot owner, or someone in `DEVELOPER_IDS`) can do this. It affects the bot in every server (restarts, updates, the database, removing servers, bot-wide ranks and network bans).';
export const aboveSupremeMessage = (_key) => DEVELOPER_ONLY_MESSAGE;
/** Only Developers may lift either kind of network ban everywhere. */
export function canLiftNetworkBan(_store, userId, _kind) {
    return developers.has(userId);
}
/** "moderation/timeout" → its own entry, else "moderation". */
export function requiredRank(key) {
    if (!key)
        return undefined;
    const clean = key.replace(/\/$/, '');
    return COMMAND_RANK[clean] ?? COMMAND_RANK[clean.split('/')[0]];
}
