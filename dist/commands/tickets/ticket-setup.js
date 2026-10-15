import { ChannelType, Colors, PermissionFlagsBits, PermissionsBitField, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { postTicketPanel, seedTicketTypes, TICKET_CATEGORY, TICKET_LOG_CHANNEL, TICKET_PANEL_CHANNEL, TICKET_STAFF_ROLE, ticketConfig, ticketTypes, updateTicketConfig, } from '../../features/tickets.js';
/**
 * /ticket setup — one command that creates everything the desk needs: the staff role, a category,
 * a log channel and the panel channel with the ticket menu. Safe to run again: it reuses what
 * already exists instead of making duplicates.
 */
const NEEDED = [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.ReadMessageHistory];
const permissionList = (bits) => bits.map(p => new PermissionsBitField(p).toArray().join(' ')).map(p => p.replace(/([a-z])([A-Z])/g, '$1 $2')).join(', ');
async function hasLivePanel(guild, store) {
    for (const row of store.all('SELECT message_id,channel_id FROM ticket_panels WHERE guild_id=?', guild.id)) {
        const channel = guild.channels.cache.get(String(row.channel_id)) ?? await guild.channels.fetch(String(row.channel_id)).catch(() => null);
        if (!channel?.isTextBased() || !('messages' in channel)) {
            store.run('DELETE FROM ticket_panels WHERE guild_id=? AND message_id=?', guild.id, row.message_id);
            continue;
        }
        if (await channel.messages.fetch(String(row.message_id)).catch(() => null))
            return true;
        store.run('DELETE FROM ticket_panels WHERE guild_id=? AND message_id=?', guild.id, row.message_id);
    }
    return false;
}
export default defineCommand(new SlashCommandBuilder().setName('ticket-setup').setDescription('Set up the ticket desk: staff role, category, log channel and the ticket panel')
    .addRoleOption(o => o.setName('staff_role').setDescription("Your staff role (left empty, one called 'Ticket Staff' is created)"))
    .addChannelOption(o => o.setName('panel_channel').setDescription('Where members open tickets (left empty, #open-a-ticket is created)').addChannelTypes(ChannelType.GuildText))
    .addChannelOption(o => o.setName('category').setDescription('Category for ticket channels (left empty, one called Tickets is created)').addChannelTypes(ChannelType.GuildCategory))
    .addChannelOption(o => o.setName('log_channel').setDescription('Where transcripts and logs go (left empty, #ticket-logs is created)').addChannelTypes(ChannelType.GuildText)), { category: 'tickets', cooldown: 5000, requiredPermissions: [PermissionFlagsBits.ManageGuild],
    botPermissions: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles] }, async (ctx, i) => {
    const guild = i.guild;
    const me = guild.members.me ?? await guild.members.fetchMe();
    const missing = me.permissions.has(PermissionFlagsBits.Administrator) ? [] : NEEDED.filter(p => !me.permissions.has(p));
    if (missing.length)
        throw new AppError('PERMISSION_ERROR', "I'm missing permissions for the ticket desk. Give my role these, then run `/ticket setup` again:\n"
            + `• ${permissionList(missing)}`);
    let staffRole = i.options.getRole('staff_role');
    if (staffRole && (staffRole.id === guild.roles.everyone.id || staffRole.managed))
        throw new AppError('VALIDATION_ERROR', "Pick a real staff role (not @everyone or a bot's role).");
    const config = ticketConfig(ctx.store, guild.id);
    const created = [];
    if (!staffRole && config.staffRoleId)
        staffRole = guild.roles.cache.get(config.staffRoleId) ?? null;
    if (!staffRole) {
        staffRole = await guild.roles.create({ name: TICKET_STAFF_ROLE, color: Colors.Blurple, mentionable: true, reason: `Ghost Vanguard ticket desk setup by ${i.user.tag}` });
        created.push(`Role <@&${staffRole.id}>`);
    }
    let category = i.options.getChannel('category');
    if (!category && config.categoryId) {
        const existing = guild.channels.cache.get(config.categoryId);
        category = existing?.type === ChannelType.GuildCategory ? existing : null;
    }
    if (!category) {
        category = await guild.channels.create({ name: TICKET_CATEGORY, type: ChannelType.GuildCategory, reason: 'Ghost Vanguard ticket desk setup',
            permissionOverwrites: [
                { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: staffRole.id, allow: [PermissionFlagsBits.ViewChannel] },
                { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels] },
            ] });
        created.push(`Category **${category.name}**`);
    }
    let logChannel = i.options.getChannel('log_channel');
    let createdLog = false;
    if (!logChannel && config.logChannelId) {
        const existing = guild.channels.cache.get(config.logChannelId);
        logChannel = existing?.type === ChannelType.GuildText ? existing : null;
    }
    if (!logChannel) {
        logChannel = await guild.channels.create({ name: TICKET_LOG_CHANNEL, type: ChannelType.GuildText, parent: category.id, reason: 'Ghost Vanguard ticket desk setup',
            permissionOverwrites: [
                { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: staffRole.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
                { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles] },
            ] });
        createdLog = true;
    }
    updateTicketConfig(ctx.store, guild.id, { staffRoleId: staffRole.id, categoryId: category.id, logChannelId: logChannel.id }, i.user.id);
    if (!ticketTypes(ctx.store, guild.id).length)
        seedTicketTypes(ctx.store, guild.id);
    let panelChannel = i.options.getChannel('panel_channel');
    let panelLine;
    if (panelChannel || !await hasLivePanel(guild, ctx.store)) {
        if (!panelChannel) {
            panelChannel = await guild.channels.create({ name: TICKET_PANEL_CHANNEL, type: ChannelType.GuildText, position: 0, reason: 'Ghost Vanguard ticket desk setup',
                permissionOverwrites: [
                    { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages] },
                    { id: me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] },
                ] });
            created.push(`Channel <#${panelChannel.id}>`);
        }
        updateTicketConfig(ctx.store, guild.id, { panelChannelId: panelChannel.id }, i.user.id);
        if (!panelChannel.permissionsFor(me)?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]))
            panelLine = `⚠️ I can't post the ticket menu in <#${panelChannel.id}>. Check my permissions there.`;
        else {
            const message = await postTicketPanel(ctx.store, guild, panelChannel, ticketTypes(ctx.store, guild.id));
            panelLine = `[Posted in <#${panelChannel.id}>](${message.url})`;
        }
    }
    else
        panelLine = 'Already posted (use `/ticket panel` to post another)';
    if (createdLog)
        created.push(`Channel <#${logChannel.id}>`);
    return [
        '✅ **The ticket desk is ready.**',
        `**Staff role:** <@&${staffRole.id}> · **Ticket category:** ${category.name} · **Log channel:** <#${logChannel.id}>`,
        `**Ticket menu:** ${panelLine}`,
        created.length ? `**Created:** ${created.join(' · ')}` : '',
        '**Next steps**',
        `• Give <@&${staffRole.id}> to your staff so they can see and answer tickets`,
        '• Change the ticket types with `/ticket types` and the limits with `/ticket settings`',
        '• Members open tickets from the menu in the panel channel; staff use `/ticket`',
    ].filter(Boolean).join('\n');
});
