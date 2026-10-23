import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { staffReason } from '../../security/raidmode.js';

const CHOICES = [['Off', 0], ['5 seconds', 5], ['10 seconds', 10], ['30 seconds', 30], ['1 minute', 60], ['5 minutes', 300], ['15 minutes', 900], ['1 hour', 3600], ['6 hours', 21600]] as const;

export default defineCommand(new SlashCommandBuilder().setName('slowmode').setDescription('Set how often members can send messages in a channel')
    .addIntegerOption(o => o.setName('delay').setDescription('Time between messages').setRequired(true).addChoices(...CHOICES.map(([name, value]) => ({ name, value }))))
    .addChannelOption(o => o.setName('channel').setDescription('Channel (default: this one)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildVoice)),
{ category: 'security', access: 'member', requiredPermissions: [PermissionFlagsBits.ManageChannels], botPermissions: [PermissionFlagsBits.ManageChannels], cooldown: 3000 }, async (ctx, i) => {
    const delay = i.options.getInteger('delay', true), chosen = i.options.getChannel('channel') ?? i.channel;
    const channel = chosen ? await i.guild.channels.fetch(chosen.id).catch(() => null) : null;
    if (!channel || !('setRateLimitPerUser' in channel)) throw new AppError('VALIDATION_ERROR', 'Choose a text, announcement, forum or voice channel.');
    if (!channel.permissionsFor(ctx.actor!)?.has(PermissionFlagsBits.ManageChannels)) throw new AppError('PERMISSION_ERROR', 'You need Manage Channels in that channel.');
    await (channel as any).setRateLimitPerUser(delay, staffReason(ctx.actor!.id, `/mod slowmode ${delay}s`));
    const label = CHOICES.find(([, v]) => v === delay)?.[0] ?? `${delay} seconds`;
    return delay ? `Slowmode in <#${channel.id}> set to **${label}**.` : `Slowmode **off** in <#${channel.id}>.`;
});
