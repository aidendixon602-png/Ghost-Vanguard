import { Colors, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { logsCategory, recordEvent } from '../../audit/event-log.js';
import { unlockGuild } from '../../security/lockdown.js';
import { embed } from '../../ui/ui.js';

export default defineCommand(new SlashCommandBuilder().setName('unlock').setDescription('End the lockdown and restore every channel exactly as it was')
    .addStringOption(o => o.setName('message').setDescription('Optional message posted where the lockdown notices were').setMaxLength(1000))
    .addBooleanOption(o => o.setName('keep_notices').setDescription('Keep the lockdown notices instead of deleting them')), { category: 'security', access: 'security', requiredPermissions: [PermissionFlagsBits.ManageChannels], botPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles] }, async (ctx, i) => {
    const progress = (done: number, total: number) => i.editReply({ embeds: [embed('🔓 Restoring channels…', `${done} of ${total} done`, Colors.Orange)] }).then(() => { });
    const result = await ctx.snapshots.locks.run([i.guildId], () => unlockGuild(ctx, i.guild, i.user.id, i.options.getString('message'), !i.options.getBoolean('keep_notices'), progress));
    const summary = `**${result.restored}** of ${result.total} channels restored${result.noticesRemoved ? ` · ${result.noticesRemoved} notices removed` : ''}${result.messages ? ` · ${result.messages} messages posted` : ''}${result.missing ? ` · ${result.missing} deleted during the lockdown` : ''}`;
    if (result.failed)
        return `${summary} · **${result.failed} could not be restored yet.** The lockdown stays recorded; run \`/raid unlock\` again (check that Vanguard can still manage those channels).`;
    const event = { category: 'moderation' as const, action: 'Lockdown lifted', actorId: i.user.id, details: [summary] };
    if (!logsCategory(ctx.store, i.guildId, 'moderation') || !recordEvent(ctx.store, ctx.logs, i.guildId, event))
        ctx.logs.push(i.guildId, embed('🔓 Lockdown lifted', `By <@${i.user.id}>\n${summary}`, Colors.Green));
    return `${summary}. Every permission the lockdown changed is back exactly as it was; any other permission edits staff made during the lockdown are kept.`;
});
