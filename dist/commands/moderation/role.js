import { Colors, EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { clip } from '../../core.js';
import { staffReason } from '../../security/raidmode.js';
import { developers } from '../../bot/developers.js';
import { decideRoleChange, privilegedReason } from '../../security/role-policy.js';
import { approveRoleChange } from '../../security/role-authorizations.js';
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
    .addSubcommand(s => s.setName('allow').setDescription('Let configured moderators give and take a role (owner or Head Admin)')
    .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true))
    .addBooleanOption(o => o.setName('allowed').setDescription('True: moderators may manage it · False: remove it from the list').setRequired(true)))
    .addSubcommand(s => s.setName('policy').setDescription('Owner only: approve who may grant a protected (admin/moderation) role')
    .addRoleOption(o => o.setName('role').setDescription('The protected role').setRequired(true))
    .addBooleanOption(o => o.setName('approved').setDescription('True: approve · False: withdraw').setRequired(true))
    .addRoleOption(o => o.setName('grantor_role').setDescription('Members with this role may grant it'))
    .addUserOption(o => o.setName('grantor_user').setDescription('This person may grant it')))
    .addSubcommand(s => s.setName('rules').setDescription('Show the role allow list and approved grant rules')), { category: 'moderation', access: 'member', botPermissions: [PermissionFlagsBits.ManageRoles], cooldown: 1500 }, async (ctx, i) => {
    const sub = i.options.getSubcommand();
    const guildId = i.guildId;
    if (sub === 'rules') {
        const rows = ctx.store.all('SELECT * FROM role_rules WHERE guild_id=? ORDER BY kind, at', guildId);
        const allow = rows.filter(r => r.kind === 'allow').map(r => `<@&${r.role_id}>`);
        const grants = rows.filter(r => r.kind === 'grant').map(r => `<@&${r.role_id}> ← ${r.grantor_type === 'role' ? `<@&${r.grantor_id}>` : `<@${r.grantor_id}>`} · approved by <@${r.by_id}>`);
        return [`**Moderators may manage:** ${allow.join(', ') || 'no roles yet (`/role allow`)'}`, `**Approved grants of protected roles:**\n${grants.join('\n') || 'none (`/role policy`)'}`,
            '-# The owner and developers can manage any eligible role. Administrator / Manage Roles can manage ordinary roles below their own.'].join('\n');
    }
    if (sub === 'allow') {
        const role = i.options.getRole('role', true), allowed = i.options.getBoolean('allowed', true);
        if (role.id === guildId || role.managed)
            throw new AppError('VALIDATION_ERROR', 'Choose a normal role (not @everyone or a bot/integration role).');
        if (allowed)
            ctx.store.run("INSERT OR IGNORE INTO role_rules(guild_id,role_id,kind,grantor_type,grantor_id,by_id,at) VALUES(?,?,'allow','','',?,?)", guildId, role.id, i.user.id, Date.now());
        else
            ctx.store.run("DELETE FROM role_rules WHERE guild_id=? AND role_id=? AND kind='allow'", guildId, role.id);
        ctx.store.history(guildId, 'role/allow', null, { role: role.id, allowed }, i.user.id);
        const protectedNote = allowed && privilegedReason(ctx.store, guildId, role) ? '\n-# This is a protected role, so moderators also need an owner-approved rule (`/role policy`) before they can use it.' : '';
        return allowed ? `Configured moderators may now give and take <@&${role.id}>.${protectedNote}` : `<@&${role.id}> is no longer on the moderator allow list.`;
    }
    if (sub === 'policy') {
        // Owner-approved means the owner (or a developer): not Administrator, not a Head Admin.
        if (i.user.id !== i.guild.ownerId && !developers.has(i.user.id))
            throw new AppError('PERMISSION_ERROR', 'Only the server owner can approve who may grant protected roles.');
        const role = i.options.getRole('role', true), approved = i.options.getBoolean('approved', true);
        const grantorRole = i.options.getRole('grantor_role'), grantorUser = i.options.getUser('grantor_user');
        if (!!grantorRole === !!grantorUser)
            throw new AppError('VALIDATION_ERROR', 'Pick exactly one: grantor_role or grantor_user.');
        if (role.id === guildId || role.managed)
            throw new AppError('VALIDATION_ERROR', 'Choose a normal role (not @everyone or a bot/integration role).');
        const type = grantorRole ? 'role' : 'user', id = (grantorRole ?? grantorUser).id;
        if (approved)
            ctx.store.run("INSERT OR IGNORE INTO role_rules(guild_id,role_id,kind,grantor_type,grantor_id,by_id,at) VALUES(?,?,'grant',?,?,?,?)", guildId, role.id, type, id, i.user.id, Date.now());
        else
            ctx.store.run("DELETE FROM role_rules WHERE guild_id=? AND role_id=? AND kind='grant' AND grantor_type=? AND grantor_id=?", guildId, role.id, type, id);
        ctx.store.history(guildId, 'role/policy', null, { role: role.id, grantor: `${type}:${id}`, approved }, i.user.id);
        const who = type === 'role' ? `members with <@&${id}>` : `<@${id}>`;
        return approved ? `Approved: ${who} may give and take <@&${role.id}> (still only below their own highest role, and never to themselves).` : `Withdrawn: ${who} may no longer grant <@&${role.id}>.`;
    }
    const op = sub === 'add' ? 'add' : 'remove';
    const user = i.options.getUser('user', true), chosen = i.options.getRole('role', true);
    // Fresh data straight from Discord, checked immediately before the change.
    const [actor, target, role, me] = await Promise.all([
        i.guild.members.fetch({ user: i.user.id, force: true }),
        i.guild.members.fetch({ user: user.id, force: true }).catch(() => null),
        i.guild.roles.fetch(chosen.id, { force: true }).catch(() => null),
        i.guild.members.fetchMe({ force: true }),
    ]);
    if (!role)
        throw new AppError('VALIDATION_ERROR', 'That role no longer exists.');
    const decision = decideRoleChange({ store: ctx.store, guild: i.guild, actor, target, role, me, op });
    if (!decision.ok)
        throw new AppError(decision.kind === 'permission' || decision.kind === 'hierarchy' ? 'PERMISSION_ERROR' : 'VALIDATION_ERROR', decision.reason);
    if (decision.noop)
        return decision.noop;
    const member = target;
    const reason = staffReason(actor.id, `/role ${op} ${role.name}`);
    // Tell anti-nuke this exact change is approved, then make it. Withdrawn if Discord refuses.
    const withdraw = approveRoleChange(guildId, member.id, role.id, op);
    try {
        if (op === 'add')
            await member.roles.add(role, reason);
        else
            await member.roles.remove(role, reason);
    }
    catch (error) {
        withdraw();
        throw new AppError(error?.code === 50013 ? 'PERMISSION_ERROR' : 'VALIDATION_ERROR', error?.code === 50013
            ? 'Discord refused the change: Midtown Vanguard is missing Manage Roles or its role is not high enough.'
            : error?.code === 10007 ? 'That member left the server before the change was made.' : `Discord did not make the change (${clip(error?.message ?? 'unknown error', 150)}). Nothing was changed.`);
    }
    // Only now, after Discord confirmed it, is it logged as done.
    ctx.logs.push(guildId, roleChangeLog(i.guild, actor, member, role, op, decision.as));
    return `${op === 'add' ? 'Gave' : 'Removed'} <@&${role.id}> ${op === 'add' ? 'to' : 'from'} <@${member.id}>.`;
}, { subcommands: {
        rules: { responseKind: 'info', requiredPermissions: [PermissionFlagsBits.ManageRoles] },
        allow: { access: 'security', botPermissions: [] },
        policy: { access: 'owner', botPermissions: [] },
    } });
export function roleChangeLog(guild, actor, member, role, op, as) {
    return new EmbedBuilder().setColor(op === 'add' ? Colors.Blurple : Colors.Orange).setTitle(op === 'add' ? 'Role Added' : 'Role Removed')
        .setAuthor({ name: member.user?.tag ?? member.id, iconURL: /^https?:\/\//.test(member.user?.displayAvatarURL?.() ?? '') ? member.user.displayAvatarURL() : undefined })
        .addFields({ name: 'Member', value: `<@${member.id}> (\`${member.id}\`)`, inline: true }, { name: 'Role', value: `${role.name} (\`${role.id}\`)`, inline: true }, { name: 'Action', value: op === 'add' ? 'Added' : 'Removed', inline: true }, { name: 'By', value: `<@${actor.id}> (\`${actor.id}\`) · ${as}`, inline: true }, { name: 'Result', value: 'Confirmed by Discord', inline: true }, { name: 'Server ID', value: `\`${guild.id}\``, inline: true }).setFooter({ text: `/role ${op}` }).setTimestamp();
}
