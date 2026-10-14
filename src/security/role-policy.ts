import { PermissionFlagsBits, type Guild, type GuildMember, type Role } from 'discord.js';
import type { Store } from '../database/db.js';
import { developers } from '../bot/developers.js';
import { explicitRank, hasAdministrator, RANKS } from '../bot/ranks.js';

/**
 * Who may give or take which role with /role.
 *
 *  - Developers (DEVELOPER_IDS): any eligible role, any member, in any server.
 *  - The server owner: any eligible role in their own server, including privileged roles.
 *  - Administrator or Manage Roles: roles below their own highest role, on members below them.
 *  - Configured Vanguard moderators (staff role, moderator rank): only roles allowed with /role who-can-give.
 *
 * Privileged roles (admin or moderation powers, Vanguard staff roles, the quarantine role) need a
 * saved owner-approved rule (/role who-can-give ... who:) for anyone other than the owner or a developer, for
 * both adding and removing. Nobody but the owner or a developer can give themselves a role.
 * Vanguard can never manage @everyone, bot/integration roles, or roles at or above its own.
 */
export const PRIVILEGED_PERMISSIONS: [bigint, string][] = [
    [PermissionFlagsBits.Administrator, 'Administrator'], [PermissionFlagsBits.BanMembers, 'Ban Members'],
    [PermissionFlagsBits.KickMembers, 'Kick Members'], [PermissionFlagsBits.ModerateMembers, 'Timeout Members'],
    [PermissionFlagsBits.ManageRoles, 'Manage Roles'], [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
    [PermissionFlagsBits.ManageGuild, 'Manage Server'], [PermissionFlagsBits.ManageWebhooks, 'Manage Webhooks'],
];

/** Why a role is privileged, or null when it is an ordinary role. */
export function privilegedReason(store: Store, guildId: string, role: Pick<Role, 'id' | 'permissions'>): string | null {
    const perms = PRIVILEGED_PERMISSIONS.filter(([bit]) => role.permissions.has(bit, false)).map(([, name]) => name);
    if (perms.length) return `it has ${perms.join(', ')}`;
    if (store.get('SELECT 1 FROM staff_roles WHERE guild_id=? AND role_id=?', guildId, role.id)) return 'it is a Vanguard staff role';
    if (store.get('SELECT 1 FROM permission_roles WHERE guild_id=? AND role_id=?', guildId, role.id)) return 'it gives Vanguard command access';
    if (store.settings(guildId).quarantineRoleId === role.id) return 'it is the quarantine role';
    return null;
}

export const isAllowlisted = (store: Store, guildId: string, roleId: string) =>
    !!store.get("SELECT 1 FROM role_rules WHERE guild_id=? AND role_id=? AND kind='allow'", guildId, roleId);

/** An owner-approved rule lets this person (or one of their roles) manage this privileged role. */
export function hasGrantRule(store: Store, guildId: string, roleId: string, actor: GuildMember): boolean {
    const roles = [...(actor.roles?.cache?.keys() ?? [])];
    return !!store.get("SELECT 1 FROM role_rules WHERE guild_id=? AND role_id=? AND kind='grant' AND grantor_type='user' AND grantor_id=?", guildId, roleId, actor.id)
        || roles.some(r => store.get("SELECT 1 FROM role_rules WHERE guild_id=? AND role_id=? AND kind='grant' AND grantor_type='role' AND grantor_id=?", guildId, roleId, r));
}

export type Decision = { ok: true; noop?: string; as: 'developer' | 'owner' | 'manager' | 'moderator' } | { ok: false; reason: string; kind: 'role' | 'hierarchy' | 'permission' | 'member' };

export interface RoleChange {
    store: Store; guild: Pick<Guild, 'id' | 'ownerId'>; actor: GuildMember; target: GuildMember | null; role: Role; me: GuildMember; op: 'add' | 'remove';
}

export function decideRoleChange({ store, guild, actor, target, role, me, op }: RoleChange): Decision {
    if (role.id === guild.id) return { ok: false, kind: 'role', reason: '@everyone cannot be given or taken.' };
    if (role.managed) return { ok: false, kind: 'role', reason: `<@&${role.id}> belongs to a bot or integration, so only Discord can assign it.` };
    if (me.roles.highest.comparePositionTo(role) <= 0) return { ok: false, kind: 'hierarchy', reason: `<@&${role.id}> is at or above Midtown Vanguard's highest role. Move Vanguard's role above it first.` };
    if (!target) return { ok: false, kind: 'member', reason: 'That user is not in this server (or Discord could not find them).' };
    const noop = op === 'add' && target.roles.cache.has(role.id) ? `<@${target.id}> already has <@&${role.id}>. Nothing was changed.`
        : op === 'remove' && !target.roles.cache.has(role.id) ? `<@${target.id}> does not have <@&${role.id}>. Nothing was changed.` : undefined;
    if (developers.has(actor.id)) return { ok: true, as: 'developer', noop };
    if (actor.id === guild.ownerId) return { ok: true, as: 'owner', noop };

    const manager = hasAdministrator(actor) || !!actor.permissions?.has?.(PermissionFlagsBits.ManageRoles);
    const moderator = explicitRank(store, guild.id, actor.id, actor) >= RANKS.moderator;
    if (!manager && !moderator)
        return { ok: false, kind: 'permission', reason: 'You need Manage Roles, Administrator, or a Vanguard moderator rank to use /role.' };
    if (!manager && !isAllowlisted(store, guild.id, role.id))
        return { ok: false, kind: 'permission', reason: `Moderators can only manage roles on this server's allow list, and <@&${role.id}> is not on it. A Head Admin or the owner can allow it with \`/role who-can-give\`.` };
    if (actor.roles.highest.comparePositionTo(role) <= 0)
        return { ok: false, kind: 'hierarchy', reason: `<@&${role.id}> is equal to or above your highest role.` };
    if (target.id === guild.ownerId)
        return { ok: false, kind: 'hierarchy', reason: "Only the server owner or a developer can change the server owner's roles." };
    if (target.id === actor.id && op === 'add')
        return { ok: false, kind: 'permission', reason: 'You cannot give yourself roles with /role. Ask the server owner or another staff member.' };
    if (target.id !== actor.id && actor.roles.highest.comparePositionTo(target.roles.highest) <= 0)
        return { ok: false, kind: 'hierarchy', reason: `<@${target.id}>'s highest role is equal to or above yours.` };
    const privileged = privilegedReason(store, guild.id, role);
    if (privileged && !hasGrantRule(store, guild.id, role.id, actor))
        return { ok: false, kind: 'permission', reason: `<@&${role.id}> is a protected role (${privileged}). Only the server owner can ${op === 'add' ? 'give' : 'remove'} it, unless they let you with \`/role who-can-give\`.` };
    return { ok: true, as: manager ? 'manager' : 'moderator', noop };
}
