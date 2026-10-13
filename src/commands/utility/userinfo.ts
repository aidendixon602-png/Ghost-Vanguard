import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { RANKS, rankOf } from '../../bot/ranks.js';
import { dangerous } from '../../core.js';
import { clip } from '../../core.js';

const t = (ms?: number | null, style = 'D') => ms ? `<t:${Math.floor(ms / 1000)}:${style}> (<t:${Math.floor(ms / 1000)}:R>)` : 'Unknown';

export default defineCommand(new SlashCommandBuilder().setName('userinfo').setDescription('Member details; staff also see cases, notes, bypasses and Roblox link')
    .addUserOption(o => o.setName('user').setDescription('Member (default: you)')),
{ category: 'utility', access: 'member', responseKind: 'info', cooldown: 3000 }, async (ctx, i) => {
    const user = await ctx.client.users.fetch((i.options.getUser('user') ?? i.user).id, { force: true });
    const member = await i.guild.members.fetch(user.id).catch(() => null);
    const lines = [`**${user.tag}** ${user.bot ? '· 🤖 bot' : ''}`, `**ID:** ${user.id}`, `**Account created:** ${t(user.createdTimestamp)}`];
    if ((Date.now() - user.createdTimestamp) < 7 * 86400000) lines.push('⚠ **New account** (under 7 days old)');
    if (member) {
        const roles = member.roles.cache.filter(r => r.id !== i.guildId).sort((a, b) => b.position - a.position);
        lines.push(`**Joined server:** ${t(member.joinedTimestamp)}`, `**Nickname:** ${member.nickname ?? 'None'}`,
            `**Roles (${roles.size}):** ${clip(roles.map(r => `<@&${r.id}>`).join(' ') || 'None', 900)}`,
            `**Top role:** <@&${member.roles.highest.id}>${dangerous(member.permissions.bitfield) ? ' · ⚠ has admin/moderation permissions' : ''}`);
        if (member.communicationDisabledUntilTimestamp && member.communicationDisabledUntilTimestamp > Date.now()) lines.push(`**Timed out until:** ${t(member.communicationDisabledUntilTimestamp, 'f')}`);
    } else lines.push('**Not in this server.**');
    // Moderation details are visible only to staff who can moderate.
    if (ctx.actor?.permissions.has(PermissionFlagsBits.ModerateMembers) || rankOf(ctx.store, i.guildId, i.user.id, ctx.actor) >= RANKS.helper) {
        const cases = ctx.store.all('SELECT number,action,at FROM cases WHERE guild_id=? AND user_id=? ORDER BY id DESC LIMIT 3', i.guildId, user.id);
        const caseCount = ctx.store.get('SELECT COUNT(*) AS n FROM cases WHERE guild_id=? AND user_id=?', i.guildId, user.id)?.n ?? 0;
        const notes = ctx.store.get('SELECT COUNT(*) AS n FROM member_notes WHERE guild_id=? AND user_id=?', i.guildId, user.id)?.n ?? 0;
        const link = ctx.store.get('SELECT roblox_id,username FROM links WHERE guild_id=? AND user_id=?', i.guildId, user.id);
        const bypass = ctx.security.trusted(i.guild, user.id);
        const tempban = ctx.store.get('SELECT until FROM tempbans WHERE guild_id=? AND user_id=?', i.guildId, user.id);
        lines.push('', '**Staff view**',
            `**Cases:** ${caseCount}${cases.length ? ` · latest: ${cases.map(c => `#${c.number} ${c.action} <t:${Math.floor(c.at / 1000)}:R>`).join(', ')}` : ''}`,
            `**Notes:** ${notes}${notes ? ' · /mod notes list' : ''}`,
            `**Anti-nuke bypass:** ${bypass ? 'yes' : 'no'}`,
            `**Roblox:** ${link ? `${link.username ?? 'linked'} (${link.roblox_id})` : 'not linked'}`);
        if (tempban) lines.push(`**Temp-banned until:** ${t(tempban.until, 'f')}`);
    }
    await i.editReply({ embeds: [{ title: 'User information', description: lines.join('\n'), color: 0x5865F2, thumbnail: { url: user.displayAvatarURL({ size: 256 }) } }], allowedMentions: { parse: [] } });
});
