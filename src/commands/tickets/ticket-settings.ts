import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { ticketConfig, updateTicketConfig } from '../../features/tickets.js';

/** /ticket settings — the desk settings for this server. Running it with no options shows them. */
export default defineCommand(new SlashCommandBuilder().setName('ticket-settings').setDescription('View or change this server’s ticket settings')
    .addIntegerOption(o => o.setName('ticket_limit').setDescription('How many tickets one person can have open at once').setMinValue(1).setMaxValue(10))
    .addIntegerOption(o => o.setName('autoclose_hours').setDescription('Close quiet tickets after this many hours (0 turns it off)').setMinValue(0).setMaxValue(720))
    .addBooleanOption(o => o.setName('dm_transcripts').setDescription('DM the member their transcript when a ticket closes'))
    .addBooleanOption(o => o.setName('ask_rating').setDescription('Ask members to rate the help after a ticket closes'))
    .addBooleanOption(o => o.setName('weekly_report').setDescription('Post a weekly ticket report in the log channel'))
    .addRoleOption(o => o.setName('staff_role').setDescription('Change which role counts as ticket staff'))
    .addChannelOption(o => o.setName('log_channel').setDescription('Change where transcripts and logs go').addChannelTypes(ChannelType.GuildText))
    .addChannelOption(o => o.setName('category').setDescription('Change where ticket channels are created').addChannelTypes(ChannelType.GuildCategory)),
    { category: 'tickets', cooldown: 1500, requiredPermissions: [PermissionFlagsBits.ManageGuild] }, async (ctx, i) => {
    const staffRole = i.options.getRole('staff_role');
    if (staffRole && (staffRole.id === i.guild.roles.everyone.id || staffRole.managed))
        throw new AppError('VALIDATION_ERROR', "Pick a real staff role (not @everyone or a bot's role).");
    const changes = {
        ticketLimit: i.options.getInteger('ticket_limit') ?? undefined,
        autocloseHours: i.options.getInteger('autoclose_hours') ?? undefined,
        dmTranscripts: i.options.getBoolean('dm_transcripts') ?? undefined,
        askRating: i.options.getBoolean('ask_rating') ?? undefined,
        weeklyReport: i.options.getBoolean('weekly_report') ?? undefined,
        staffRoleId: staffRole?.id,
        logChannelId: i.options.getChannel('log_channel')?.id,
        categoryId: i.options.getChannel('category')?.id,
    };
    const changed = Object.values(changes).some(v => v !== undefined);
    const config = changed
        ? updateTicketConfig(ctx.store, i.guildId, Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) as any, i.user.id)
        : ticketConfig(ctx.store, i.guildId);
    const on = (value: boolean) => value ? 'On' : 'Off';
    const line = (label: string, value: string) => `**${label}:** ${value}`;
    return [
        changed ? '⚙️ **Settings updated**' : '⚙️ **Current ticket settings**',
        line('Staff role', config.staffRoleId ? `<@&${config.staffRoleId}>` : 'Not set — run `/ticket setup`'),
        line('Log channel', config.logChannelId ? `<#${config.logChannelId}>` : 'Not set'),
        line('Ticket category', config.categoryId ? `<#${config.categoryId}>` : 'Not set'),
        line('Tickets per member', String(config.ticketLimit)),
        line('Auto-close', config.autocloseHours ? `${config.autocloseHours}h of silence` : 'Off'),
        line('DM transcripts', on(config.dmTranscripts)),
        line('Ratings', on(config.askRating)),
        line('Weekly report', on(config.weeklyReport)),
        '-# Tickets open from the panel; staff answer them with `/ticket`.',
    ].join('\n');
});
