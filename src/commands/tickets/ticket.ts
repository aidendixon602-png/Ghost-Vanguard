import { Colors, PermissionFlagsBits, SlashCommandBuilder, type GuildMember, type TextChannel } from 'discord.js';
import { defineCommand, type CommandContext } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { clip } from '../../core.js';
import { embed } from '../../ui/ui.js';
import {
    activeTicketPriority, blockedUsers, blockUser, claimTicket, closeRequestControls, closeTicket, isTicketStaff, openTicketIn, PRIORITIES,
    requireTicketStaff, slugify, stripPriority, ticketConfig, ticketCount, ticketHistory, ticketLog, updateClaimButton, withPriority,
} from '../../features/tickets.js';

/**
 * /ticket — the staff side of the support desk: claim, transfer, priority, close, close requests,
 * history and the per-server ticket blocks. Members can close their own ticket; everything else
 * needs the ticket staff role, Manage Server or a Vanguard rank.
 */

function requireTicket(ctx: CommandContext, i: any, staffOnly = true) {
    const ticket = openTicketIn(ctx.store, i.guildId, i.channelId);
    if (!ticket)
        throw new AppError('VALIDATION_ERROR', 'Use this inside an open ticket channel.');
    if (staffOnly)
        requireTicketStaff(ctx.store, i.guildId, i.user.id, ctx.actor);
    else if (ticket.user_id !== i.user.id && !isTicketStaff(ctx.store, i.guildId, i.user.id, ctx.actor))
        throw new AppError('PERMISSION_ERROR', "You don't have permission to do that.");
    return ticket;
}

/** Discord only allows two channel renames every 10 minutes; never let that hang the command. */
async function rename(channel: TextChannel, name: string) {
    if (channel.name === name)
        return true;
    const timeout = new Promise<false>(resolve => { const timer = setTimeout(() => resolve(false), 8000); timer.unref?.(); });
    try {
        return await Promise.race([channel.setName(name).then(() => true), timeout]);
    } catch {
        return false;
    }
}

const RENAME_LIMIT = 'Discord allows 2 channel renames every 10 minutes, so the name could not be updated right now. Try again in a few minutes.';

/** The public half of claim/transfer/unclaim: a message in the ticket, the buttons, and the log. */
async function announceClaim(ctx: CommandContext, i: any, ticket: any, member: GuildMember | null) {
    const previous = ticket.claimed_by;
    if (!claimTicket(ctx.store, i.guildId, ticket, member, previous))
        throw new AppError('RATE_LIMIT_ERROR', 'This ticket changed while you were acting. Please try again.');
    await updateClaimButton(i.channel, ticket, member?.displayName ?? null);
    const text = member === null
        ? `↩️ <@${i.user.id}> unclaimed this ticket. Any staff member can pick it up.`
        : previous ? `🔁 This ticket was transferred to <@${member.id}>.` : `🙋 <@${member.id}> claimed this ticket and will be helping you.`;
    await (i.channel as TextChannel).send({ embeds: [embed('Ticket update', text, member === null ? Colors.DarkGrey : Colors.Green)], allowedMentions: { parse: [] } }).catch(() => {});
    const number = String(ticket.number).padStart(4, '0');
    await ticketLog(i.guild, ticketConfig(ctx.store, i.guildId), { embeds: [embed(`🙋 Ticket #${number} ${member === null ? 'unclaimed' : previous ? 'transferred' : 'claimed'}`,
        `${previous ? `**From:** <@${previous}>\n` : ''}**${previous ? 'To' : 'Staff'}:** ${member ? `<@${member.id}>` : 'Nobody'}\n**By:** <@${i.user.id}>\n**Channel:** <#${i.channelId}>`, Colors.Yellow)] });
}

export default defineCommand(new SlashCommandBuilder().setName('ticket').setDescription('Support tickets: manage the ticket you are in')
    .addSubcommand(s => s.setName('claim').setDescription('Claim this ticket so you are the one handling it'))
    .addSubcommand(s => s.setName('unclaim').setDescription('Release this ticket so another staff member can take it'))
    .addSubcommand(s => s.setName('transfer').setDescription('Hand this ticket to another staff member')
        .addUserOption(o => o.setName('staff').setDescription('Who should take over').setRequired(true)))
    .addSubcommand(s => s.setName('priority').setDescription('Set how urgent this ticket is')
        .addStringOption(o => o.setName('level').setDescription('Urgent also pings the ticket staff role').setRequired(true)
            .addChoices(...Object.entries(PRIORITIES).map(([value, p]) => ({ name: p.label, value })))))
    .addSubcommand(s => s.setName('close').setDescription('Close this ticket and save the transcript')
        .addStringOption(o => o.setName('reason').setDescription('Why it is closing').setMaxLength(300)))
    .addSubcommand(s => s.setName('closerequest').setDescription('Ask the member if their issue is solved and the ticket can close')
        .addStringOption(o => o.setName('note').setDescription('Optional message for the member').setMaxLength(500)))
    .addSubcommand(s => s.setName('add').setDescription('Add someone to this ticket')
        .addUserOption(o => o.setName('member').setDescription('Who to add').setRequired(true)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove someone from this ticket')
        .addUserOption(o => o.setName('member').setDescription('Who to remove').setRequired(true)))
    .addSubcommand(s => s.setName('rename').setDescription('Rename this ticket channel')
        .addStringOption(o => o.setName('name').setDescription('New name').setRequired(true).setMaxLength(90)))
    .addSubcommand(s => s.setName('history').setDescription("See a member's past tickets in this server")
        .addUserOption(o => o.setName('member').setDescription('Whose history').setRequired(true)))
    .addSubcommand(s => s.setName('block').setDescription('Stop a member from opening tickets in this server')
        .addUserOption(o => o.setName('member').setDescription('Who to block').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Why (shown to them)').setMaxLength(300)))
    .addSubcommand(s => s.setName('unblock').setDescription('Let a blocked member open tickets again')
        .addUserOption(o => o.setName('member').setDescription('Who to unblock').setRequired(true)))
    .addSubcommand(s => s.setName('blocked').setDescription('List members blocked from opening tickets')),
    { category: 'tickets', cooldown: 1500, botPermissions: [PermissionFlagsBits.ManageChannels] }, async (ctx, i) => {
    const sub = i.options.getSubcommand(true);
    const channel = i.channel as TextChannel | null;
    if (!channel?.isTextBased())
        throw new AppError('VALIDATION_ERROR', 'Use this in a normal text channel.');

    if (sub === 'claim') {
        const ticket = requireTicket(ctx, i);
        if (ticket.claimed_by)
            throw new AppError('VALIDATION_ERROR', `Already claimed by <@${ticket.claimed_by}>. Use \`/ticket transfer\` instead.`);
        await announceClaim(ctx, i, ticket, ctx.actor ?? null);
        return '✅ Claimed. You are now the staff member handling this ticket.';
    }

    if (sub === 'unclaim') {
        const ticket = requireTicket(ctx, i);
        if (!ticket.claimed_by)
            throw new AppError('VALIDATION_ERROR', 'Nobody has claimed this ticket.');
        if (ticket.claimed_by !== i.user.id && !ctx.actor?.permissions.has(PermissionFlagsBits.ManageGuild))
            throw new AppError('PERMISSION_ERROR', 'Only the staff member who claimed it (or an admin) can unclaim it.');
        await announceClaim(ctx, i, ticket, null);
        return '✅ Unclaimed. Any staff member can pick it up.';
    }

    if (sub === 'transfer') {
        const ticket = requireTicket(ctx, i);
        const member = i.options.getMember('staff') as GuildMember | null;
        if (!member || member.user.bot || !isTicketStaff(ctx.store, i.guildId, member.id, member))
            throw new AppError('VALIDATION_ERROR', `${member ? `<@${member.id}>` : 'That member'} is not on the ticket staff team.`);
        if (ticket.claimed_by === member.id)
            throw new AppError('VALIDATION_ERROR', `<@${member.id}> already has this ticket.`);
        await announceClaim(ctx, i, ticket, member);
        return `✅ Transferred to <@${member.id}>.`;
    }

    if (sub === 'priority') {
        const ticket = requireTicket(ctx, i);
        const level = i.options.getString('level', true) as keyof typeof PRIORITIES;
        if (activeTicketPriority(ticket) === level)
            throw new AppError('VALIDATION_ERROR', `This ticket is already **${PRIORITIES[level].label}**.`);
        ctx.store.run('UPDATE ticket_records SET priority=? WHERE guild_id=? AND id=?', level, i.guildId, ticket.id);
        const renamed = await rename(channel, withPriority(stripPriority(channel.name), level));
        const config = ticketConfig(ctx.store, i.guildId);
        const staffRole = config.staffRoleId ? i.guild.roles.cache.get(config.staffRoleId) : null;
        const ping = level === 'urgent' && staffRole ? staffRole.id : null;
        await channel.send({ content: ping ? `<@&${ping}>` : '',
            embeds: [embed('Priority updated', `Priority set to **${PRIORITIES[level].label}** by <@${i.user.id}>.`, PRIORITIES[level].color)],
            allowedMentions: { roles: ping ? [ping] : [] } }).catch(() => {});
        await ticketLog(i.guild, config, { embeds: [embed(`Ticket #${String(ticket.number).padStart(4, '0')} priority: ${PRIORITIES[level].label}`,
            `**Channel:** <#${channel.id}>\n**By:** <@${i.user.id}>`, PRIORITIES[level].color)] });
        return `✅ Priority updated.${renamed ? '' : `\n-# ${RENAME_LIMIT}`}`;
    }

    if (sub === 'close') {
        const ticket = requireTicket(ctx, i, false);
        const reason = i.options.getString('reason')?.trim() || 'No reason given';
        await closeTicket({ store: ctx.store, guild: i.guild, channel, ticket, closer: i.user, reason, config: ticketConfig(ctx.store, i.guildId), client: ctx.client });
        return `🔒 Closed ticket #${String(ticket.number).padStart(4, '0')}. The transcript went to the ticket log channel and the member's DMs; this channel is deleted in a few seconds.`;
    }

    if (sub === 'closerequest') {
        const ticket = requireTicket(ctx, i);
        const note = i.options.getString('note')?.trim();
        await channel.send({ content: `<@${ticket.user_id}>`,
            embeds: [embed('❓ Can we close this ticket?', `${note ? `${clip(note, 500)}\n\n` : ''}<@${i.user.id}> thinks your issue is solved. Can we close this ticket?`, Colors.Yellow)],
            components: closeRequestControls(), allowedMentions: { users: [ticket.user_id] } })
            .catch(() => { throw new AppError('PERMISSION_ERROR', "I couldn't post in this channel. Check my Send Messages permission."); });
        return '✅ Close request sent.';
    }

    if (sub === 'add') {
        requireTicket(ctx, i);
        const member = i.options.getMember('member') as GuildMember | null;
        if (!member)
            throw new AppError('VALIDATION_ERROR', 'That member is not in this server.');
        await channel.permissionOverwrites.edit(member, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true });
        await channel.send({ embeds: [embed('Member added', `➕ Added <@${member.id}> to the ticket.`, Colors.Green)], allowedMentions: { parse: [] } }).catch(() => {});
        return `✅ Added <@${member.id}> to the ticket.`;
    }

    if (sub === 'remove') {
        const ticket = requireTicket(ctx, i);
        const member = i.options.getMember('member') as GuildMember | null;
        if (!member)
            throw new AppError('VALIDATION_ERROR', 'That member is not in this server.');
        if (member.id === ticket.user_id)
            throw new AppError('VALIDATION_ERROR', 'You cannot remove the person who opened the ticket.');
        await channel.permissionOverwrites.delete(member).catch(() => {});
        await channel.send({ embeds: [embed('Member removed', `➖ Removed <@${member.id}> from the ticket.`, Colors.Orange)], allowedMentions: { parse: [] } }).catch(() => {});
        return `✅ Removed <@${member.id}> from the ticket.`;
    }

    if (sub === 'rename') {
        const ticket = requireTicket(ctx, i);
        const name = i.options.getString('name', true);
        if (!await rename(channel, withPriority(slugify(name), activeTicketPriority(ticket))))
            throw new AppError('RATE_LIMIT_ERROR', RENAME_LIMIT);
        return '✅ Renamed.';
    }

    if (sub === 'history') {
        requireTicketStaff(ctx.store, i.guildId, i.user.id, ctx.actor);
        const member = i.options.getMember('member') as GuildMember | null;
        if (!member)
            throw new AppError('VALIDATION_ERROR', 'That member is not in this server.');
        const rows = ticketHistory(ctx.store, i.guildId, member.id);
        const total = ticketCount(ctx.store, i.guildId, member.id);
        const status = { open: '🟢', closing: '🟡', closed: '⚫' } as const;
        const lines = rows.map(t => {
            const where = t.status === 'open' ? `<#${t.channel_id}>` : `#${String(t.number).padStart(4, '0')}`;
            const prefix = PRIORITIES[activeTicketPriority(t)].prefix;
            return `${status[t.status]} ${where} · ${t.type} · <t:${Math.floor(t.opened_at / 1000)}:R>`
                + `${prefix ? ` · ${prefix}` : ''}${t.rating ? ` · ${t.rating}⭐` : ''}`
                + `${t.subject ? `\n   ${clip(t.subject, 80)}` : ''}`;
        });
        const card = embed(`🗂️ Tickets from ${member.displayName} (${total})`, lines.join('\n') || 'No tickets yet.');
        const block = ctx.store.get('SELECT * FROM ticket_blocks WHERE guild_id=? AND user_id=?', i.guildId, member.id);
        if (block)
            card.addFields({ name: '⛔ Blocked from tickets', value: block.reason || 'No reason given' });
        card.setThumbnail(member.displayAvatarURL());
        await i.editReply({ embeds: [card] });
        return;
    }

    if (sub === 'block') {
        requireTicketStaff(ctx.store, i.guildId, i.user.id, ctx.actor);
        const member = i.options.getMember('member') as GuildMember | null;
        if (!member)
            throw new AppError('VALIDATION_ERROR', 'That member is not in this server.');
        if (member.user.bot || isTicketStaff(ctx.store, i.guildId, member.id, member))
            throw new AppError('VALIDATION_ERROR', "You can't block bots or ticket staff.");
        const reason = i.options.getString('reason')?.trim() || null;
        blockUser(ctx.store, i.guildId, member.id, reason, i.user.id);
        await ticketLog(i.guild, ticketConfig(ctx.store, i.guildId), { embeds: [embed('⛔ Member blocked from tickets', `**Member:** <@${member.id}>\n**By:** <@${i.user.id}>\n**Reason:** ${reason ?? 'No reason given'}`, Colors.Red)] });
        return `⛔ <@${member.id}> can no longer open tickets here.`;
    }

    if (sub === 'unblock') {
        requireTicketStaff(ctx.store, i.guildId, i.user.id, ctx.actor);
        const member = i.options.getMember('member') as GuildMember | null;
        if (!member)
            throw new AppError('VALIDATION_ERROR', 'That member is not in this server.');
        if (!ctx.store.run('DELETE FROM ticket_blocks WHERE guild_id=? AND user_id=?', i.guildId, member.id).changes)
            throw new AppError('VALIDATION_ERROR', `<@${member.id}> isn't blocked from tickets.`);
        await ticketLog(i.guild, ticketConfig(ctx.store, i.guildId), { embeds: [embed('✅ Member unblocked from tickets', `**Member:** <@${member.id}>\n**By:** <@${i.user.id}>`, Colors.Green)] });
        return `✅ <@${member.id}> can open tickets again.`;
    }

    requireTicketStaff(ctx.store, i.guildId, i.user.id, ctx.actor);
    const rows = blockedUsers(ctx.store, i.guildId);
    return `**⛔ Blocked from tickets (${rows.length})**\n`
        + (rows.slice(0, 30).map(r => `<@${r.user_id}> — ${r.reason ?? 'no reason'} (by <@${r.by_id}>)`).join('\n') || 'Nobody is blocked from opening tickets.');
});
