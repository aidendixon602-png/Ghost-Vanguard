import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { reportEmbed, ticketStats, weeklyReport } from '../../features/tickets.js';

/** /ticket stats — all-time numbers plus the staff leaderboard, and the last 7 days underneath. */
export default defineCommand(new SlashCommandBuilder().setName('ticket-stats').setDescription('Ticket statistics and the staff leaderboard')
    .addBooleanOption(o => o.setName('weekly').setDescription('Show the last 7 days instead of all time')),
    { category: 'tickets', cooldown: 2000, requiredPermissions: [PermissionFlagsBits.ManageGuild] }, async (ctx, i) => {
    if (i.options.getBoolean('weekly')) {
        const card = reportEmbed(i.guild, weeklyReport(ctx.store, i.guildId));
        await i.editReply({ embeds: [card] });
        return;
    }
    const stats = ticketStats(ctx.store, i.guildId);
    const medals = ['🥇', '🥈', '🥉'];
    const leaderboard = stats.staff.map((row, index) =>
        `${medals[index] ?? `\`#${index + 1}\``} <@${row.claimed_by}> · ${row.c} ticket${Number(row.c) === 1 ? '' : 's'}${row.r ? ` · ${Number(row.r).toFixed(1)} ⭐` : ''}`).join('\n');
    return [
        '📊 **Ticket statistics**',
        `**Total tickets:** ${stats.total} · **Open now:** ${stats.open} · **Closed:** ${stats.closed}`,
        `**Average rating:** ${stats.average === null ? 'No ratings yet' : `${stats.average.toFixed(2)} ⭐ (${stats.ratingCount} rating${stats.ratingCount === 1 ? '' : 's'})`}`,
        `**Staff leaderboard**`,
        leaderboard || 'No claimed tickets yet.',
    ].join('\n');
});
