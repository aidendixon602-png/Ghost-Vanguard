import { PermissionsBitField, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { dangerous } from '../../core.js';
import { AppError } from '../../errors.js';
export default defineCommand(new SlashCommandBuilder().setName('roleinfo').setDescription('Role details: members, position, key permissions and anti-nuke bypass')
    .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true)), { category: 'utility', access: 'member', responseKind: 'info', cooldown: 3000 }, async (ctx, i) => {
    const role = await i.guild.roles.fetch(i.options.getRole('role', true).id);
    if (!role)
        throw new AppError('VALIDATION_ERROR', 'That role no longer exists.');
    const perms = new PermissionsBitField(role.permissions.bitfield).toArray();
    const key = perms.filter(p => ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'BanMembers', 'KickMembers', 'ModerateMembers', 'ManageMessages', 'ManageWebhooks', 'MentionEveryone'].includes(p));
    const bypass = ctx.store.hasGrant(i.guildId, role.id, 'trust_role');
    return [`<@&${role.id}> · \`${role.id}\``,
        `**Members:** ${role.members.size}${i.guild.members.cache.size < i.guild.memberCount ? ' (cached members only)' : ''}`,
        `**Position:** ${role.position} of ${i.guild.roles.cache.size - 1}${role.editable ? '' : ' · above Vanguard (it cannot manage this role)'}`,
        `**Color:** ${role.hexColor} · **Shown separately:** ${role.hoist ? 'yes' : 'no'} · **Mentionable:** ${role.mentionable ? 'yes' : 'no'}`,
        `**Created:** <t:${Math.floor(role.createdTimestamp / 1000)}:D>${role.managed ? ' · managed by a bot/integration' : ''}`,
        `**Key permissions:** ${key.join(', ') || 'none'}${dangerous(role.permissions.bitfield) ? ' · ⚠ dangerous' : ''}`,
        `**Anti-nuke bypass:** ${bypass ? 'yes (whitelisted)' : 'no'}`].join('\n');
});
