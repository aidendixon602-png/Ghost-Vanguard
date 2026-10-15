import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, Colors, EmbedBuilder, PermissionFlagsBits, StringSelectMenuBuilder } from 'discord.js';
import { AppError } from '../errors.js';
import { clip } from '../core.js';
import { embed } from '../ui/ui.js';
import { rankOf, RANKS } from '../bot/ranks.js';
import { buildTranscript } from './ticket-transcript.js';
/**
 * Support tickets — the desk half of Ghost Vanguard, merged in from the old Midtown Desk bot.
 * Every server gets its own ticket types, staff role, log channel, settings and ticket history,
 * and nothing here touches another server's rows (the store's guild scope enforces that).
 */
export const TICKET_PANEL_TITLE = 'Support Tickets';
export const TICKET_PANEL_TEXT = 'Need help? Pick a ticket type from the menu below and a staff member will be with you shortly.';
export const TICKET_STAFF_ROLE = 'Ticket Staff';
export const TICKET_CATEGORY = 'Tickets';
export const TICKET_LOG_CHANNEL = 'ticket-logs';
export const TICKET_PANEL_CHANNEL = 'open-a-ticket';
/** Seconds a member must wait between opening tickets in the same server. */
export const TICKET_COOLDOWN_SECONDS = 60;
export const PRIORITIES = {
    urgent: { label: '🔴 Urgent', prefix: '🔴', color: Colors.Red, rank: 0 },
    high: { label: '🟠 High', prefix: '🟠', color: Colors.Orange, rank: 1 },
    normal: { label: '⚪ Normal', prefix: '', color: Colors.Blurple, rank: 2 },
    low: { label: '🔵 Low', prefix: '🔵', color: Colors.Blue, rank: 3 },
};
export const DEFAULT_TICKET_TYPES = [
    ['General Support', '🎫', 'Questions or help with anything'],
    ['Bug Report', '🐛', "Report a problem or something that isn't working"],
    ['Feature Request', '💡', 'Suggest an improvement or a new feature'],
    ['Partnership', '🤝', 'Partner or collab with the server'],
    ['Other', '❓', "Anything that doesn't fit above"],
];
const DEFAULTS = {
    staffRoleId: null, categoryId: null, logChannelId: null, panelChannelId: null,
    ticketLimit: 1, autocloseHours: 48, dmTranscripts: true, askRating: true, weeklyReport: true,
};
/** Channels holding an open ticket, so message activity does not hit the database for every message. */
const openChannels = new Set();
/** Anti-spam: when each member last opened a ticket here, keyed guild:user. */
const lastOpened = new Map();
export const isTicketChannel = (channelId) => openChannels.has(channelId);
export const forgetTicketChannel = (channelId) => openChannels.delete(channelId);
/** A ticket's channel was deleted by hand: close the record so it stops counting as open. */
export function ticketChannelGone(store, guildId, channelId) {
    openChannels.delete(channelId);
    return store.run("UPDATE ticket_records SET status='closed',closed_at=?,close_reason='Channel deleted manually' WHERE guild_id=? AND channel_id=? AND status IN ('open','closing')", Date.now(), guildId, channelId);
}
/** Load the open ticket channels at startup and recover any ticket left mid-close by a crash. */
export function loadTicketChannels(store) {
    openChannels.clear();
    for (const row of store.db.prepare("SELECT channel_id FROM ticket_records WHERE status IN ('open','closing')").all())
        openChannels.add(row.channel_id);
    store.db.prepare("UPDATE ticket_records SET status='open' WHERE status='closing'").run();
}
export const cooldownLeft = (guildId, userId, now = Date.now()) => Math.max(0, Math.ceil((TICKET_COOLDOWN_SECONDS * 1000 - (now - (lastOpened.get(`${guildId}:${userId}`) ?? -Infinity))) / 1000));
export const startCooldown = (guildId, userId, now = Date.now()) => { lastOpened.set(`${guildId}:${userId}`, now); };
/** Config, ticket types and blocks are read on every panel click and command, so they are cached per guild. */
const configCache = new WeakMap();
function cacheFor(store) {
    let cache = configCache.get(store);
    if (!cache) {
        cache = new Map();
        configCache.set(store, cache);
    }
    return cache;
}
export function ticketConfig(store, guildId) {
    const cached = cacheFor(store).get(guildId);
    if (cached)
        return cached;
    const row = store.get('SELECT * FROM ticket_config WHERE guild_id=?', guildId);
    const config = row ? {
        guildId, staffRoleId: row.staff_role_id, categoryId: row.category_id, logChannelId: row.log_channel_id, panelChannelId: row.panel_channel_id,
        ticketLimit: Number(row.ticket_limit), autocloseHours: Number(row.autoclose_hours), dmTranscripts: !!row.dm_transcripts,
        askRating: !!row.ask_rating, weeklyReport: !!row.weekly_report, counter: Number(row.counter),
        lastReportAt: row.last_report_at === null ? null : Number(row.last_report_at), byId: row.by_id, at: row.at === null ? null : Number(row.at),
    } : { guildId, ...DEFAULTS, counter: 0, lastReportAt: null, byId: null, at: null };
    cacheFor(store).set(guildId, config);
    return config;
}
export function clearTicketCache(store, guildId) {
    if (guildId)
        cacheFor(store).delete(guildId);
    else
        cacheFor(store).clear();
}
export function updateTicketConfig(store, guildId, values, byId) {
    const current = ticketConfig(store, guildId);
    const next = { ...current, ...values };
    store.run(`INSERT INTO ticket_config(guild_id,staff_role_id,category_id,log_channel_id,panel_channel_id,ticket_limit,autoclose_hours,dm_transcripts,ask_rating,weekly_report,counter,last_report_at,by_id,at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET
            staff_role_id=excluded.staff_role_id, category_id=excluded.category_id, log_channel_id=excluded.log_channel_id, panel_channel_id=excluded.panel_channel_id,
            ticket_limit=excluded.ticket_limit, autoclose_hours=excluded.autoclose_hours, dm_transcripts=excluded.dm_transcripts, ask_rating=excluded.ask_rating,
            weekly_report=excluded.weekly_report, counter=excluded.counter, last_report_at=excluded.last_report_at, by_id=excluded.by_id, at=excluded.at`, guildId, next.staffRoleId, next.categoryId, next.logChannelId, next.panelChannelId, next.ticketLimit, next.autocloseHours, Number(next.dmTranscripts), Number(next.askRating), Number(next.weeklyReport), next.counter, next.lastReportAt, byId, Date.now());
    cacheFor(store).delete(guildId);
    return ticketConfig(store, guildId);
}
export function ticketTypes(store, guildId) {
    return store.all('SELECT id,name,emoji,description,position FROM ticket_types WHERE guild_id=? ORDER BY position,id', guildId)
        .map(r => ({ id: Number(r.id), name: String(r.name), emoji: r.emoji ?? null, description: r.description ?? null, position: Number(r.position) }));
}
export function seedTicketTypes(store, guildId) {
    DEFAULT_TICKET_TYPES.forEach(([name, emoji, description], position) => store.run('INSERT INTO ticket_types(guild_id,name,emoji,description,position) VALUES(?,?,?,?,?)', guildId, name, emoji, description, position));
}
export function ticketTypeByName(store, guildId, name) {
    return ticketTypes(store, guildId).find(t => t.name.toLowerCase() === name.trim().toLowerCase());
}
/** Panel dropdowns max out at 25 options; the same limit is enforced when adding a type. */
export const MAX_TICKET_TYPES = 25;
export function validTicketEmoji(value) {
    const text = value.trim();
    return /^<a?:\w+:\d+>$/.test(text) || text.length <= 10 && ![...text].some(ch => ch.charCodeAt(0) < 128 && /[a-z0-9]/i.test(ch));
}
export const slugify = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'ticket';
export const stripPriority = (name) => {
    for (const { prefix } of Object.values(PRIORITIES))
        if (prefix && name.startsWith(prefix))
            return name.slice(prefix.length).replace(/^-+/, '');
    return name;
};
export const withPriority = (name, priority) => {
    const { prefix } = PRIORITIES[priority] ?? PRIORITIES.normal;
    return (prefix ? `${prefix}-${name}` : name).slice(0, 100);
};
// ---- panels -----------------------------------------------------------------------------
export function panelPayload(types, title = TICKET_PANEL_TITLE, description = TICKET_PANEL_TEXT) {
    const options = types.slice(0, MAX_TICKET_TYPES).map(t => ({
        label: clip(t.name, 100), value: String(t.id),
        ...(t.description ? { description: clip(t.description, 100) } : {}),
        ...(t.emoji ? { emoji: t.emoji } : {}),
    }));
    const rows = options.length
        ? [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
                .setCustomId('vgticket-form:open').setPlaceholder('🎫 Choose a ticket type...').addOptions(options))]
        : [];
    return { embeds: [new EmbedBuilder().setColor(Colors.Blurple).setTitle(clip(title, 256))
                .setDescription(clip(description, 2000)).setFooter({ text: 'Ghost Vanguard · Pick a ticket type below' })],
        components: rows, allowedMentions: { parse: [] } };
}
export function ticketControls(claimedBy, claimedName) {
    const claim = claimedBy
        ? new ButtonBuilder().setCustomId('vgticket:claimed').setLabel(clip(`Claimed by ${claimedName ?? claimedBy}`, 80)).setEmoji('🙋').setStyle(ButtonStyle.Secondary).setDisabled(true)
        : new ButtonBuilder().setCustomId('vgticket:claim').setLabel('Claim').setEmoji('🙋').setStyle(ButtonStyle.Success);
    return [new ActionRowBuilder().addComponents(claim, new ButtonBuilder().setCustomId('vgticket-form:close').setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger))];
}
export function closeRequestControls() {
    return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('vgticket:creq:yes').setLabel('Yes, close it').setEmoji('✅').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('vgticket:creq:no').setLabel('No, I still need help').setEmoji('❌').setStyle(ButtonStyle.Secondary))];
}
export function ratingControls(ticketId, guildId) {
    return [new ActionRowBuilder().addComponents(...[1, 2, 3, 4, 5].map(n => new ButtonBuilder().setCustomId(`vgticketdm:rate:${guildId}:${ticketId}:${n}`).setLabel(String(n)).setEmoji('⭐').setStyle(ButtonStyle.Secondary)))];
}
/** Post the ticket menu, remember it, and return the message. */
export async function postTicketPanel(store, guild, channel, types, title, description) {
    const message = await channel.send(panelPayload(types, title, description));
    store.run('INSERT OR REPLACE INTO ticket_panels(guild_id,message_id,channel_id,at) VALUES(?,?,?,?)', guild.id, message.id, channel.id, Date.now());
    return message;
}
/** Re-render every stored panel in a guild (after types change, or a restart). Returns how many failed. */
export async function refreshTicketPanels(store, guild) {
    const types = ticketTypes(store, guild.id);
    let failed = 0;
    for (const row of store.all('SELECT message_id,channel_id FROM ticket_panels WHERE guild_id=?', guild.id)) {
        let channelId = String(row.channel_id);
        const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased() || !('messages' in channel)) {
            store.run('DELETE FROM ticket_panels WHERE guild_id=? AND message_id=?', guild.id, row.message_id);
            continue;
        }
        const message = await channel.messages.fetch(String(row.message_id)).catch(() => null);
        if (!message) {
            store.run('DELETE FROM ticket_panels WHERE guild_id=? AND message_id=?', guild.id, row.message_id);
            continue;
        }
        await message.edit(panelPayload(types)).catch(() => { failed++; });
    }
    return failed;
}
export function ticketLogChannel(guild, config) {
    if (!config.logChannelId)
        return null;
    const channel = guild.channels.cache.get(config.logChannelId) ?? null;
    return channel?.isSendable() ? channel : null;
}
/** Post to a server's ticket log channel. Never throws: a missing log channel must not fail the action. */
export async function ticketLog(guild, config, payload) {
    const channel = ticketLogChannel(guild, config);
    if (!channel)
        return false;
    return channel.send({ ...payload, allowedMentions: { parse: [] } }).then(() => true).catch(() => false);
}
// ---- staff ---------------------------------------------------------------------------------
/** Who counts as ticket staff in a server: the ticket staff role, Manage Server, or any Vanguard rank. */
export function isTicketStaff(store, guildId, userId, member) {
    const config = ticketConfig(store, guildId);
    if (config.staffRoleId && member?.roles?.cache?.has(config.staffRoleId))
        return true;
    if (member?.permissions?.has(PermissionFlagsBits.ManageGuild))
        return true;
    return rankOf(store, guildId, userId, member, 'ticket') >= RANKS.helper;
}
export function requireTicketStaff(store, guildId, userId, member) {
    if (!isTicketStaff(store, guildId, userId, member))
        throw new AppError('PERMISSION_ERROR', 'Only the ticket staff team (or an admin) can do that.');
}
// ---- tickets --------------------------------------------------------------------------------
export function openTicketIn(store, guildId, channelId) {
    return store.get("SELECT * FROM ticket_records WHERE guild_id=? AND channel_id=? AND status IN ('open','closing')", guildId, channelId);
}
export function ticketById(store, guildId, id) {
    return store.get('SELECT * FROM ticket_records WHERE guild_id=? AND id=?', guildId, id);
}
export function ticketByChannel(store, guildId, channelId) {
    return store.get('SELECT * FROM ticket_records WHERE guild_id=? AND channel_id=?', guildId, channelId);
}
export function openTicketsFor(store, guildId, userId) {
    return store.all("SELECT channel_id FROM ticket_records WHERE guild_id=? AND user_id=? AND status IN ('open','closing')", guildId, userId);
}
function nextTicketNumber(store, guildId) {
    ticketConfig(store, guildId);
    store.run('UPDATE ticket_config SET counter=counter+1 WHERE guild_id=?', guildId);
    cacheFor(store).delete(guildId);
    return ticketConfig(store, guildId).counter;
}
export function markTicketActivity(store, channelId, at = Date.now()) {
    if (!openChannels.has(channelId))
        return false;
    const guildId = store.currentGuildId();
    if (!guildId)
        return false;
    store.run("UPDATE ticket_records SET last_activity=?,warned=0 WHERE guild_id=? AND channel_id=? AND status='open'", at, guildId, channelId);
    return true;
}
/** Create the ticket channel, the welcome message with its Claim/Close buttons, and the log entry. */
export async function openTicket({ guild, user, type, subject, details, config, store }) {
    const staff = config.staffRoleId ? guild.roles.cache.get(config.staffRoleId) ?? null : null;
    const category = config.categoryId ? guild.channels.cache.get(config.categoryId) ?? null : null;
    const number = nextTicketNumber(store, guild.id);
    const label = `${number.toString().padStart(4, '0')}`;
    const permissions = { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true };
    const member = await guild.members.fetch(user.id).catch(() => null);
    const channel = await guild.channels.create({
        name: `${slugify(type.name)}-${label}`,
        ...(category?.type === ChannelType.GuildCategory ? { parent: category.id } : {}),
        topic: clip(`Ticket #${label} • ${user.tag} • ${type.name}`, 1024),
        reason: `Ticket opened by ${user.tag}`,
        permissionOverwrites: [
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            ...(member ? [{ id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] }] : []),
            ...(guild.members.me ? [{ id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] }] : []),
            ...(staff ? [{ id: staff.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages] }] : []),
        ],
    });
    const now = Date.now();
    store.run(`INSERT INTO ticket_records(guild_id,number,channel_id,user_id,type,subject,details,opened_at,last_activity)
            VALUES(?,?,?,?,?,?,?,?,?)`, guild.id, number, channel.id, user.id, type.name, clip(subject, 1024), clip(details, 4000), now, now);
    openChannels.add(channel.id);
    const ticket = ticketByChannel(store, guild.id, channel.id);
    const welcome = embed(`🎫 ${type.name} · Ticket #${label}`, `Thanks for reaching out, <@${user.id}>. A staff member will be with you soon.\nWhile you wait, add any screenshots or extra info that might help.\n\n**Subject:** ${clip(subject, 900)}${details ? `\n**Details:** ${clip(details, 900)}` : ''}`, Colors.Blurple);
    try {
        const message = await channel.send({ content: `<@${user.id}>${staff ? ` <@&${staff.id}>` : ''}`, embeds: [welcome], components: ticketControls(), allowedMentions: { users: [user.id], roles: staff ? [staff.id] : [] } });
        store.run('UPDATE ticket_records SET welcome_message_id=? WHERE guild_id=? AND id=?', message.id, guild.id, ticket.id);
        await message.pin().catch(() => { });
    }
    catch (error) {
        // The channel exists but nobody can use it; remove it rather than leaving an unusable ticket behind.
        await channel.delete('Ticket welcome message failed').catch(() => { });
        store.run('DELETE FROM ticket_records WHERE guild_id=? AND id=?', guild.id, ticket.id);
        openChannels.delete(channel.id);
        throw error;
    }
    startCooldown(guild.id, user.id);
    await ticketLog(guild, config, { embeds: [embed(`📥 Ticket #${label} opened`, `**User:** <@${user.id}> (\`${user.id}\`)\n**Type:** ${type.name}\n**Channel:** <#${channel.id}>\n**Subject:** ${clip(subject, 900)}`, Colors.Green)] });
    return { channel, ticket: ticketByChannel(store, guild.id, channel.id) };
}
export async function updateClaimButton(channel, ticket, claimedName) {
    if (!channel?.isTextBased() || !('messages' in channel) || !ticket.welcome_message_id)
        return;
    const message = await channel.messages.fetch(ticket.welcome_message_id).catch(() => null);
    await message?.edit({ components: ticketControls(ticket.claimed_by, claimedName) }).catch(() => { });
}
/**
 * Close a ticket: transcript to the log channel (and the member's DMs), tell the member, then delete
 * the channel. Closing is locked first so it cannot run twice; a failure that would leave no transcript
 * keeps the ticket open so it can be retried.
 */
export async function closeTicket({ store, guild, channel, ticket, closer, reason, config, client }) {
    const number = ticket.number.toString().padStart(4, '0');
    const locked = store.run("UPDATE ticket_records SET status='closing' WHERE guild_id=? AND id=? AND status='open'", guild.id, ticket.id);
    if (!locked.changes)
        return false;
    try {
        await channel.send({ embeds: [embed('🔒 Closing ticket', `Closed by ${closer ? `<@${closer.id}>` : 'auto-close'}\n**Reason:** ${clip(reason, 1000)}\n\nSaving the transcript and deleting this channel in a few seconds...`, Colors.Red)],
            allowedMentions: { parse: [] } }).catch(() => { });
        const { html, count } = await buildTranscript(channel, ticket, guild);
        const archivedLog = await ticketLog(guild, config, { embeds: [embed(`🔒 Ticket #${number} closing`, `**Opened by:** <@${ticket.user_id}>\n**Type:** ${ticket.type}\n**Claimed by:** ${ticket.claimed_by ? `<@${ticket.claimed_by}>` : 'Nobody'}\n**Closed by:** ${closer ? `<@${closer.id}>` : 'Auto-close'}\n**Opened:** <t:${Math.floor(ticket.opened_at / 1000)}:R>\n**Messages:** ${count}\n**Reason:** ${clip(reason, 900)}`, Colors.Red)],
            files: [new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: `ticket-${number}.html` })] });
        const user = await guild.members.fetch(ticket.user_id).catch(() => null) ?? await client.users.fetch(ticket.user_id).catch(() => null);
        let dm = null;
        if (user) {
            const card = embed(`Your ticket in ${guild.name} was closed`, `**Ticket:** #${number} (${ticket.type})\n**Reason:** ${clip(reason, 900)}`, Colors.Blurple);
            dm = await user.send({ embeds: [card], files: config.dmTranscripts ? [new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: `ticket-${number}.html` })] : [] }).catch(() => null);
        }
        // Never delete the only copy of a conversation: if neither destination accepted the transcript, retry later.
        if (!archivedLog && !dm)
            throw new AppError('VALIDATION_ERROR', config.dmTranscripts
                ? 'The transcript could not be delivered, so the ticket stays open. Check the ticket log channel and the Attach Files permission, then close it again.'
                : 'The transcript could not be saved to the ticket log channel, so the ticket stays open. Check the log channel, then close it again.');
        store.run("UPDATE ticket_records SET status='closed',closed_at=?,closed_by=?,close_reason=? WHERE guild_id=? AND id=?", Date.now(), closer?.id ?? null, clip(reason, 300), guild.id, ticket.id);
        openChannels.delete(channel.id);
        await ticketLog(guild, config, { embeds: [embed(`🔒 Ticket #${number} closed`, `**Closed by:** ${closer ? `<@${closer.id}>` : 'Auto-close'}\n**Reason:** ${clip(reason, 900)}`, Colors.Red)] });
        if (dm && config.askRating)
            await dm.edit({ embeds: [embed('How did we do?', `**Ticket #${number} · ${guild.name}**\nRate the help you got below (1–5 stars).`, Colors.Blurple)],
                components: ratingControls(ticket.id, guild.id) }).catch(() => { });
        // Deletion is fire-and-forget so the person who closed the ticket isn't left waiting 5 seconds.
        scheduleChannelDeletion(channel, number);
        return true;
    }
    finally {
        // A failed close stays open and usable; the next attempt can still archive it.
        const reverted = store.run("UPDATE ticket_records SET status='open' WHERE guild_id=? AND id=? AND status='closing'", guild.id, ticket.id);
        if (reverted.changes)
            openChannels.add(channel.id);
    }
}
/** Delete a closed ticket's channel shortly after, so the closing notice is readable. */
export function scheduleChannelDeletion(channel, number) {
    const timer = setTimeout(() => { void channel.delete(`Ticket #${number} closed`).catch(() => { }); }, 5000);
    timer.unref?.();
    return timer;
}
export function claimTicket(store, guildId, ticket, member, previous) {
    const changed = store.run("UPDATE ticket_records SET claimed_by=? WHERE guild_id=? AND id=? AND status='open' AND claimed_by IS ?", member?.id ?? null, guildId, ticket.id, previous);
    return !!changed.changes;
}
export function activeTicketPriority(ticket) {
    return (ticket.priority in PRIORITIES ? ticket.priority : 'normal');
}
// ---- statistics ------------------------------------------------------------------------------
export function ticketStats(store, guildId) {
    const total = Number(store.get('SELECT COUNT(*) c FROM ticket_records WHERE guild_id=?', guildId)?.c ?? 0);
    const open = Number(store.get("SELECT COUNT(*) c FROM ticket_records WHERE guild_id=? AND status='open'", guildId)?.c ?? 0);
    const ratings = store.get('SELECT AVG(rating) a, COUNT(rating) n FROM ticket_records WHERE guild_id=? AND rating IS NOT NULL', guildId);
    const staff = store.all('SELECT claimed_by, COUNT(*) c, AVG(rating) r FROM ticket_records WHERE guild_id=? AND claimed_by IS NOT NULL GROUP BY claimed_by ORDER BY c DESC LIMIT 10', guildId);
    return { total, open, closed: total - open, average: ratings?.n ? Number(ratings.a) : null, ratingCount: Number(ratings?.n ?? 0), staff };
}
export function weeklyReport(store, guildId, end = Date.now()) {
    const start = end - 7 * 86400000, previous = start - 7 * 86400000;
    const count = (sql, ...args) => Number(store.get(sql, guildId, ...args)?.c ?? 0);
    const ratings = store.get('SELECT AVG(rating) a, COUNT(rating) n FROM ticket_records WHERE guild_id=? AND rating IS NOT NULL AND closed_at>=? AND closed_at<?', guildId, start, end);
    const top = store.get('SELECT type, COUNT(*) c FROM ticket_records WHERE guild_id=? AND opened_at>=? AND opened_at<? GROUP BY type ORDER BY c DESC LIMIT 1', guildId, start, end);
    const hours = store.get("SELECT AVG((closed_at-opened_at)/3600000.0) h FROM ticket_records WHERE guild_id=? AND status='closed' AND closed_at>=? AND closed_at<?", guildId, start, end);
    return {
        opened: count('SELECT COUNT(*) c FROM ticket_records WHERE guild_id=? AND opened_at>=? AND opened_at<?', start, end),
        openedPrev: count('SELECT COUNT(*) c FROM ticket_records WHERE guild_id=? AND opened_at>=? AND opened_at<?', previous, start),
        closed: count("SELECT COUNT(*) c FROM ticket_records WHERE guild_id=? AND status='closed' AND closed_at>=? AND closed_at<?", start, end),
        openNow: count("SELECT COUNT(*) c FROM ticket_records WHERE guild_id=? AND status='open'"),
        unclaimed: count("SELECT COUNT(*) c FROM ticket_records WHERE guild_id=? AND status='open' AND claimed_by IS NULL"),
        urgent: count("SELECT COUNT(*) c FROM ticket_records WHERE guild_id=? AND status='open' AND priority IN ('urgent','high')"),
        average: ratings?.n ? Number(ratings.a) : null, ratingCount: Number(ratings?.n ?? 0),
        topType: top ? { name: String(top.type), count: Number(top.c) } : null,
        hoursToClose: hours?.h === null || hours?.h === undefined ? null : Number(hours.h),
        staff: store.all('SELECT claimed_by, COUNT(*) c, AVG(rating) r FROM ticket_records WHERE guild_id=? AND status=\'closed\' AND claimed_by IS NOT NULL AND closed_at>=? AND closed_at<? GROUP BY claimed_by ORDER BY c DESC LIMIT 5', guildId, start, end)
            .map(r => ({ id: String(r.claimed_by), count: Number(r.c), rating: r.r === null ? null : Number(r.r) })),
    };
}
export function reportEmbed(guild, report, end = Date.now()) {
    const trend = report.openedPrev === 0 ? (report.opened ? ' (new)' : '') : (() => {
        const change = Math.round((report.opened - report.openedPrev) / report.openedPrev * 100);
        return change === 0 ? ' (same as last week)' : ` (${change > 0 ? '▲' : '▼'} ${Math.abs(change)}% vs last week)`;
    })();
    const medals = ['🥇', '🥈', '🥉', '4.', '5.'];
    const card = embed(`📊 Weekly ticket report — ${guild.name}`, `<t:${Math.floor((end - 7 * 86400000) / 1000)}:D> → <t:${Math.floor(end / 1000)}:D>`, Colors.Blurple);
    card.addFields({ name: '📥 Opened', value: `**${report.opened}**${trend}`, inline: true }, { name: '🔒 Closed', value: `**${report.closed}**`, inline: true }, { name: '⏱️ Avg time to close', value: report.hoursToClose === null ? '—' : `**${report.hoursToClose.toFixed(1)}h**`, inline: true }, { name: '⭐ Avg rating', value: report.average === null ? 'No ratings' : `**${report.average.toFixed(2)}** (${report.ratingCount} ratings)`, inline: true }, { name: '🏷️ Most common type', value: report.topType ? `${report.topType.name} (${report.topType.count})` : '—', inline: true }, { name: '📂 Still open', value: `**${report.openNow}** · ${report.unclaimed} unclaimed · ${report.urgent} high/urgent`, inline: true }, { name: '🏆 Top staff this week', value: report.staff.map((s, index) => `${medals[index] ?? `${index + 1}.`} <@${s.id}> · ${s.count} closed${s.rating ? ` · ${s.rating.toFixed(1)}⭐` : ''}`).join('\n') || 'No claimed tickets closed' });
    card.setFooter({ text: 'Ghost Vanguard · Turn this off with /ticket settings weekly_report:False' });
    return card;
}
/**
 * Every run: warn tickets that have been quiet for `autoclose_hours`, close ones quiet for an hour
 * past the warning, and post the weekly report when one is due. Runs per authorized server only.
 */
export async function runTicketMaintenance({ store, client, ready }, now = Date.now()) {
    let warned = 0, closed = 0, reports = 0;
    for (const guild of client.guilds.cache.values()) {
        if (!ready(guild.id))
            continue;
        const outcome = await store.withAuthorized(guild.id, async () => {
            const config = ticketConfig(store, guild.id);
            let localWarned = 0, localClosed = 0, localReports = 0;
            const openRows = store.all("SELECT * FROM ticket_records WHERE guild_id=? AND status='open'", guild.id);
            for (const ticket of openRows) {
                const channel = guild.channels.cache.get(ticket.channel_id) ?? await guild.channels.fetch(ticket.channel_id).catch(() => null);
                if (!channel || !channel.isTextBased()) {
                    store.run("UPDATE ticket_records SET status='closed',closed_at=?,close_reason='Channel deleted manually' WHERE guild_id=? AND id=?", now, guild.id, ticket.id);
                    openChannels.delete(ticket.channel_id);
                    continue;
                }
                if (!config.autocloseHours)
                    continue;
                const idle = now - ticket.last_activity;
                if (!ticket.warned && idle >= config.autocloseHours * 3600000) {
                    await channel.send({ embeds: [embed('⏰ Quiet ticket', `<@${ticket.user_id}> this ticket has been quiet for a while. It closes automatically in **1 hour** unless someone sends a message.`, Colors.Yellow)],
                        allowedMentions: { users: [ticket.user_id] } }).catch(() => { });
                    store.run('UPDATE ticket_records SET warned=1 WHERE guild_id=? AND id=?', guild.id, ticket.id);
                    localWarned++;
                }
                else if (ticket.warned && idle >= (config.autocloseHours + 1) * 3600000) {
                    await closeTicket({ store, guild, channel, ticket, closer: null, reason: 'Closed automatically for inactivity', config, client });
                    localClosed++;
                }
            }
            if (config.weeklyReport && (config.lastReportAt === null ? now - (store.get('SELECT MIN(opened_at) t FROM ticket_records WHERE guild_id=?', guild.id)?.t ?? now) >= 7 * 86400000 : now - config.lastReportAt >= 7 * 86400000)) {
                const channel = ticketLogChannel(guild, config);
                if (channel) {
                    await channel.send({ embeds: [reportEmbed(guild, weeklyReport(store, guild.id, now), now)], allowedMentions: { parse: [] } }).catch(() => { });
                    updateTicketConfig(store, guild.id, { lastReportAt: now }, client.user?.id ?? 'system');
                    localReports++;
                }
            }
            return { localWarned, localClosed, localReports };
        });
        warned += outcome.localWarned;
        closed += outcome.localClosed;
        reports += outcome.localReports;
    }
    return { warned, closed, reports };
}
/** Everything a ticket needs to exist for a guild leaves with the guild; used when a server is dropped. */
export function forgetGuildTickets(store, guildId) {
    clearTicketCache(store, guildId);
    for (const [key] of lastOpened)
        if (key.startsWith(`${guildId}:`))
            lastOpened.delete(key);
}
/** Rows for the ticket history view. */
export function ticketHistory(store, guildId, userId, limit = 15) {
    return store.all('SELECT * FROM ticket_records WHERE guild_id=? AND user_id=? ORDER BY id DESC LIMIT ?', guildId, userId, limit);
}
export function ticketCount(store, guildId, userId) {
    return Number(store.get('SELECT COUNT(*) c FROM ticket_records WHERE guild_id=? AND user_id=?', guildId, userId)?.c ?? 0);
}
export function blockedUsers(store, guildId) {
    return store.all('SELECT * FROM ticket_blocks WHERE guild_id=? ORDER BY at DESC', guildId);
}
export function blockUser(store, guildId, userId, reason, byId) {
    store.run('INSERT OR REPLACE INTO ticket_blocks(guild_id,user_id,reason,by_id,at) VALUES(?,?,?,?,?)', guildId, userId, reason ? clip(reason, 300) : null, byId, Date.now());
}
export function unblockUser(store, guildId, userId) {
    return !!store.run('DELETE FROM ticket_blocks WHERE guild_id=? AND user_id=?', guildId, userId).changes;
}
export function blockedFromTickets(store, guildId, userId) {
    return store.get('SELECT * FROM ticket_blocks WHERE guild_id=? AND user_id=?', guildId, userId);
}
