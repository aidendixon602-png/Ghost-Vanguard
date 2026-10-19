import { SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { embed } from '../../ui/ui.js';
import { RANKS, RANK_LABEL, rankOf, type RankName } from '../../bot/ranks.js';
import { addWorkspaceSubcommands, executeWorkspaceSubcommand } from '../../workspace/setup-command.js';

const guildConfigBuilder = new SlashCommandBuilder().setName('guild-config').setDescription('Server owner: command access, features, verification providers and backup schedule')
    .addSubcommand(s => s.setName('provider').setDescription('Enable or disable a configured verification provider').addStringOption(o => o.setName('provider').setDescription('Provider').setRequired(true).addChoices({ name: 'RoVer', value: 'rover' }, { name: 'Bloxlink', value: 'bloxlink' })).addBooleanOption(o => o.setName('enabled').setDescription('Enable this provider for this guild').setRequired(true)))
    .addSubcommand(s => s.setName('permission-role').setDescription('Give a Discord role a Vanguard staff rank (Head Admin, Admin, Moderator, Helper)').addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)).addStringOption(o => o.setName('access').setDescription('Rank for this role').setRequired(true).addChoices({ name: 'Head Admin (security and anti-nuke)', value: 'headadmin' }, { name: 'Admin (raid tools, lockdown, logs)', value: 'admin' }, { name: 'Moderator (moderation commands)', value: 'moderator' }, { name: 'Helper (warn, timeout, notes)', value: 'helper' }, { name: 'Remove access', value: 'remove' })))
    .addSubcommand(s => s.setName('command').setDescription('Turn one Vanguard command on/off or change its cooldown').addStringOption(o => o.setName('command').setDescription('Command name without /').setRequired(true)).addBooleanOption(o => o.setName('enabled').setDescription('Enabled').setRequired(true)).addIntegerOption(o => o.setName('cooldown').setDescription('Cooldown in milliseconds').setMinValue(0).setMaxValue(3600000)))
    .addSubcommand(s => s.setName('feature').setDescription('Turn moderation, verification, AI or backups on/off').addStringOption(o => o.setName('feature').setDescription('Feature').setRequired(true).addChoices(...['moderation', 'verification', 'ai', 'snapshots'].map(value => ({ name: value, value })))).addBooleanOption(o => o.setName('enabled').setDescription('Enabled').setRequired(true)))
    .addSubcommand(s => s.setName('backups').setDescription('Configure scheduled server layout backups').addBooleanOption(o => o.setName('enabled').setDescription('Automatic backups').setRequired(true)).addIntegerOption(o => o.setName('hours').setDescription('Interval hours').setMinValue(1).setMaxValue(168)).addIntegerOption(o => o.setName('keep').setDescription('Keep this many scheduled layout backups').setMinValue(1).setMaxValue(1000)));
addWorkspaceSubcommands(guildConfigBuilder);

export default defineCommand(guildConfigBuilder, { category: 'configuration', access: 'owner' }, async (ctx, i) => {
    const sub = i.options.getSubcommand(), guild = i.guildId, user = i.user.id;
    if (sub.startsWith('workspace-')) return executeWorkspaceSubcommand(ctx, i);
    let before: any, after: any, component: string;
    if (sub === 'provider') {
        const provider = i.options.getString('provider', true);
        component = `provider:${provider}`;
        before = ctx.store.get('SELECT * FROM provider_config WHERE guild_id=? AND provider=?', guild, provider) ?? null;
        ctx.store.run('INSERT INTO provider_config VALUES(?,?,?) ON CONFLICT(guild_id,provider) DO UPDATE SET enabled=excluded.enabled', guild, provider, Number(i.options.getBoolean('enabled', true)));
        after = ctx.store.get('SELECT * FROM provider_config WHERE guild_id=? AND provider=?', guild, provider);
    } else if (sub === 'permission-role') {
        const role = i.options.getRole('role', true), access = i.options.getString('access', true);
        component = 'permission-role';
        if (role.id === guild || role.managed)
            throw new AppError('VALIDATION_ERROR', 'Choose a regular staff role, not @everyone or a managed role.');
        // Ranks live in staff_roles (same as /setup staff role). Any older "Security admin / Moderation only" setting for this role is replaced.
        const read = () => ctx.store.get('SELECT level FROM staff_roles WHERE guild_id=? AND role_id=?', guild, role.id) ?? ctx.store.get('SELECT access AS level FROM permission_roles WHERE guild_id=? AND role_id=?', guild, role.id) ?? null;
        before = read();
        const level = String(before?.level ?? '');
        const actorRank = rankOf(ctx.store, guild, user, ctx.actor);
        for (const l of [access, level === 'admin' && !ctx.store.get('SELECT 1 FROM staff_roles WHERE guild_id=? AND role_id=?', guild, role.id) ? 'headadmin' : level].filter(l => l in RANKS) as RankName[])
            if (actorRank <= RANKS[l]) throw new AppError('PERMISSION_ERROR', `Only someone above ${RANK_LABEL[l]} can change that rank.`);
        ctx.store.run('DELETE FROM permission_roles WHERE guild_id=? AND role_id=?', guild, role.id);
        if (access === 'remove')
            ctx.store.run('DELETE FROM staff_roles WHERE guild_id=? AND role_id=?', guild, role.id);
        else
            ctx.store.run('INSERT INTO staff_roles(guild_id,role_id,level,by_id,at) VALUES(?,?,?,?,?) ON CONFLICT(guild_id,role_id) DO UPDATE SET level=excluded.level,by_id=excluded.by_id,at=excluded.at', guild, role.id, access, user, Date.now());
        after = read();
    } else if (sub === 'command') {
        const name = i.options.getString('command', true), def = ctx.registry.commands.get(`1:${name}`);
        component = `command:${name}`;
        if (!def?.metadata.requiresAuthorization || ['guild-config', 'config-history'].includes(name))
            throw new AppError('VALIDATION_ERROR', 'Choose a configurable protected command. Recovery access commands cannot be disabled.');
        before = ctx.store.get('SELECT * FROM command_settings WHERE guild_id=? AND command=?', guild, name) ?? null;
        ctx.store.run('INSERT INTO command_settings VALUES(?,?,?,?) ON CONFLICT(guild_id,command) DO UPDATE SET enabled=excluded.enabled,cooldown_ms=excluded.cooldown_ms', guild, name, Number(i.options.getBoolean('enabled', true)), i.options.getInteger('cooldown') ?? 1500);
        after = ctx.store.get('SELECT * FROM command_settings WHERE guild_id=? AND command=?', guild, name);
    } else if (sub === 'feature') {
        const feature = i.options.getString('feature', true);
        component = `feature:${feature}`;
        before = ctx.store.get('SELECT * FROM feature_settings WHERE guild_id=? AND feature=?', guild, feature) ?? null;
        ctx.store.run('INSERT INTO feature_settings VALUES(?,?,?) ON CONFLICT(guild_id,feature) DO UPDATE SET enabled=excluded.enabled', guild, feature, Number(i.options.getBoolean('enabled', true)));
        after = ctx.store.get('SELECT * FROM feature_settings WHERE guild_id=? AND feature=?', guild, feature);
    } else {
        component = 'backup-config';
        before = ctx.store.get('SELECT * FROM backup_config WHERE guild_id=?', guild) ?? null;
        ctx.store.run('INSERT INTO backup_config(guild_id,enabled,interval_hours,retention_count) VALUES(?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET enabled=excluded.enabled,interval_hours=excluded.interval_hours,retention_count=excluded.retention_count', guild, Number(i.options.getBoolean('enabled', true)), i.options.getInteger('hours') ?? 24, i.options.getInteger('keep') ?? 30);
        after = ctx.store.get('SELECT * FROM backup_config WHERE guild_id=?', guild);
    }
    ctx.store.history(guild, component, before, after, user);
    ctx.logs.push(guild, embed('Guild configuration changed', `${component} by ${user}`));
    if (sub === 'permission-role') {
        const role = i.options.getRole('role', true).id, access = i.options.getString('access', true);
        return access === 'remove' ? `<@&${role}> no longer has a Vanguard rank.` : `Everyone with <@&${role}> is now **${RANK_LABEL[access as RankName]}**. See every rank with \`/setup staff list\`.`;
    }
    return 'Guild configuration saved. Previous values are available in /setup history.';
});
