import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { configureAntiPing, type PingTarget } from '../../security/antiping.js';
import { AppError } from '../../errors.js';

export default defineCommand(new SlashCommandBuilder().setName('antiping').setDescription('Protect selected staff roles and users from unauthorized mentions')
    .addSubcommand(s => s.setName('status').setDescription('Show staff mention protection and configured targets'))
    .addSubcommand(s => s.setName('enable').setDescription('Enable blocking mentions of configured staff'))
    .addSubcommand(s => s.setName('disable').setDescription('Disable staff mention blocking'))
    .addSubcommand(s => s.setName('protect').setDescription('Add a protected staff role mention or individual user')
        .addRoleOption(o => o.setName('role').setDescription('Protect mentions of this staff role'))
        .addUserOption(o => o.setName('user').setDescription('Protect direct mentions of this staff member')))
    .addSubcommand(s => s.setName('remove').setDescription('Remove a protected role or user')
        .addRoleOption(o => o.setName('role').setDescription('Staff role to remove'))
        .addUserOption(o => o.setName('user').setDescription('Staff member to remove')))
    .addSubcommand(s => s.setName('bypass').setDescription('Allow or disallow a role to mention protected staff')
        .addRoleOption(o => o.setName('role').setDescription('Bypass role').setRequired(true))
        .addBooleanOption(o => o.setName('allowed').setDescription('Allow this role to ping staff').setRequired(true))), { category: 'security', access: 'security', botPermissions: [PermissionFlagsBits.ManageMessages], requiredPermissions: [PermissionFlagsBits.ManageGuild] }, async (ctx, i) => {
    const guild = i.guildId, sub = i.options.getSubcommand();
    const config = ctx.store.get('SELECT enabled,rule_id FROM antiping_config WHERE guild_id=?', guild);
    let targets = ctx.store.all('SELECT kind,target_id FROM antiping_targets WHERE guild_id=? ORDER BY kind,target_id', guild) as PingTarget[];
    if (sub === 'status')
        return `Native mention protection: ${config?.enabled ? 'enabled' : 'disabled'}. Protected targets: ${targets.filter(t => t.kind !== 'bypass').length}.`;
    if (sub === 'protect' || sub === 'remove') {
        const role = i.options.getRole('role'), user = i.options.getUser('user');
        if (!role && !user)
            throw new AppError('VALIDATION_ERROR', 'Select a staff role or user.');
        if (role?.id === guild)
            throw new AppError('VALIDATION_ERROR', 'Select a staff role, not @everyone.');
        if (user) {
            const member = await i.guild.members.fetch(user.id).catch(() => null);
            if (!member || user.bot)
                throw new AppError('VALIDATION_ERROR', 'Choose a human staff member in this server.');
        }
        for (const t of [...(role ? [{ kind: 'role' as const, target_id: role.id }] : []), ...(user ? [{ kind: 'user' as const, target_id: user.id }] : [])]) {
            targets = targets.filter(old => old.kind !== t.kind || old.target_id !== t.target_id);
            if (sub === 'protect')
                targets.push(t);
        }
    } else if (sub === 'bypass') {
        const role = i.options.getRole('role', true);
        if (role.id === guild || role.managed)
            throw new AppError('VALIDATION_ERROR', 'Choose an ordinary staff bypass role, not @everyone or a managed role.');
        targets = targets.filter(t => t.kind !== 'bypass' || t.target_id !== role.id);
        if (i.options.getBoolean('allowed', true))
            targets.push({ kind: 'bypass', target_id: role.id });
    }
    const enabled = sub === 'enable' ? true : sub === 'disable' ? false : !!config?.enabled && targets.some(t => t.kind !== 'bypass');
    return configureAntiPing(ctx, i.guild, i.user.id, enabled, targets);
}, { subcommands: { status: { requiredPermissions: [], botPermissions: [], responseKind: 'info' } } });
