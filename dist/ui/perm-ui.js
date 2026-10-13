import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, PermissionFlagsBits } from 'discord.js';
import { AppError } from '../errors.js';
import { defaults } from '../bot/registry.js';
import { embed } from './ui.js';
const PER_PAGE = 10;
const ACCESS_LABEL = { admin: 'Security admin (old setting = Head Admin)', moderator: 'Moderation only (old setting = Moderator)' };
const RANK_ORDER = { headadmin: 0, admin: 1, moderator: 2, helper: 3 };
const RANK_TEXT = { headadmin: 'Head Admin', admin: 'Admin', moderator: 'Moderator', helper: 'Helper' };
/**
 * One page of the roles that hold Vanguard command access in this guild.
 * Role mentions render as names; the embed suppresses mentions, so nothing is pinged.
 */
export function permPage(ctx, guildId, user, requested = 1) {
    const rows = [
        ...ctx.store.all('SELECT role_id,level,by_id FROM staff_roles WHERE guild_id=?', guildId).map(r => ({ ...r, access: `rank:${r.level}` })),
        ...ctx.store.all('SELECT * FROM permission_roles WHERE guild_id=? ORDER BY access,role_id', guildId),
    ];
    const order = (a) => a.startsWith('rank:') ? RANK_ORDER[a.slice(5)] ?? 4 : a === 'admin' ? 5 : 6;
    const guild = ctx.client.guilds.cache.get(guildId);
    const ordered = rows
        .map((row) => ({ access: String(row.access), role_id: String(row.role_id), by_id: String(row.by_id), role: guild?.roles.cache.get(row.role_id) ?? null }))
        .sort((a, b) => (a.access === b.access ? (b.role?.position ?? -1) - (a.role?.position ?? -1) : order(a.access) - order(b.access)));
    const pages = Math.max(1, Math.ceil(ordered.length / PER_PAGE));
    const page = Math.min(Math.max(1, requested), pages);
    const missing = ordered.filter(r => !r.role).length;
    const text = ordered.slice((page - 1) * PER_PAGE, page * PER_PAGE)
        .map(r => `<@&${r.role_id}> — **${r.access.startsWith('rank:') ? RANK_TEXT[r.access.slice(5)] : ACCESS_LABEL[r.access] ?? r.access}**${r.role ? '' : '  *(role deleted)*'}\nGranted by <@${r.by_id}>`)
        .join('\n\n') || 'No roles have been given Vanguard command access.\nUse `/setup config permission-role` to assign one.';
    const footer = `page ${page}/${pages} · ${ordered.length} assigned role${ordered.length === 1 ? '' : 's'}${missing ? ` · ${missing} deleted` : ''}`;
    return {
        embeds: [embed('Vanguard staff ranks', `${text}\n\n${footer}`, Colors.Blurple)],
        components: ordered.length
            ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`perm:${user}:${page - 1}`).setLabel('< Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 1), new ButtonBuilder().setCustomId(`perm:${user}:${page + 1}`).setLabel('Next >').setStyle(ButtonStyle.Secondary).setDisabled(page === pages))]
            : [],
        allowedMentions: { parse: [] },
    };
}
export function registerPermControls(registry) {
    registry.component({
        prefix: 'perm:', kinds: ['button'], metadata: { ...defaults, category: 'configuration', access: 'security' },
        execute: async (ctx, i) => {
            const match = /^perm:(\d{17,20}):(-?\d{1,6})$/.exec(i.customId);
            if (!match || match[1] !== i.user.id)
                throw new AppError('PERMISSION_ERROR', 'This permission list belongs to another staff member. Run /setup permissions list yourself.');
            await i.editReply(permPage(ctx, i.guildId, i.user.id, Number(match[2])));
        },
    });
    registry.component({
        prefix: 'permdiscord:', kinds: ['button'], metadata: { ...defaults, category: 'configuration', access: 'security' },
        execute: async (ctx, i) => {
            const match = /^permdiscord:(\d{17,20}):(-?\d{1,6})$/.exec(i.customId);
            if (!match || match[1] !== i.user.id)
                throw new AppError('PERMISSION_ERROR', 'This listing belongs to another staff member. Run /setup permissions discord yourself.');
            await i.editReply(discordPermPage(ctx, i.guildId, i.user.id, Number(match[2])));
        },
    });
}
/**
 * Roles that can reorder the hierarchy or grant themselves anything: Administrator
 * implies every permission, and Manage Roles is what allows moving roles about.
 * Discord does not log role position changes, so knowing who *could* do it is the
 * only prevention available.
 */
export function discordPermPage(ctx, guildId, user, requested = 1) {
    const guild = ctx.client.guilds.cache.get(guildId);
    if (!guild)
        throw new AppError('VALIDATION_ERROR', 'This server is not available to the bot right now.');
    const me = guild.members.me?.roles.highest.position ?? -1;
    const rows = [...guild.roles.cache.values()]
        .filter(role => role.permissions.has(PermissionFlagsBits.Administrator) || role.permissions.has(PermissionFlagsBits.ManageRoles))
        .sort((a, b) => b.position - a.position);
    const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
    const page = Math.min(Math.max(1, requested), pages);
    const text = rows.slice((page - 1) * PER_PAGE, page * PER_PAGE).map(role => {
        const admin = role.permissions.has(PermissionFlagsBits.Administrator);
        const flags = [admin ? '**Administrator**' : '**Manage Roles**', role.managed ? 'bot/integration role' : null, role.position > me ? '⚠ above the bot' : null].filter(Boolean).join(' · ');
        return `<@&${role.id}> — ${flags}\nposition ${role.position} · ${role.members.size} member${role.members.size === 1 ? '' : 's'}`;
    }).join('\n\n') || 'No role holds Administrator or Manage Roles.';
    const aboveBot = rows.filter(r => r.position > me).length;
    const note = aboveBot
        ? `\n\n⚠ ${aboveBot} of these sit above the bot's highest role, so the bot cannot revert changes they make.`
        : '';
    return {
        embeds: [embed('Discord permissions that can move roles', `${text}${note}\n\npage ${page}/${pages} · ${rows.length} role${rows.length === 1 ? '' : 's'}`, aboveBot ? Colors.Orange : Colors.Blurple)],
        components: rows.length
            ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`permdiscord:${user}:${page - 1}`).setLabel('< Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 1), new ButtonBuilder().setCustomId(`permdiscord:${user}:${page + 1}`).setLabel('Next >').setStyle(ButtonStyle.Secondary).setDisabled(page === pages))]
            : [],
        allowedMentions: { parse: [] },
    };
}
