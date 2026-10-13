import { EmbedBuilder, Colors, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { clip } from '../../core.js';
import { caseId, renderRecord, type BanRecord } from '../../audit/ban-log.js';
import { activeBan, recordId } from '../../security/network-ban.js';

/**
 * /mod bans: look things up in the ban log without scrolling #bans.
 *   lookup  every ban record for a user here, plus any active genreban/hardban
 *   case    one record by its case ID (BAN-0005 or 5), with a link to the message
 *   recent  the latest records
 *   stats   the last 30 days: bans, unbans, types and who banned most
 */
const STATUS: Record<string, string> = { banned: '🔴 Banned', unbanned: '🟢 Unbanned', expired: '🟢 Expired' };
const TYPE: Record<string, string> = { ban: 'Ban', manual: 'Ban', tempban: 'Tempban', softban: 'Softban', genreban: 'Genreban', hardban: 'Hardban', automatic: 'Automatic' };
const link = (r: BanRecord) => r.channel_id && r.message_id ? ` · [view](https://discord.com/channels/${r.guild_id}/${r.channel_id}/${r.message_id})` : '';
const line = (r: BanRecord) => `**${caseId(r)}** · ${STATUS[r.status] ?? r.status} · ${TYPE[r.kind] ?? r.kind}${r.network_record ? ` ${r.network_record}` : ''} · <t:${Math.floor((r.banned_at || r.status_at || 0) / 1000)}:d>${link(r)}\n-# ${clip(r.reason || 'No reason provided', 120)}`;

export default defineCommand(new SlashCommandBuilder().setName('bans').setDescription('Search the ban log: a user, a case ID, recent bans or stats')
    .addSubcommand(s => s.setName('lookup').setDescription("A user's ban records in this server")
        .addUserOption(o => o.setName('user').setDescription('User (or paste their ID)').setRequired(true)))
    .addSubcommand(s => s.setName('case').setDescription('Show one ban record by case ID')
        .addStringOption(o => o.setName('id').setDescription('Case ID, e.g. BAN-0005 or 5').setRequired(true).setMaxLength(12)))
    .addSubcommand(s => s.setName('recent').setDescription('The latest ban records in this server'))
    .addSubcommand(s => s.setName('stats').setDescription('Bans and unbans in the last 30 days')),
{ category: 'moderation', responseKind: 'info', requiredPermissions: [PermissionFlagsBits.BanMembers], cooldown: 3000 }, async (ctx, i) => {
    const guild = i.guildId, sub = i.options.getSubcommand();
    const all = (sql: string, ...args: (string | number)[]) => ctx.store.all(sql, guild, ...args) as unknown as BanRecord[];
    if (sub === 'case') {
        const n = Number(/^\s*(?:BAN-?)?0*(\d{1,6})\s*$/i.exec(i.options.getString('id', true))?.[1]);
        if (!n) throw new AppError('VALIDATION_ERROR', 'Use a case ID like BAN-0005 or just 5.');
        const r = all('SELECT * FROM ban_records WHERE guild_id=? AND number=?', n)[0];
        if (!r) throw new AppError('VALIDATION_ERROR', `There is no ${`BAN-${String(n).padStart(4, '0')}`} in this server.`);
        await i.editReply({ content: link(r) ? `Posted in <#${r.channel_id}>${link(r)}` : undefined, embeds: renderRecord(r).embeds, allowedMentions: { parse: [] } });
        return;
    }
    if (sub === 'lookup') {
        const user = i.options.getUser('user', true);
        const rows = all('SELECT * FROM ban_records WHERE guild_id=? AND user_id=? ORDER BY id DESC LIMIT 10', user.id);
        const net = activeBan(ctx.store, 'hardban', user.id) ?? activeBan(ctx.store, 'genreban', user.id);
        const e = new EmbedBuilder().setColor(rows[0]?.status === 'banned' || net ? Colors.Red : Colors.Green)
            .setAuthor({ name: `${user.tag ?? user.username} · ban history`, iconURL: user.displayAvatarURL() })
            .setDescription(rows.length ? rows.map(line).join('\n') : 'No ban records for this user in this server.')
            .setFooter({ text: `User ID: ${user.id}` });
        if (net) e.addFields({ name: '🌐 Network ban', value: `Active **${net.kind}** ${recordId(net)} · ${clip(net.reason, 200)}` });
        await i.editReply({ embeds: [e], allowedMentions: { parse: [] } });
        return;
    }
    if (sub === 'recent') {
        const rows = all('SELECT * FROM ban_records WHERE guild_id=? ORDER BY id DESC LIMIT 10');
        const e = new EmbedBuilder().setColor(Colors.Blurple).setTitle('📋 Recent bans')
            .setDescription(rows.length ? rows.map(r => `<@${r.user_id}> · ${line(r)}`).join('\n') : 'No ban records yet. Set up the ban log with `/setup logs setup`.');
        await i.editReply({ embeds: [e], allowedMentions: { parse: [] } });
        return;
    }
    const since = Date.now() - 30 * 86400000;
    const rows = all('SELECT * FROM ban_records WHERE guild_id=? AND (banned_at>=? OR status_at>=?)', since, since);
    const banned = rows.filter(r => r.banned_at >= since), lifted = rows.filter(r => (r.status_at ?? 0) >= since && r.status !== 'banned');
    const count = (list: string[]) => [...list.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
    const types = count(banned.map(r => TYPE[r.kind] ?? r.kind)).map(([k, n]) => `${k}: **${n}**`).join(' · ') || 'none';
    const mods = count(banned.filter(r => r.moderator_id && r.moderator_role !== 'unverified' && r.moderator_role !== 'automatic').map(r => r.moderator_id!)).slice(0, 5)
        .map(([id, n], k) => `${['🥇', '🥈', '🥉', '4.', '5.'][k]} <@${id}> · ${n}`).join('\n') || 'none';
    const e = new EmbedBuilder().setColor(Colors.Blurple).setTitle('📊 Bans · last 30 days').addFields(
        { name: 'Bans', value: `**${banned.length}**`, inline: true },
        { name: 'Unbans / expired', value: `**${lifted.length}**`, inline: true },
        { name: 'Still banned', value: `**${banned.filter(r => r.status === 'banned').length}**`, inline: true },
        { name: 'By type', value: types },
        { name: 'Most bans', value: mods },
    ).setFooter({ text: 'From the ban log · automatic and unverified bans are not credited to anyone' });
    await i.editReply({ embeds: [e], allowedMentions: { parse: [] } });
});
