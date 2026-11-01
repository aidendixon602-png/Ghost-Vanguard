import { Colors, EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder, type Guild, type GuildMember, type Role } from 'discord.js';
import type { Store } from '../../database/db.js';
import { defineCommand } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { clip } from '../../core.js';
import { staffReason } from '../../security/raidmode.js';
import { developers } from '../../bot/developers.js';
import { decideRoleChange, privilegedReason, isBotPermissionRole } from '../../security/role-policy.js';
import { approveRoleChange } from '../../security/role-authorizations.js';
import { restoredLog, restoreRoles, restoreSummary } from '../../features/rejoin-roles.js';
import { RANKS, rankOf } from '../../bot/ranks.js';
import { addAssigner, addBlacklisted, assignersOf, blacklistAll, blacklistHolders, canAssignBlacklisted, describeAssigners, isBlacklisted, removeAssigner, removeBlacklisted } from '../../security/role-blacklist.js';
import { captureBlacklistHolders, dmActor } from '../../security/role-blacklist-enforce.js';

/**
 * /role add | remove — give or take one role, with every check done in here (not by Discord's
 * command visibility): see security/role-policy.ts for who may change what.
 * /role allow | policy | rules — the per-server allow list and owner-approved grant rules.
 */
export default defineCommand(new SlashCommandBuilder().setName('role').setDescription('Give or take a role from a member, with role rules and hierarchy enforced')
    .addSubcommand(s => s.setName('add').setDescription('Give a member a role')
        .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)).addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand(s => s.setName('remove').setDescription('Take a role from a member')
        .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)).addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand(s => s.setName('restore').setDescription('Give a member back the roles they had before they left the server')
        .addUserOption(o => o.setName('user').setDescription('Member who rejoined').setRequired(true)))
    .addSubcommand(s => s.setName('who-can-give').setDescription('Choose who can give a role, or see the list (leave everything empty)')
        .addRoleOption(o => o.setName('role').setDescription('The role (leave empty to see who can give what)'))
        .addMentionableOption(o => o.setName('who').setDescription('Only for staff roles: a role or person who may give it'))
        .addBooleanOption(o => o.setName('remove').setDescription('True to take this permission away instead')))
    .addSubcommandGroup(g => g.setName('blacklist').setDescription('Roles only the server owner or listed people may give or delete')
        .addSubcommand(s => s.setName('add').setDescription('Blacklist a role so only listed people can give it')
            .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)))
        .addSubcommand(s => s.setName('remove').setDescription('Take a role off the blacklist')
            .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)))
        .addSubcommand(s => s.setName('list').setDescription('Show every blacklisted role and who may give it'))
        .addSubcommand(s => s.setName('who-can-give').setDescription('Allow or stop one person or role from giving a blacklisted role')
            .addRoleOption(o => o.setName('role').setDescription('Blacklisted role').setRequired(true))
            .addMentionableOption(o => o.setName('who').setDescription('User or role to allow'))
            .addBooleanOption(o => o.setName('remove').setDescription('True to take this permission away')))),
{ category: 'moderation', access: 'member', botPermissions: [PermissionFlagsBits.ManageRoles], cooldown: 1500 }, async (ctx, i) => {
    const sub = i.options.getSubcommand();
    const guildId = i.guildId;
    if (i.options.getSubcommandGroup?.(false) === 'blacklist') return roleBlacklist(ctx, i);
    if (sub === 'who-can-give') return whoCanGive(ctx.store, i);

    const op = sub === 'add' ? 'add' : 'remove';
    const user = i.options.getUser('user', true), chosen = i.options.getRole('role', true);
    // Fresh data straight from Discord, checked immediately before the change.
    const [actor, target, role, me] = await Promise.all([
        i.guild.members.fetch({ user: i.user.id, force: true }),
        i.guild.members.fetch({ user: user.id, force: true }).catch(() => null),
        i.guild.roles.fetch(chosen.id, { force: true }).catch(() => null),
        i.guild.members.fetchMe({ force: true }),
    ]);
    if (!role) throw new AppError('VALIDATION_ERROR', 'That role no longer exists.');
    const decision = decideRoleChange({ store: ctx.store, guild: i.guild, actor, target, role, me, op });
    if (!decision.ok) {
        // A blacklisted role is refused here and the person is told privately as well as in the reply.
        if (decision.kind === 'blacklist')
            void dmActor(i.client, actor.id, 'Blacklisted role blocked', [
                `You tried to give <@&${role.id}> (**${role.name}**) to <@${user.id}> in **${i.guild.name}**.`,
                '', 'That role is blacklisted in this server, so only the people and roles listed for it can give it. Your staff rank or Discord permissions do not override that.', '',
                `Allowed for this role: ${describeAssigners(assignersOf(ctx.store, guildId, role.id))}.`,
            ].join('\n')).catch(() => false);
        throw new AppError(decision.kind === 'permission' || decision.kind === 'hierarchy' || decision.kind === 'blacklist' ? 'PERMISSION_ERROR' : 'VALIDATION_ERROR', decision.reason);
    }
    if (decision.noop) return decision.noop;
    const member = target!;
    const reason = staffReason(actor.id, `/role ${op} ${role.name}`);
    // Tell anti-nuke this exact change is approved, then make it. Withdrawn if Discord refuses.
    const withdraw = approveRoleChange(guildId, member.id, role.id, op);
    try {
        if (op === 'add') await member.roles.add(role, reason); else await member.roles.remove(role, reason);
    } catch (error: any) {
        withdraw();
        throw new AppError(error?.code === 50013 ? 'PERMISSION_ERROR' : 'VALIDATION_ERROR', error?.code === 50013
            ? 'Discord refused the change: Ghost Vanguard is missing Manage Roles or its role is not high enough.'
            : error?.code === 10007 ? 'That member left the server before the change was made.' : `Discord did not make the change (${clip(error?.message ?? 'unknown error', 150)}). Nothing was changed.`);
    }
    // Only now, after Discord confirmed it, is it logged as done.
    ctx.logs.push(guildId, roleChangeLog(i.guild, actor, member, role, op, decision.as));
    return `${op === 'add' ? 'Gave' : 'Removed'} <@&${role.id}> ${op === 'add' ? 'to' : 'from'} <@${member.id}>.`;
}, { subcommands: {
    'who-can-give': { access: 'security', botPermissions: [] },
} });

export function roleChangeLog(guild: Pick<Guild, 'id' | 'name'>, actor: GuildMember, member: GuildMember, role: Pick<Role, 'id' | 'name'>, op: 'add' | 'remove', as: string) {
    return new EmbedBuilder().setColor(op === 'add' ? Colors.Blurple : Colors.Orange).setTitle(op === 'add' ? 'Role Added' : 'Role Removed')
        .setAuthor({ name: member.user?.tag ?? member.id, iconURL: /^https?:\/\//.test(member.user?.displayAvatarURL?.() ?? '') ? member.user!.displayAvatarURL() : undefined })
        .addFields(
            { name: 'Member', value: `<@${member.id}> (\`${member.id}\`)`, inline: true },
            { name: 'Role', value: `${role.name} (\`${role.id}\`)`, inline: true },
            { name: 'Action', value: op === 'add' ? 'Added' : 'Removed', inline: true },
            { name: 'By', value: `<@${actor.id}> (\`${actor.id}\`) · ${as}`, inline: true },
            { name: 'Result', value: 'Confirmed by Discord', inline: true },
            { name: 'Server ID', value: `\`${guild.id}\``, inline: true },
        ).setFooter({ text: `/role ${op}` }).setTimestamp();
}

/**
 * /role who-can-give, in plain words:
 *  - ordinary role, no "who": moderators may give it too (anyone with Manage Roles already can)
 *  - staff role (ban, kick, admin, Vanguard staff…) + "who": that role or person may give it (server owner only)
 *  - nothing filled in: the list
 * Saved as the same rows as before (kind 'allow' / 'grant'), so existing setups keep working.
 */
async function whoCanGive(store: Store, i: any): Promise<string> {
    const guildId = i.guildId as string;
    const role = i.options.getRole('role') as Role | null;
    const whoOption = i.options.get('who');
    const remove = i.options.getBoolean('remove') ?? false;
    if (!role) return whoCanGiveList(store, guildId);
    if (role.id === guildId || role.managed) throw new AppError('VALIDATION_ERROR', 'Choose a normal role (not @everyone or a bot/integration role).');
    const owner = i.user.id === i.guild.ownerId || developers.has(i.user.id);
    const staff = privilegedReason(store, guildId, role);
    const allow = (on: boolean) => on
        ? store.run("INSERT OR IGNORE INTO role_rules(guild_id,role_id,kind,grantor_type,grantor_id,by_id,at) VALUES(?,?,'allow','','',?,?)", guildId, role.id, i.user.id, Date.now())
        : store.run("DELETE FROM role_rules WHERE guild_id=? AND role_id=? AND kind='allow'", guildId, role.id);

    if (!staff) {
        allow(!remove);
        store.history(guildId, 'role/who-can-give', null, { role: role.id, moderators: !remove }, i.user.id);
        const extra = whoOption ? '\n-# This is an ordinary role, so you don\'t need to pick who: it applies to every moderator.' : '';
        return (remove ? `Moderators can **no longer** give or take <@&${role.id}>. Anyone with Manage Roles still can.` : `✅ Moderators can now give and take <@&${role.id}> with \`/role add\`.`) + extra;
    }

    if (isBotPermissionRole(store, guildId, role.id) && !remove)
        throw new AppError('VALIDATION_ERROR', 'A role that carries a Vanguard rank cannot be delegated through role rules. The server owner gives it with `/role add`, or lets someone above that rank do it.');
    // Staff roles: only the owner decides who hands them out.
    if (!owner) throw new AppError('PERMISSION_ERROR', `<@&${role.id}> is a staff role (${staff}), so only the server owner can choose who gives it.`);
    if (!whoOption) {
        if (!remove) throw new AppError('VALIDATION_ERROR', `<@&${role.id}> is a staff role (${staff}). Pick **who** may give it: a role (like your Head Mods role) or one person.\nExample: \`/role who-can-give role:@${role.name} who:@Head Mods\``);
        store.run("DELETE FROM role_rules WHERE guild_id=? AND role_id=?", guildId, role.id);
        store.history(guildId, 'role/who-can-give', null, { role: role.id, cleared: true }, i.user.id);
        return `Nobody except you (and Developers) can give <@&${role.id}> now.`;
    }
    const type = whoOption.role ? 'role' : 'user';
    const id = String((whoOption.role ?? whoOption.user)?.id ?? whoOption.value);
    const who = type === 'role' ? `<@&${id}>` : `<@${id}>`;
    if (remove) {
        store.run("DELETE FROM role_rules WHERE guild_id=? AND role_id=? AND kind='grant' AND grantor_type=? AND grantor_id=?", guildId, role.id, type, id);
        if (!store.get("SELECT 1 FROM role_rules WHERE guild_id=? AND role_id=? AND kind='grant'", guildId, role.id)) allow(false);
        store.history(guildId, 'role/who-can-give', null, { role: role.id, giver: `${type}:${id}`, allowed: false }, i.user.id);
        return `${who} can **no longer** give or take <@&${role.id}>.`;
    }
    store.run("INSERT OR IGNORE INTO role_rules(guild_id,role_id,kind,grantor_type,grantor_id,by_id,at) VALUES(?,?,'grant',?,?,?,?)", guildId, role.id, type, id, i.user.id, Date.now());
    allow(true); // so givers who are moderators (not Manage Roles) can use it too
    store.history(guildId, 'role/who-can-give', null, { role: role.id, giver: `${type}:${id}`, allowed: true }, i.user.id);
    return [`✅ ${type === 'role' ? `Anyone with ${who}` : who} can now give and take <@&${role.id}> with \`/role add\`.`,
        '-# They still need Manage Roles or a Vanguard moderator rank, can only use it on people below them, and can never give it to themselves.'].join('\n');
}

export function whoCanGiveList(store: Store, guildId: string): string {
    const rows = store.all('SELECT * FROM role_rules WHERE guild_id=? ORDER BY at', guildId);
    const byRole = new Map<string, { moderators: boolean; givers: string[] }>();
    for (const r of rows) {
        const entry = byRole.get(String(r.role_id)) ?? { moderators: false, givers: [] };
        if (r.kind === 'allow') entry.moderators = true;
        else entry.givers.push(r.grantor_type === 'role' ? `<@&${r.grantor_id}>` : `<@${r.grantor_id}>`);
        byRole.set(String(r.role_id), entry);
    }
    const lines = [...byRole].map(([roleId, e]) => `<@&${roleId}> → ${e.givers.length ? e.givers.join(', ') : 'any moderator'}`);
    return ['**Who can give which roles**', lines.join('\n') || '*Nothing set up yet.*', '',
        '-# Always: the server owner and developers can give any role. People with Manage Roles or Administrator can give ordinary roles below their own.',
        '-# Set it up: `/role who-can-give role:@Role` (ordinary roles → every moderator) or `/role who-can-give role:@StaffRole who:@HeadMods` (staff roles, owner only).'].join('\n');
}

/**
 * /role blacklist add | remove | list | who-can-give — the per-server role blacklist.
 *
 * Only the Server Owner and Developers manage it. A blacklisted role can only be given (or deleted) by
 * the people and roles explicitly listed for it; staff ranks, Discord Administrator permission and
 * anti-nuke whitelists never stand in for that list.
 */
async function roleBlacklist(ctx: any, i: any): Promise<string> {
    const guildId = i.guildId as string;
    if (!developers.has(i.user.id) && rankOf(ctx.store, guildId, i.user.id, ctx.actor) < RANKS.owner)
        throw new AppError('PERMISSION_ERROR', 'Only the server owner or a Developer can manage the role blacklist.');
    const sub = i.options.getSubcommand();
    if (sub === 'list') {
        const rows = blacklistAll(ctx.store, guildId);
        if (!rows.length) return 'No blacklisted roles yet. Add one with `/role blacklist add role:@Role`.';
        const lines = rows.map(row => {
            const listed = describeAssigners(assignersOf(ctx.store, guildId, row.role_id));
            const holders = blacklistHolders(ctx.store, guildId, row.role_id).length;
            return `<@&${row.role_id}> → ${listed === 'nobody yet' ? '**nobody** (nobody can give it)' : listed}${holders ? ` · ${holders} member${holders === 1 ? '' : 's'} have it` : ''}`;
        });
        return ['**Blacklisted roles**', ...lines, '', '-# Server owner and Developers manage this list. Higher ranks and Discord Administrator permission never bypass it. `/role blacklist who-can-give role:@Role who:@User`'].join('\n');
    }
    const role = i.options.getRole('role', true) as Role;
    if (role.id === guildId || role.managed) throw new AppError('VALIDATION_ERROR', 'Choose a normal role (not @everyone or a bot/integration role).');
    if (sub === 'add') {
        if (isBlacklisted(ctx.store, guildId, role.id)) return `<@&${role.id}> is already blacklisted.`;
        addBlacklisted(ctx.store, guildId, role, i.user.id);
        const holders = await captureBlacklistHolders(ctx.store, i.guild, role.id).catch(() => 0);
        ctx.store.history(guildId, 'role/blacklist', null, { role: role.id, blacklisted: true }, i.user.id);
        ctx.logs.push(guildId, new EmbedBuilder().setColor(Colors.Red).setTitle('Role blacklisted')
            .setDescription(`${role.name} (<@&${role.id}>) is now blacklisted by <@${i.user.id}>.\nOnly listed people may give or delete it. ${holders ? `${holders} current holder${holders === 1 ? '' : 's'} recorded.` : 'Nobody has it right now.'}`).setTimestamp());
        return `🔒 <@&${role.id}> is blacklisted. Nobody can give it until you list someone: \`/role blacklist who-can-give role:@${role.name} who:@User\`.`;
    }
    if (sub === 'remove') {
        if (!isBlacklisted(ctx.store, guildId, role.id)) return `<@&${role.id}> is not blacklisted.`;
        removeBlacklisted(ctx.store, guildId, role.id);
        ctx.store.history(guildId, 'role/blacklist', { role: role.id, blacklisted: true }, null, i.user.id);
        ctx.logs.push(guildId, new EmbedBuilder().setColor(Colors.Green).setTitle('Role unblacklisted').setDescription(`${role.name} (<@&${role.id}>) by <@${i.user.id}>.`).setTimestamp());
        return `<@&${role.id}> is no longer blacklisted. The normal role rules apply again.`;
    }
    // who-can-give
    if (!isBlacklisted(ctx.store, guildId, role.id))
        throw new AppError('VALIDATION_ERROR', `<@&${role.id}> is not blacklisted. Blacklist it first with \`/role blacklist add\`.`);
    // The option says what was picked: .role for a role, .user for a person (also one who is not in the server).
    const who = i.options.get('who') as { role?: { id: string } | null; user?: { id: string } | null; value?: unknown } | null;
    const remove = i.options.getBoolean('remove') ?? false;
    if (!who) throw new AppError('VALIDATION_ERROR', 'Pick who may give it: a person or a role.');
    const type = who.role ? 'role' as const : 'user' as const;
    const id = String((who.role ?? who.user)?.id ?? who.value);
    if (remove) {
        removeAssigner(ctx.store, guildId, role.id, type, id);
        ctx.store.history(guildId, 'role/blacklist', null, { role: role.id, giver: `${type}:${id}`, allowed: false }, i.user.id);
        return `${type === 'role' ? `<@&${id}>` : `<@${id}>`} can **no longer** give <@&${role.id}>.`;
    }
    addAssigner(ctx.store, guildId, role.id, type, id, i.user.id);
    ctx.store.history(guildId, 'role/blacklist', null, { role: role.id, giver: `${type}:${id}`, allowed: true }, i.user.id);
    const listed = describeAssigners(assignersOf(ctx.store, guildId, role.id));
    return `✅ ${type === 'role' ? `Anyone with <@&${id}>` : `<@${id}>`} can now give <@&${role.id}>. Anyone on the list: ${listed}.`;
}
