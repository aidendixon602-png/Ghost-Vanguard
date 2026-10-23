import { Colors, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { confirmDanger } from '../../ui/danger-ui.js';
import { logsCategory, recordEvent } from '../../audit/event-log.js';
import { lockGuild } from '../../security/lockdown.js';
import { embed } from '../../ui/ui.js';

export const DEFAULT_NOTICE = 'This server is in lockdown. Messages are paused until staff lift it. Thanks for your patience.';

export default defineCommand(new SlashCommandBuilder().setName('lockdown').setDescription('Lock every channel and post a notice; /raid unlock restores everything exactly')
    .addStringOption(o => o.setName('message').setDescription('Notice posted in every public text channel').setMaxLength(1000))
    .addStringOption(o => o.setName('reason').setDescription('Reason for the audit log and security log').setMaxLength(300)), { category: 'security', access: 'security', requiredPermissions: [PermissionFlagsBits.ManageChannels], botPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] }, async (ctx, i) => {
    const notice = i.options.getString('message') ?? DEFAULT_NOTICE;
    const reason = i.options.getString('reason') ?? 'No reason given';
    const channels = i.guild.channels.cache.filter((c: any) => c.manageable !== false).size;
    await confirmDanger(ctx, i, {
        title: 'Lock down the entire server',
        summary: `**${i.guild.name}** · roughly **${channels}** channel(s) affected.`,
        consequences: [
            'Every channel is locked for @everyone at once, including voice.',
            'A notice is posted in every public text channel.',
            'Staff roles (Administrator, Manage Server, Manage Channels, Manage Messages, Timeout Members) keep their access.',
            'Members cannot speak anywhere until it is undone.',
        ],
        label: 'Lock the server',
        reversal: '`/raid unlock` restores every channel exactly as it was, including permission edits staff make while locked.',
        run: (c: any, b: any) => lockdown(c, b, notice, reason),
    });
});

async function lockdown(ctx: any, i: any, notice: string, reason: string) {
    const progress = (done: number, total: number) => i.editReply({ embeds: [embed('🔒 Locking channels…', `${done} of ${total} done`, Colors.Orange)] }).then(() => { });
    const result = await ctx.snapshots.locks.run([i.guildId], () => lockGuild(ctx, i.guild, i.user.id, notice, reason, progress));
    const summary = `**${result.locked}** of ${result.total} channels locked · **${result.notices}** notices posted${result.skipped ? ` · ${result.skipped} skipped (Vanguard can't manage them)` : ''}${result.failed ? ` · ${result.failed} failed` : ''}`;
    const event = { category: 'moderation' as const, action: 'Server locked down', actorId: i.user.id, details: [summary, `**Reason:** ${reason}`] };
    if (!logsCategory(ctx.store, i.guildId, 'moderation') || !recordEvent(ctx.store, ctx.logs, i.guildId, event))
        ctx.logs.push(i.guildId, embed('🔒 Server locked down', `By <@${i.user.id}>\n${summary}\n**Reason:** ${reason}`, Colors.Red));
    return `${summary}.\nStaff roles (Administrator, Manage Server, Manage Channels, Manage Messages, Timeout Members) keep their access. Run \`/raid unlock\` to restore every channel exactly as it was.`;
}
