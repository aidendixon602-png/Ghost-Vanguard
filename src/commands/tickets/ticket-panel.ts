import { ChannelType, PermissionFlagsBits, SlashCommandBuilder, type TextChannel } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { postTicketPanel, TICKET_PANEL_TEXT, TICKET_PANEL_TITLE, ticketConfig, ticketTypes } from '../../features/tickets.js';

/** /ticket panel — post the menu members use to open tickets, in this channel or another one. */
export default defineCommand(new SlashCommandBuilder().setName('ticket-panel').setDescription('Post the ticket menu members use to open tickets')
    .addChannelOption(o => o.setName('channel').setDescription('Where to post it (defaults to this channel)').addChannelTypes(ChannelType.GuildText))
    .addStringOption(o => o.setName('title').setDescription('Panel title').setMaxLength(256))
    .addStringOption(o => o.setName('description').setDescription('Panel text (use \\n for a new line)').setMaxLength(2000)),
    { category: 'tickets', cooldown: 5000, requiredPermissions: [PermissionFlagsBits.ManageGuild],
        botPermissions: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] }, async (ctx, i) => {
    const config = ticketConfig(ctx.store, i.guildId);
    if (!config.staffRoleId)
        throw new AppError('VALIDATION_ERROR', 'Run `/ticket setup` first, so the desk knows which role is staff.');
    const channel = (i.options.getChannel('channel') ?? i.channel) as TextChannel | null;
    if (!channel?.isTextBased() || channel.type !== ChannelType.GuildText)
        throw new AppError('VALIDATION_ERROR', 'Pick a normal text channel.');
    const me = i.guild.members.me ?? await i.guild.members.fetchMe();
    if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]))
        throw new AppError('PERMISSION_ERROR', `I can't send messages or embeds in <#${channel.id}>.`);
    const types = ticketTypes(ctx.store, i.guildId);
    if (!types.length)
        throw new AppError('VALIDATION_ERROR', 'This server has no ticket types. Add one with `/ticket types add`, or reset them with `/ticket types reset`.');
    const message = await postTicketPanel(ctx.store, i.guild, channel, types,
        i.options.getString('title')?.trim() || TICKET_PANEL_TITLE,
        (i.options.getString('description')?.trim() || TICKET_PANEL_TEXT).replace(/\\n/g, '\n'));
    return `✅ Ticket menu posted in <#${channel.id}>.\n[Open the panel](${message.url})`;
});
