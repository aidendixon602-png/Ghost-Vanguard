import { ChannelType, Colors, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { clip, dangerous, RULES } from '../../core.js';
import { AppError } from '../../errors.js';
import { defineCommand, type CommandContext } from '../../bot/registry.js';
import { checkTarget, embed, REQUIRED_PERMISSIONS } from '../../ui/ui.js';

export default defineCommand(new SlashCommandBuilder().setName('security').setDescription('Security settings, admins, incidents, quarantine and Roblox bans')
    .addSubcommand(s => s.setName('status').setDescription('Show security health and configuration'))
    .addSubcommand(s => s.setName('config').setDescription('Set the security log channel and Roblox verification options')
        .addChannelOption(o => o.setName('logs').setDescription('Security log channel').addChannelTypes(ChannelType.GuildText))
        .addRoleOption(o => o.setName('verified_role').setDescription('Safe role granted after Roblox verification'))
        .addRoleOption(o => o.setName('quarantine_role').setDescription('Safe quarantine marker role'))
        .addIntegerOption(o => o.setName('min_age_days').setDescription('Minimum Roblox account age').setMinValue(0).setMaxValue(3650))
        .addBooleanOption(o => o.setName('sync_on_join').setDescription('Check linked accounts when members join'))
        .addBooleanOption(o => o.setName('revoke_on_unlink').setDescription('Remove verified role when all providers confirm no link'))
        .addBooleanOption(o => o.setName('block_known_bans').setDescription('Block banned Roblox accounts and locally recorded ban-linked accounts'))
        .addBooleanOption(o => o.setName('nickname_sync').setDescription('Set nickname to Roblox username')))
    .addSubcommand(s => s.setName('admin').setDescription('Server owner: add, remove or list security admins')
        .addStringOption(o => o.setName('action').setDescription('Action').setRequired(true).addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'List', value: 'list' }))
        .addUserOption(o => o.setName('user').setDescription('Required for add/remove')))
    .addSubcommand(s => s.setName('incidents').setDescription('View recent anti-nuke incidents').addIntegerOption(o => o.setName('id').setDescription('Specific incident ID').setMinValue(1)))
    .addSubcommand(s => s.setName('quarantine').setDescription('Contain a member and save their roles').addUserOption(o => o.setName('user').setDescription('Target').setRequired(true)))
    .addSubcommand(s => s.setName('release').setDescription('Restore a quarantined member’s saved roles').addUserOption(o => o.setName('user').setDescription('Target').setRequired(true)).addBooleanOption(o => o.setName('restore_privileged').setDescription('Explicitly restore saved dangerous roles too'))), { category: 'configuration', cooldown: 1500, access: 'security' }, async (ctx: CommandContext, i) => {
    const actor = ctx.actor!;
    const s = ctx.store.settings(i.guildId);
    const sub = i.options.getSubcommand();
    if (sub === 'status') {
        const me = await i.guild.members.fetchMe();
        const missing = REQUIRED_PERMISSIONS.filter(p => !me.permissions.has(p)).map(p => new (me.permissions.constructor as typeof import('discord.js').PermissionsBitField)(p).toArray()[0]);
        const last = ctx.store.get('SELECT number,at FROM snapshots WHERE guild_id=? ORDER BY id DESC LIMIT 1', i.guildId);
        return `**Authorized:** ${s.authorized}\n**Anti-nuke:** ${s.enabled ? 'enabled' : 'disabled'} · ${s.mode}\n**Rules:** ${RULES.length}\n**Logs:** ${s.logChannelId ? `<#${s.logChannelId}>` : 'not set'}\n**Verified role:** ${s.verifiedRoleId ? `<@&${s.verifiedRoleId}>` : 'not set'}\n**Quarantine role:** ${s.quarantineRoleId ? `<@&${s.quarantineRoleId}>` : 'not set'}\n**Roblox minimum age:** ${s.minAge} days\n**Unlink revocation:** ${s.revokeOnUnlink}\n**Latest snapshot:** ${last ? `#${last.number} · <t:${Math.floor(last.at / 1000)}:R>` : 'none'}\n**Bot permissions missing:** ${missing.join(', ') || 'none'}\n**Failed log deliveries:** ${ctx.store.get('SELECT COUNT(*) AS n FROM outbox WHERE guild_id=? AND attempts>=8', i.guildId)?.n ?? 0}\n**Role order:** place the bot above every role/member it must manage. Owner and higher roles cannot be contained.`;
    }
    if (sub === 'config') {
        const me = await i.guild.members.fetchMe();
        for (const [option, field] of [['verified_role', 'verifiedRoleId'], ['quarantine_role', 'quarantineRoleId']] as const) {
            const chosen = i.options.getRole(option);
            if (chosen) {
                const role = await i.guild.roles.fetch(chosen.id);
                if (!role || role.id === i.guildId || role.managed || !role.editable || dangerous(role.permissions.bitfield))
                    throw new AppError('VALIDATION_ERROR', `${option} must be a safe, unmanaged role below the bot without moderation or administrative permissions.`);
                s[field] = role.id;
            }
        }
        if (s.verifiedRoleId && s.verifiedRoleId === s.quarantineRoleId)
            throw new AppError('VALIDATION_ERROR', 'Verified and quarantine roles must be different.');
        const logs = i.options.getChannel('logs');
        if (logs) {
            const channel = await i.guild.channels.fetch(logs.id);
            if (!channel || !channel.isSendable() || !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]))
                throw new AppError('VALIDATION_ERROR', 'The bot needs View Channel, Send Messages and Embed Links in the log channel.');
            s.logChannelId = logs.id;
        }
        s.minAge = i.options.getInteger('min_age_days') ?? s.minAge;
        s.syncOnJoin = i.options.getBoolean('sync_on_join') ?? s.syncOnJoin;
        s.revokeOnUnlink = i.options.getBoolean('revoke_on_unlink') ?? s.revokeOnUnlink;
        s.blockBanned = i.options.getBoolean('block_known_bans') ?? s.blockBanned;
        s.nickname = i.options.getBoolean('nickname_sync') ?? s.nickname;
        ctx.store.save(s, i.user.id);
        ctx.logs.push(i.guildId, embed('Security configuration saved', `Updated by <@${actor.id}>.`, Colors.Green));
        return 'Configuration saved. Use /setup status to review it.';
    }
    if (sub === 'admin') {
        const action = i.options.getString('action', true);
        if (action === 'list')
            return ctx.store.all('SELECT user_id FROM grants WHERE guild_id=? AND kind=?', i.guildId, 'admin').map(r => `<@${r.user_id}>`).join('\n') || 'No additional security admins. Developers and the server owner already have access.';
        const user = i.options.getUser('user');
        if (!user || user.bot)
            throw new AppError('VALIDATION_ERROR', 'Select a human user for add/remove.');
        if (user.id === actor.id)
            throw new AppError('VALIDATION_ERROR', 'Another owner/developer must change your own explicit admin grant.');
        if (action === 'add')
            ctx.store.grant(i.guildId, user.id, 'admin', actor.id);
        else
            ctx.store.revokeGrant(i.guildId, user.id, 'admin', i.user.id);
        ctx.logs.push(i.guildId, embed('Security admin changed', `<@${actor.id}>: ${action} <@${user.id}>`, Colors.Orange));
        return `Security admin grant ${action === 'add' ? 'added' : 'removed'} for <@${user.id}>. Anti-nuke trust is separate.`;
    }
    if (sub === 'incidents') {
        const id = i.options.getInteger('id');
        const rows = id ? ctx.store.all('SELECT * FROM incidents WHERE guild_id=? AND id=?', i.guildId, id) : ctx.store.all('SELECT * FROM incidents WHERE guild_id=? ORDER BY id DESC LIMIT 8', i.guildId);
        return rows.map(r => `**#${r.id} · ${r.rule} · ${r.mode}**\nActor: ${r.actor_id === 'joins' ? 'join flood' : `<@${r.actor_id}>`} · <t:${Math.floor(r.at / 1000)}:R>\n${clip(r.result, 350)}`).join('\n\n') || 'No matching incidents.';
    }
    if (sub === 'quarantine' || sub === 'release') {
        const user = i.options.getUser('user', true);
        const target = await i.guild.members.fetch({ user: user.id, force: true });
        checkTarget(actor, target, await i.guild.members.fetchMe());
        if (sub === 'quarantine' && ctx.security.trusted(i.guild, user.id))
            throw new AppError('VALIDATION_ERROR', 'This member is protected by owner/developer/trust status. Revoke explicit trust before quarantine.');
        const result = sub === 'quarantine' ? await ctx.security.contain(i.guild, user.id) : await ctx.security.release(i.guild, user.id, i.options.getBoolean('restore_privileged') ?? false);
        ctx.logs.push(i.guildId, embed(sub === 'quarantine' ? 'Manual quarantine' : 'Quarantine release', `By <@${actor.id}> · member <@${user.id}>\n${result}`, Colors.Orange));
        return result;
    }
    throw new AppError('VALIDATION_ERROR', 'Unknown security action.');
}, { subcommands: { admin: { access: 'owner' }, config: { botPermissions: [PermissionFlagsBits.ManageRoles] }, quarantine: { botPermissions: [PermissionFlagsBits.ManageRoles] }, release: { botPermissions: [PermissionFlagsBits.ManageRoles] } },
    contextualPolicy: i => i.isChatInputCommand() && i.options.getSubcommand(false) === 'release' && i.options.getBoolean('restore_privileged') ? { access: 'owner' } : {} });
