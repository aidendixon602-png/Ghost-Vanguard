import { ActionRowBuilder, Colors, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { defaults } from '../bot/registry.js';
import { AppError } from '../errors.js';
import { clip } from '../core.js';
import { embed } from './ui.js';
import { blockedFromTickets, claimTicket, closeTicket, cooldownLeft, openTicket, openTicketIn, openTicketsFor, requireTicketStaff, isTicketStaff, ticketConfig, ticketLog, ticketTypes, updateClaimButton, } from '../features/tickets.js';
/**
 * Ticket panel, buttons and forms. Every control carries a fixed custom_id, so panels and tickets
 * keep working across restarts. Two prefixes are used so the two that must open a modal
 * (`vgticket-form:`) are left unacknowledged, while everything else is answered immediately.
 */
export const TICKET_PREFIX = 'vgticket:';
export const TICKET_FORM_PREFIX = 'vgticket-form:';
const permissionFailure = (error) => error?.code === 50013;
function openForm(type) {
    return new ModalBuilder().setCustomId(`${TICKET_PREFIX}form:${type.id}`).setTitle(clip(`${type.name} ticket`, 45)).addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('subject')
        .setLabel('What do you need help with?').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true)
        .setPlaceholder('Short summary of your issue')), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('details')
        .setLabel('Details').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(false)
        .setPlaceholder('Usernames, links, what happened, etc.')));
}
function closeForm() {
    return new ModalBuilder().setCustomId(`${TICKET_PREFIX}closeform`).setTitle('Close ticket').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason')
        .setLabel('Reason (optional)').setStyle(TextInputStyle.Short).setMaxLength(300).setRequired(false)
        .setPlaceholder('e.g. Issue resolved')));
}
/**
 * Checks a member may open a ticket right now. Throws an AppError explaining why not.
 * Shared by the panel dropdown and the form, so both answer the same way.
 */
function assertCanOpen(ctx, guildId, userId, typeId) {
    const config = ticketConfig(ctx.store, guildId);
    if (!config.staffRoleId)
        throw new AppError('VALIDATION_ERROR', 'Tickets are not set up yet. An admin needs to run `/ticket setup`.');
    const type = ticketTypes(ctx.store, guildId).find(t => t.id === typeId);
    if (!type)
        throw new AppError('VALIDATION_ERROR', 'That ticket type was removed. Please pick another one from the panel.');
    const blocked = blockedFromTickets(ctx.store, guildId, userId);
    if (blocked)
        throw new AppError('PERMISSION_ERROR', `⛔ You have been blocked from opening tickets in this server.${blocked.reason ? `\n**Reason:** ${blocked.reason}` : ''}`);
    const wait = cooldownLeft(guildId, userId);
    if (wait)
        throw new AppError('RATE_LIMIT_ERROR', `Please wait ${wait}s before opening another ticket.`);
    const existing = openTicketsFor(ctx.store, guildId, userId);
    if (existing.length >= config.ticketLimit)
        throw new AppError('RATE_LIMIT_ERROR', `You already have an open ticket: ${existing.map(r => `<#${r.channel_id}>`).join(', ')}. Close it before opening another.`);
    return { config, type };
}
/** Claim, transfer or unclaim: who holds the ticket is what the buttons and the log track. */
async function setClaim(ctx, i, ticket, member, actorId) {
    const previous = ticket.claimed_by;
    if (!claimTicket(ctx.store, i.guildId, ticket, member, previous))
        throw new AppError('RATE_LIMIT_ERROR', 'This ticket changed while you were acting. Please try again.');
    await updateClaimButton(i.channel, ticket, member?.displayName ?? null);
    const text = member === null
        ? `↩️ <@${actorId}> unclaimed this ticket. Any staff member can pick it up.`
        : previous ? `🔁 This ticket was transferred to <@${member.id}>.`
            : `🙋 <@${member.id}> claimed this ticket and will be helping you.`;
    await i.channel?.send({ embeds: [embed('Ticket update', text, member === null ? Colors.DarkGrey : Colors.Green)], allowedMentions: { parse: [] } }).catch(() => { });
    const number = String(ticket.number).padStart(4, '0');
    await ticketLog(i.guild, ticketConfig(ctx.store, i.guildId), { embeds: [embed(`🙋 Ticket #${number} ${member === null ? 'unclaimed' : previous ? 'transferred' : 'claimed'}`, `${previous ? `**From:** <@${previous}>\n` : ''}**${previous ? 'To' : 'Staff'}:** ${member ? `<@${member.id}>` : 'Nobody'}\n**By:** <@${actorId}>\n**Channel:** <#${i.channelId}>`, Colors.Yellow)] });
}
export function registerTicketControls(registry) {
    // Controls that must open a form: the panel's ticket-type dropdown and the Close button.
    registry.component({
        prefix: TICKET_FORM_PREFIX, kinds: ['select', 'button'],
        metadata: { ...defaults, category: 'tickets', deferral: 'modal', cooldown: 0, ephemeralDefault: true, responseKind: 'info' },
        execute: async (ctx, i) => {
            if (i.isStringSelectMenu()) {
                if (i.customId !== `${TICKET_FORM_PREFIX}open`)
                    throw new AppError('VALIDATION_ERROR', 'That ticket menu is no longer available. Use the panel again.');
                const { type } = assertCanOpen(ctx, i.guildId, i.user.id, Number(i.values[0]));
                await i.showModal(openForm(type));
                return;
            }
            if (i.customId === `${TICKET_FORM_PREFIX}close`) {
                const ticket = openTicketIn(ctx.store, i.guildId, i.channelId);
                if (!ticket)
                    throw new AppError('VALIDATION_ERROR', 'This channel is not an open ticket.');
                if (ticket.user_id !== i.user.id && !isTicketStaff(ctx.store, i.guildId, i.user.id, ctx.actor))
                    throw new AppError('PERMISSION_ERROR', 'Only the person who opened this ticket, or ticket staff, can close it.');
                await i.showModal(closeForm());
                return;
            }
            throw new AppError('VALIDATION_ERROR', 'Unknown ticket control.');
        },
    });
    // Everything else: claim, close requests, the two forms and rating buttons used in DMs.
    registry.component({
        prefix: TICKET_PREFIX, kinds: ['button', 'select', 'modal'],
        metadata: { ...defaults, category: 'tickets', cooldown: 0, ephemeralDefault: true },
        execute: async (ctx, i) => {
            const action = i.customId.slice(TICKET_PREFIX.length).split(':')[0];
            if (action === 'claimed')
                return '🙋 Someone already has this ticket. Use `/ticket transfer` if it should change hands.';
            if (i.isModalSubmit() && i.customId.startsWith(`${TICKET_PREFIX}form:`)) {
                const typeId = Number(i.customId.split(':')[2]);
                const { config, type } = assertCanOpen(ctx, i.guildId, i.user.id, typeId);
                const subject = i.fields.getTextInputValue('subject').trim();
                const details = i.fields.getTextInputValue('details').trim();
                if (subject.length < 3)
                    throw new AppError('VALIDATION_ERROR', 'Please describe what you need help with in a few words.');
                let created;
                try {
                    created = await openTicket({ guild: i.guild, user: i.user, type, subject, details, config, store: ctx.store });
                }
                catch (error) {
                    if (permissionFailure(error))
                        throw new AppError('PERMISSION_ERROR', "I couldn't create your ticket because I'm missing permissions here. Please tell a staff member to run `/ticket setup` again.");
                    throw error;
                }
                // The channel is created, so a failure after this point must not read as "nothing happened".
                return `✅ Your ticket is open: <#${created.channel.id}>`;
            }
            if (i.isModalSubmit() && i.customId === `${TICKET_PREFIX}closeform`) {
                const ticket = openTicketIn(ctx.store, i.guildId, i.channelId);
                if (!ticket)
                    throw new AppError('VALIDATION_ERROR', 'This ticket is already closed.');
                if (ticket.user_id !== i.user.id && !isTicketStaff(ctx.store, i.guildId, i.user.id, ctx.actor))
                    throw new AppError('PERMISSION_ERROR', 'Only the person who opened this ticket, or ticket staff, can close it.');
                const reason = i.fields.getTextInputValue('reason').trim() || 'No reason given';
                await closeTicket({ store: ctx.store, guild: i.guild, channel: i.channel, ticket, closer: i.user, reason, config: ticketConfig(ctx.store, i.guildId), client: ctx.client });
                return `🔒 Closed ticket #${String(ticket.number).padStart(4, '0')}. The transcript went to the ticket log channel and the member's DMs; the channel is deleted in a few seconds.`;
            }
            if (action === 'claim') {
                const ticket = openTicketIn(ctx.store, i.guildId, i.channelId);
                if (!ticket)
                    throw new AppError('VALIDATION_ERROR', 'This is not an open ticket.');
                requireTicketStaff(ctx.store, i.guildId, i.user.id, ctx.actor);
                if (ticket.claimed_by)
                    throw new AppError('VALIDATION_ERROR', `Already claimed by <@${ticket.claimed_by}>.`);
                await setClaim(ctx, i, ticket, ctx.actor, i.user.id);
                return '✅ Claimed. You are now the staff member handling this ticket.';
            }
            if (action === 'creq' && i.isButton()) {
                const decision = i.customId.split(':')[2];
                const ticket = openTicketIn(ctx.store, i.guildId, i.channelId);
                if (!ticket)
                    return 'This ticket is already closed.';
                if (ticket.user_id !== i.user.id && !isTicketStaff(ctx.store, i.guildId, i.user.id, ctx.actor))
                    throw new AppError('PERMISSION_ERROR', 'Only the person who opened this ticket can answer this.');
                if (decision === 'no') {
                    await i.message?.edit({ embeds: [embed('Ticket stays open', `🔓 <@${i.user.id}> wants to keep this ticket open.`, Colors.Green)], components: [] }).catch(() => { });
                    return '🔓 This ticket stays open. Do message here if you can help.';
                }
                await i.message?.edit({ embeds: [embed('Closing', `✅ <@${i.user.id}> accepted the close request.`, Colors.Green)], components: [] }).catch(() => { });
                await closeTicket({ store: ctx.store, guild: i.guild, channel: i.channel, ticket, closer: i.user, reason: 'Accepted a close request', config: ticketConfig(ctx.store, i.guildId), client: ctx.client });
                return `🔒 Closed ticket #${String(ticket.number).padStart(4, '0')} at the member's request.`;
            }
            throw new AppError('VALIDATION_ERROR', 'Unknown ticket control.');
        },
    });
}
/**
 * Rating buttons live in the member's DMs, where there is no server and the normal router cannot run,
 * so index.ts sends `vgticketdm:` interactions here (the same way ban appeals are handled).
 */
export async function handleTicketDm(i, store) {
    if (!(i.isButton() || i.isModalSubmit()) || !i.customId.startsWith('vgticketdm:'))
        return false;
    const [, action, guildId, rawTicket, rawStars] = i.customId.split(':');
    const answer = (payload) => (i.deferred || i.replied ? i.editReply(payload) : i.reply({ ...payload, flags: MessageFlags.Ephemeral })).catch(() => { });
    const fail = (text) => answer({ embeds: [embed('Ticket rating', text, Colors.Red)], components: [] });
    try {
        if (action !== 'rate' || !guildId || !/^\d{17,20}$/.test(guildId) || !/^[1-5]$/.test(rawStars ?? ''))
            return await fail('This rating button is no longer valid.'), true;
        const stars = Number(rawStars);
        const result = await store.withAuthorized(guildId, async () => {
            const ticket = store.get('SELECT * FROM ticket_records WHERE guild_id=? AND id=?', guildId, Number(rawTicket));
            if (!ticket || ticket.user_id !== i.user.id)
                return 'not-yours';
            if (ticket.status !== 'closed')
                return 'still-open';
            if (ticket.rating)
                return 'already';
            const changed = store.run("UPDATE ticket_records SET rating=? WHERE guild_id=? AND id=? AND rating IS NULL AND status='closed'", stars, guildId, ticket.id);
            return changed.changes ? { number: ticket.number, claimedBy: ticket.claimed_by } : 'already';
        });
        if (result === 'not-yours')
            return await fail("This rating isn't yours to give."), true;
        if (result === 'still-open')
            return await fail('Please wait until the ticket is fully closed before rating it.'), true;
        if (result === 'already')
            return await i.update({ components: [] }).catch(() => { }), true;
        await answer({ embeds: [embed('Thanks for your feedback', `You rated us ${'⭐'.repeat(stars)} (${stars}/5).`, Colors.Green)], components: [] });
        const guild = i.client.guilds?.cache?.get(guildId);
        if (guild)
            await store.withAuthorized(guildId, async () => ticketLog(guild, ticketConfig(store, guildId), { embeds: [embed(`⭐ Ticket #${String(result.number).padStart(4, '0')} rated ${stars}/5`, `**User:** <@${i.user.id}>\n**Staff:** ${result.claimedBy ? `<@${result.claimedBy}>` : 'Nobody claimed it'}`, Colors.Yellow)] }));
        return true;
    }
    catch (error) {
        await fail('Something went wrong saving your rating. Try again later.');
        return true;
    }
}
