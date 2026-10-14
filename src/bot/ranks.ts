import { PermissionFlagsBits, type GuildMember } from 'discord.js';
import type { Store } from '../database/db.js';
import { config } from '../config.js';
import { developers } from './developers.js';

/**
 * Vanguard staff ranks. Each rank can do everything the ranks below it can.
 * Bot-wide (by user ID): Supreme Leader (BOT_OWNER_ID), Bot Developer (DEVELOPER_IDS), Overseer, botmanager.
 * Per server (by Discord role, /setup staff role): headadmin, admin, moderator, helper.
 * The server owner ranks just above headadmin in their own server.
 */
export const RANKS = { helper: 1, moderator: 2, admin: 3, headadmin: 4, owner: 4.5, botmanager: 5, overseer: 6, developer: 7, supreme: 8 } as const;
export type RankName = keyof typeof RANKS;
export const RANK_LABEL: Record<RankName, string> = {
    helper: 'Helper', moderator: 'Moderator', admin: 'Admin', headadmin: 'Head Admin', owner: 'Server Owner',
    botmanager: 'Bot Manager', overseer: 'Overseer', developer: 'Bot Developer', supreme: 'Supreme Leader',
};
export const SERVER_LEVELS = ['helper', 'moderator', 'admin', 'headadmin'] as const;
export const GLOBAL_LEVELS = ['botmanager', 'overseer'] as const;

/** BOT_OWNER_ID plus SUPREME_LEADER_IDS. */
export const supremeLeaders = () => [...new Set([config.ownerId, ...config.supremeExtra].filter(Boolean))];
export const isSupreme = (id: string) => supremeLeaders().includes(id);

export function rankName(value: number): RankName | null {
    return (Object.entries(RANKS).filter(([, v]) => v <= value).sort((a, b) => b[1] - a[1])[0]?.[0] as RankName) ?? null;
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
export const ADMIN_RESTRICTED = new Set<string>([
    // Switching protection off, weakening it, or exempting people from it
    'antinuke/disable', 'disable', 'antinuke-plus/settings', 'trust/add', 'trust/remove', 'trust/bots', 'tp', 'trustlist',
    'security/release', 'emergency/start', 'emergency/stop', 'emergency/panel', 'emergency', 'botq',
    // Destructive restoration and deleting recovery points
    'backup/restore', 'snapshot/restore', 'config-history/restore', 'restore', 'layoutselect', 'incident',
    'backup/delete', 'snapshot/delete', 'snapshot/cleanup', 'snapshotdelete', 'case/delete',
    // Granting permissions or ranks
    'security/admin', 'staff/role', 'guild-config/permission-role', 'perm', 'role/who-can-give', 'panel', 'vgpanel',
    // Beyond this server
    'copylayout', 'staff/global', 'roblox/network', 'roblox/partner',
]);
export const isAdminRestricted = (key?: string) => !!key && ADMIN_RESTRICTED.has(key.replace(/\/$/, ''));

/** True when this member holds Discord's Administrator permission (checked live, never by role name). */
export const hasAdministrator = (member?: GuildMember | null) => {
    try { return !!member?.permissions?.has?.(PermissionFlagsBits.Administrator); } catch { return false; }
};

/**
 * The highest rank this person holds here. 0 means no Vanguard rank.
 * Pass the command key ("backup/restore") so Discord Administrator is not counted for
 * restricted actions; without a key it is counted.
 */
export function rankOf(store: Store, guildId: string | null, userId: string, member?: GuildMember | null, key?: string): number {
    const explicit = explicitRank(store, guildId, userId, member);
    return guildId && hasAdministrator(member) && !isAdminRestricted(key) ? Math.max(explicit, ADMINISTRATOR_RANK) : explicit;
}

/** Rank from Vanguard itself only: developers, Supreme Leaders, owner, grants and staff roles. */
export function explicitRank(store: Store, guildId: string | null, userId: string, member?: GuildMember | null): number {
    if (isSupreme(userId)) return RANKS.supreme;
    if ((store.db.prepare('SELECT level FROM bot_staff WHERE user_id=?').get(userId) as { level?: string } | undefined)?.level === 'supreme') return RANKS.supreme;
    if (developers.has(userId)) return RANKS.developer;
    let rank = 0;
    const global = store.db.prepare('SELECT level FROM bot_staff WHERE user_id=?').get(userId) as { level?: string } | undefined;
    if (global?.level && global.level in RANKS) rank = RANKS[global.level as RankName];
    if (!guildId) return rank;
    if (member && member.id === member.guild?.ownerId) rank = Math.max(rank, RANKS.owner);
    // Older access settings still count: security admins = Head Admin, Vanguard moderator roles = Moderator.
    if (store.hasGrant(guildId, userId, 'admin')) rank = Math.max(rank, RANKS.headadmin);
    const roles = [...(member?.roles?.cache?.keys() ?? [])];
    if (roles.length) {
        const marks = roles.map(() => '?').join(',');
        for (const row of store.db.prepare(`SELECT level FROM staff_roles WHERE guild_id=? AND role_id IN (${marks})`).all(guildId, ...roles) as { level: string }[])
            if (row.level in RANKS) rank = Math.max(rank, RANKS[row.level as RankName]);
        for (const row of store.db.prepare(`SELECT access FROM permission_roles WHERE guild_id=? AND role_id IN (${marks})`).all(guildId, ...roles) as { access: string }[])
            rank = Math.max(rank, row.access === 'admin' ? RANKS.headadmin : row.access === 'moderator' ? RANKS.moderator : 0);
    }
    return rank;
}

/** Minimum rank per command, subcommand ("command/sub") or button prefix. Missing = ranks don't apply. */
export const COMMAND_RANK: Record<string, number> = {
    // Helper
    'moderation/warn': 1, 'antinuke-plus': 4, 'antinuke-plus/scan': 3, botq: 4, 'warnings/status': 1, warnings: 4, emergency: 3, webhooks: 3, webhook: 3, aimod: 1, roblox: 4, 'roblox/lookup': 1, 'roblox/sync': 1, 'roblox/blacklist': 2, 'roblox/unblacklist': 2, 'roblox/blacklisted': 1, 'roblox/binds': 1, 'case/search': 1, 'appeals/pending': 2, appeal: 2, 'staff/report': 3, automod: 3, welcome: 3, appeals: 4, 'moderation/timeout': 1, 'moderation/history': 1, 'note/add': 1, 'note/list': 1, 'case/view': 1, 'case/recent': 1,
    // Moderator
    moderation: 2, bans: 2, tempban: 2, softban: 2, 'role/who-can-give': 4, nick: 2, slowmode: 2, 'case/reason': 2, 'note/remove': 2, newacct: 2,
    // Admin
    raidmode: 3, vgwelcome: 3, vgcommands: 0, lockdown: 3, unlock: 3, massban: 3, newaccounts: 3, scam: 3, logs: 3, antiping: 3, mention: 3, health: 3,
    // Head Admin
    antinuke: 4, panel: 4, vgpanel: 4, enable: 4, disable: 4, trust: 4, snapshot: 4, backup: 4, copylayout: 4, security: 4, 'guild-config': 4,
    'config-history': 4, perm: 4, 'case/delete': 4, staff: 4, anpanel: 4, trustlist: 4, tp: 4, snapshotdelete: 4, snapshotcancel: 4, snapshotpage: 4,
    restore: 4, layoutselect: 4, layoutcancel: 4, incident: 4, permui: 4,
    // Bot Manager
    authorizedservers: 5, serverauth: 5, 'dev/diagnostics': 5, 'dev/status': 5, 'dev/status-reset': 5, 'dev/broadcast': 5, 'staff/list': 1, 'staff/check': 1,
    // Overseer
    'dev/inspect': 6, authserver: 6, 'dev/update': 7, 'dev/restart': 7,
    // Bot Developer
    dev: 7, database: 7, autoreact: 7, deauthserver: 7, banserver: 7, unbanserver: 7,
    // Bans across every authorized server: Bot Developers and Supreme Leaders only.
    genreban: 7, ungenreban: 7, hardban: 7, unhardban: 7,
    // Bot-wide staff ranks reach every server: Bot Developers and Supreme Leaders.
    'staff/global': 7,
};

/** "moderation/timeout" → its own entry, else "moderation". */
export function requiredRank(key: string | undefined): number | undefined {
    if (!key) return undefined;
    const clean = key.replace(/\/$/, '');
    return COMMAND_RANK[clean] ?? COMMAND_RANK[clean.split('/')[0]!];
}
