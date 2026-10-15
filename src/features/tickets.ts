import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, Colors, EmbedBuilder,
    PermissionFlagsBits, StringSelectMenuBuilder, type Client, type Guild, type GuildBasedChannel, type GuildMember, type SendableChannels, type User } from 'discord.js';
import type { Store } from '../database/db.js';
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
} as const;
export type TicketPriority = keyof typeof PRIORITIES;

export const DEFAULT_TICKET_TYPES: [string, string, string][] = [
    ['General Support', '🎫', 'Questions or help with anything'],
    ['Bug Report', '🐛', "Report a problem or something that isn't working"],
    ['Feature Request', '💡', 'Suggest an improvement or a new feature'],
    ['Partnership', '🤝', 'Partner or collab with the server'],
    ['Other', '❓', "Anything that doesn't fit above"],
];

export interface TicketConfig {
    guildId: string;
    staffRoleId: string | null;
    categoryId: string | null;
    logChannelId: string | null;
    panelChannelId: string | null;
    ticketLimit: number;
    autocloseHours: number;
    dmTranscripts: boolean;
    askRating: boolean;
    weeklyReport: boolean;
    counter: number;
    lastReportAt: number | null;
    byId: string | null;
    at: number | null;
}

export interface TicketType { id: number; name: string; emoji: string | null; description: string | null; position: number }

export interface TicketRecord {
    id: number; guild_id: string; number: number; channel_id: string; welcome_message_id: string | null; user_id: string;
    type: string; subject: string; details: string; claimed_by: string | null; priority: TicketPriority;
    status: 'open' | 'closing' | 'closed'; opened_at: number; last_activity: number; warned: number;
    closed_at: number | null; closed_by: string | null; close_reason: string | null; rating: number | null;
}

const DEFAULTS: Omit<TicketConfig, 'guildId' | 'counter' | 'lastReportAt' | 'byId' | 'at'> = {
    staffRoleId: null, categoryId: null, logChannelId: null, panelChannelId: null,
    ticketLimit: 1, autocloseHours: 48, dmTranscripts: true, askRating: true, weeklyReport: true,
};

/** Channels holding an open ticket, so message activity does not hit the database for every message. */
const openChannels = new Set<string>();
/** Anti-spam: when each member last opened a ticket here, keyed guild:user. */
const lastOpened = new Map<string, number>();

export const isTicketChannel = (channelId: string) => openChannels.has(channelId);
export const forgetTicketChannel = (channelId: string) => openChannels.delete(channelId);

/** A ticket's channel was deleted by hand: close the record so it stops counting as open. */
export function ticketChannelGone(store: Store, guildId: string, channelId: string) {
    openChannels.delete(channelId);
    return store.run("UPDATE ticket_records SET status='closed',closed_at=?,close_reason='Channel deleted manually' WHERE guild_id=? AND channel_id=? AND status IN ('open','closing')", Date.now(), guildId, channelId);
}

/** Load the open ticket channels at startup and recover any ticket left mid-close by a crash. */
export function loadTicketChannels(store: Store) {
    openChannels.clear();
    for (const row of store.db.prepare("SELECT channel_id FROM ticket_records WHERE status IN ('open','closing')").all() as { channel_id: string }[])
        openChannels.add(row.channel_id);
    store.db.prepare("UPDATE ticket_records SET status='open' WHERE status='closing'").run();
}

export const cooldownLeft = (guildId: string, userId: string, now = Date.now()) =>
    Math.max(0, Math.ceil((TICKET_COOLDOWN_SECONDS * 1000 - (now - (lastOpened.get(`${guildId}:${userId}`) ?? -Infinity))) / 1000));
export const startCooldown = (guildId: string, userId: string, now = Date.now()) => { lastOpened.set(`${guildId}:${userId}`, now); };

/** Config, ticket types and blocks are read on every panel click and command, so they are cached per guild. */
const configCache = new WeakMap<Store, Map<string, TicketConfig>>();

function cacheFor(store: Store) {
    let cache = configCache.get(store);
    if (!cache) {
        cache = new Map();
        configCache.set(store, cache);
    }
    return cache;
}

export function ticketConfig(store: Store, guildId: string): TicketConfig {
    const cached = cacheFor(store).get(guildId);
    if (cached)
        return cached;
    const row = store.get('SELECT * FROM ticket_config WHERE guild_id=?', guildId);
    const config: TicketConfig = row ? {
        guildId, staffRoleId: row.staff_role_id, categoryId: row.category_id, logChannelId: row.log_channel_id, panelChannelId: row.panel_channel_id,
        ticketLimit: Number(row.ticket_limit), autocloseHours: Number(row.autoclose_hours), dmTranscripts: !!row.dm_transcripts,
        askRating: !!row.ask_rating, weeklyReport: !!row.weekly_report, counter: Number(row.counter),
        lastReportAt: row.last_report_at === null ? null : Number(row.last_report_at), byId: row.by_id, at: row.at === null ? null : Number(row.at),
    } : { guildId, ...DEFAULTS, counter: 0, lastReportAt: null, byId: null, at: null };
    cacheFor(store).set(guildId, config);
    return config;
}

export function clearTicketCache(store: Store, guildId?: string) {
    if (guildId)
        cacheFor(store).delete(guildId);
    else
        cacheFor(store).clear();
}

export function updateTicketConfig(store: Store, guildId: string, values: Partial<Omit<TicketConfig, 'guildId'>>, byId: string) {
    const current = ticketConfig(store, guildId);
    const next = { ...current, ...values };
    store.run(`INSERT INTO ticket_config(guild_id,staff_role_id,category_id,log_channel_id,panel_channel_id,ticket_limit,autoclose_hours,dm_transcripts,ask_rating,weekly_report,counter,last_report_at,by_id,at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET
            staff_role_id=excluded.staff_role_id, category_id=excluded.category_id, log_channel_id=excluded.log_channel_id, panel_channel_id=excluded.panel_channel_id,
            ticket_limit=excluded.ticket_limit, autoclose_hours=excluded.autoclose_hours, dm_transcripts=excluded.dm_transcripts, ask_rating=excluded.ask_rating,
            weekly_report=excluded.weekly_report, counter=excluded.counter, last_report_at=excluded.last_report_at, by_id=excluded.by_id, at=excluded.at`,
        guildId, next.staffRoleId, next.categoryId, next.logChannelId, next.panelChannelId, next.ticketLimit, next.autocloseHours,
        Number(next.dmTranscripts), Number(next.askRating), Number(next.weeklyReport), next.counter, next.lastReportAt, byId, Date.now());
    cacheFor(store).delete(guildId);
    return ticketConfig(store, guildId);
}

export function ticketTypes(store: Store, guildId: string): TicketType[] {
    return store.all('SELECT id,name,emoji,description,position FROM ticket_types WHERE guild_id=? ORDER BY position,id', guildId)
        .map(r => ({ id: Number(r.id), name: String(r.name), emoji: r.emoji ?? null, description: r.description ?? null, position: Number(r.position) }));
}

export function seedTicketTypes(store: Store, guildId: string) {
    DEFAULT_TICKET_TYPES.forEach(([name, emoji, description], position) =>
        store.run('INSERT INTO ticket_types(guild_id,name,emoji,description,position) VALUES(?,?,?,?,?)', guildId, name, emoji, description, position));
}

export function ticketTypeByName(store: Store, guildId: string, name: string): TicketType | undefined {
    return ticketTypes(store, guildId).find(t => t.name.toLowerCase() === name.trim().toLowerCase());
}

/** Panel dropdowns max out at 25 options; the same limit is enforced when adding a type. */
export const MAX_TICKET_TYPES = 25;

export function validTicketEmoji(value: string) {
    const text = value.trim();
    return /^<a?:\w+:\d+>$/.test(text) || text.length <= 10 && ![...text].some(ch => ch.charCodeAt(0) < 128 && /[a-z0-9]/i.test(ch));
}

export const slugify = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'ticket';
export const stripPriority = (name: string) => {
    for (const { prefix } of Object.values(PRIORITIES))
        if (prefix && name.startsWith(prefix))
            return name.slice(prefix.length).replace(/^-+/, '');
    return name;
};
export const withPriority = (name: string, priority: TicketPriority) => {
    const { prefix } = PRIORITIES[priority] ?? PRIORITIES.normal;
    return (prefix ? `${prefix}-${name}` : name).slice(0, 100);
};

// ---- panels -----------------------------------------------------------------------------

export function panelPayload(types: TicketType[], title = TICKET_PANEL_TITLE, description = TICKET_PANEL_TEXT) {
    const options = types.slice(0, MAX_TICKET_TYPES).map(t => ({
        label: clip(t.name, 100), value: String(t.id),
        ...(t.description ? { description: clip(t.description, 100) } : {}),
        ...(t.emoji ? { emoji: t.emoji } : {}),
    }));
    const rows = options.length
        ? [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
            .setCustomId('vgticket-form:open').setPlaceholder('🎫 Choose a ticket type...').addOptions(options as any))]
        : [];
    return { embeds: [new EmbedBuilder().setColor(Colors.Blurple).setTitle(clip(title, 256))
            .setDescription(clip(description, 2000)).setFooter({ text: 'Ghost Vanguard · Pick a ticket type below' })],
        components: rows, allowedMentions: { parse: [] as never[] } };
}

export function ticketControls(claimedBy?: string | null, claimedName?: string | null) {
    const claim = claimedBy
        ? new ButtonBuilder().setCustomId('vgticket:claimed').setLabel(clip(`Claimed by ${claimedName ?? claimedBy}`, 80)).setEmoji('🙋').setStyle(ButtonStyle.Secondary).setDisabled(true)
        : new ButtonBuilder().setCustomId('vgticket:claim').setLabel('Claim').setEmoji('🙋').setStyle(ButtonStyle.Success);
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(claim,
        new ButtonBuilder().setCustomId('vgticket-form:close').setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger))];
}

export function closeRequestControls() {
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('vgticket:creq:yes').setLabel('Yes, close it').setEmoji('✅').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('vgticket:creq:no').setLabel('No, I still need help').setEmoji('❌').setStyle(ButtonStyle.Secondary))];
}

export function ratingControls(ticketId: number, guildId: string) {
    return [new ActionRowBuilder<ButtonBuilder>().addComponents(...[1, 2, 3, 4, 5].map(n =>
        new ButtonBuilder().setCustomId(`vgticketdm:rate:${guildId}:${ticketId}:${n}`).setLabel(String(n)).setEmoji('⭐').setStyle(ButtonStyle.Secondary)))];
}

/** Post the ticket menu, remember it, and return the message. */
export async function postTicketPanel(store: Store, guild: Guild, channel: SendableChannels, types: TicketType[], title?: string, description?: string) {
    const message = await channel.send(panelPayload(types, title, description) as any);
    store.run('INSERT OR REPLACE INTO ticket_panels(guild_id,message_id,channel_id,at) VALUES(?,?,?,?)', guild.id, message.id, channel.id, Date.now());
    return message;
}

/** Re-render every stored panel in a guild (after types change, or a restart). Returns how many failed. */
export async function refreshTicketPanels(store: Store, guild: Guild): Promise<number> {
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
        await message.edit(panelPayload(types) as any).catch(() => { failed++; });
    }
    return failed;
}

export function ticketLogChannel(guild: Guild, config: TicketConfig): SendableChannels | null {
    if (!config.logChannelId)
        return null;
    const channel = guild.channels.cache.get(config.logChannelId) ?? null;
    return channel?.isSendable() ? channel : null;
}

/** Post to a server's ticket log channel. Never throws: a missing log channel must not fail the action. */
export async function ticketLog(guild: Guild, config: TicketConfig, payload: { embeds: EmbedBuilder[]; files?: AttachmentBuilder[] }) {
    const channel = ticketLogChannel(guild, config);
    if (!channel)
        return false;
    return channel.send({ ...payload, allowedMentions: { parse: [] } } as any).then(() => true).catch(() => false);
}

// ---- staff ---------------------------------------------------------------------------------

/** Who counts as ticket staff in a server: the ticket staff role, Manage Server, or any Vanguard rank. */
export function isTicketStaff(store: Store, guildId: string, userId: string, member?: GuildMember | null) {
    const config = ticketConfig(store, guildId);
    if (config.staffRoleId && member?.roles?.cache?.has(config.staffRoleId))
        return true;
    if (member?.permissions?.has(PermissionFlagsBits.ManageGuild))
        return true;
    return rankOf(store, guildId, userId, member, 'ticket') >= RANKS.helper;
}

export function requireTicketStaff(store: Store, guildId: string, userId: string, member?: GuildMember | null) {
    if (!isTicketStaff(store, guildId, userId, member))
        throw new AppError('PERMISSION_ERROR', 'Only the ticket staff team (or an admin) can do that.');
}

// ---- tickets --------------------------------------------------------------------------------

export function openTicketIn(store: Store, guildId: string, channelId: string): TicketRecord | undefined {
    return store.get("SELECT * FROM ticket_records WHERE guild_id=? AND channel_id=? AND status IN ('open','closing')", guildId, channelId) as TicketRecord | undefined;
}

export function ticketById(store: Store, guildId: string, id: number) {
    return store.get('SELECT * FROM ticket_records WHERE guild_id=? AND id=?', guildId, id) as TicketRecord | undefined;
}

export function ticketByChannel(store: Store, guildId: string, channelId: string) {
    return store.get('SELECT * FROM ticket_records WHERE guild_id=? AND channel_id=?', guildId, channelId) as TicketRecord | undefined;
}

export function openTicketsFor(store: Store, guildId: string, userId: string) {
    return store.all("SELECT channel_id FROM ticket_records WHERE guild_id=? AND user_id=? AND status IN ('open','closing')", guildId, userId);
}

function nextTicketNumber(store: Store, guildId: string) {
    ticketConfig(store, guildId);
    store.run('UPDATE ticket_config SET counter=counter+1 WHERE guild_id=?', guildId);
    cacheFor(store).delete(guildId);
    return ticketConfig(store, guildId).counter;
}

export function markTicketActivity(store: Store, channelId: string, at = Date.now()) {
    if (!openChannels.has(channelId))
        return false;
    const guildId = store.currentGuildId();
    if (!guildId)
        return false;
    store.run("UPDATE ticket_records SET last_activity=?,warned=0 WHERE guild_id=? AND channel_id=? AND status='open'", at, guildId, channelId);
    return true;
}

export interface OpenTicketInput {
    guild: Guild; user: User; type: TicketType; subject: string; details: string; config: TicketConfig; store: Store;
}

/** Create the ticket channel, the welcome message with its Claim/Close buttons, and the log entry. */
export async function openTicket({ guild, user, type, subject, details, config, store }: OpenTicketInput) {
    const staff = config.staffRoleId ? guild.roles.cache.get(config.staffRoleId) ?? null : null;
    const category = config.categoryId ? guild.channels.cache.get(config.categoryId) ?? null : null;
    const number = nextTicketNumber(store, guild.id);
    const label = `${number.toString().padStart(4, '0')}`;
    const permissions = { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, EmbedLinks: true } as const;
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

    const ticket = ticketByChannel(store, guild.id, channel.id)!;
    const welcome = embed(`🎫 ${type.name} · Ticket #${label}`,
        `Thanks for reaching out, <@${user.id}>. A staff member will be with you soon.\nWhile you wait, add any screenshots or extra info that might help.\n\n**Subject:** ${clip(subject, 900)}${details ? `\n**Details:** ${clip(details, 900)}` : ''}`, Colors.Blurple);
    try {
        const message = await channel.send({ content: `<@${user.id}>${staff ? ` <@&${staff.id}>` : ''}`, embeds: [welcome], components: ticketControls(), allowedMentions: { users: [user.id], roles: staff ? [staff.id] : [] } });
        store.run('UPDATE ticket_records SET welcome_message_id=? WHERE guild_id=? AND id=?', message.id, guild.id, ticket.id);
        await message.pin().catch(() => {});
    } catch (error) {
        // The channel exists but nobody can use it; remove it rather than leaving an unusable ticket behind.
        await channel.delete('Ticket welcome message failed').catch(() => {});
        store.run('DELETE FROM ticket_records WHERE guild_id=? AND id=?', guild.id, ticket.id);
        openChannels.delete(channel.id);
        throw error;
    }
    startCooldown(guild.id, user.id);
    await ticketLog(guild, config, { embeds: [embed(`📥 Ticket #${label} opened`,
        `**User:** <@${user.id}> (\`${user.id}\`)\n**Type:** ${type.name}\n**Channel:** <#${channel.id}>\n**Subject:** ${clip(subject, 900)}`, Colors.Green)] });
    return { channel, ticket: ticketByChannel(store, guild.id, channel.id)! };
}

export async function updateClaimButton(channel: GuildBasedChannel | null, ticket: TicketRecord, claimedName: string | null) {
    if (!channel?.isTextBased() || !('messages' in channel) || !ticket.welcome_message_id)
        return;
    const message = await channel.messages.fetch(ticket.welcome_message_id).catch(() => null);
    await message?.edit({ components: ticketControls(ticket.claimed_by, claimedName) }).catch(() => {});
}

export interface CloseInput {
    store: Store; guild: Guild; channel: any; ticket: TicketRecord; closer: User | null; reason: string; config: TicketConfig; client: Client;
}

/**
 * Close a ticket: transcript to the log channel (and the member's DMs), tell the member, then delete
 * the channel. Closing is locked first so it cannot run twice; a failure that would leave no transcript
 * keeps the ticket open so it can be retried.
 */
export async function closeTicket({ store, guild, channel, ticket, closer, reason, config, client }: CloseInput) {
    const number = ticket.number.toString().padStart(4, '0');
    const locked = store.run("UPDATE ticket_records SET status='closing' WHERE guild_id=? AND id=? AND status='open'", guild.id, ticket.id);
    if (!locked.changes)
        return false;
    try {
        await channel.send({ embeds: [embed('🔒 Closing ticket', `Closed by ${closer ? `<@${closer.id}>` : 'auto-close'}\n**Reason:** ${clip(reason, 1000)}\n\nSaving the transcript and deleting this channel in a few seconds...`, Colors.Red)],
            allowedMentions: { parse: [] } }).catch(() => {});
        const { html, count } = await buildTranscript(channel, ticket, guild);
        const archivedLog = await ticketLog(guild, config, { embeds: [embed(`🔒 Ticket #${number} closing`,
            `**Opened by:** <@${ticket.user_id}>\n**Type:** ${ticket.type}\n**Claimed by:** ${ticket.claimed_by ? `<@${ticket.claimed_by}>` : 'Nobody'}\n**Closed by:** ${closer ? `<@${closer.id}>` : 'Auto-close'}\n**Opened:** <t:${Math.floor(ticket.opened_at / 1000)}:R>\n**Messages:** ${count}\n**Reason:** ${clip(reason, 900)}`, Colors.Red)],
            files: [new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: `ticket-${number}.html` })] });

        const user = await guild.members.fetch(ticket.user_id).catch(() => null) ?? await client.users.fetch(ticket.user_id).catch(() => null);
        let dm: any = null;
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
                components: ratingControls(ticket.id, guild.id) }).catch(() => {});
        // Deletion is fire-and-forget so the person who closed the ticket isn't left waiting 5 seconds.
        scheduleChannelDeletion(channel, number);
        return true;
    } finally {
        // A failed close stays open and usable; the next attempt can still archive it.
        const reverted = store.run("UPDATE ticket_records SET status='open' WHERE guild_id=? AND id=? AND status='closing'", guild.id, ticket.id);
        if (reverted.changes)
            openChannels.add(channel.id);
    }
}

/** Delete a closed ticket's channel shortly after, so the closing notice is readable. */
export function scheduleChannelDeletion(channel: { delete: (reason?: string) => Promise<unknown> }, number: string) {
    const timer = setTimeout(() => { void channel.delete(`Ticket #${number} closed`).catch(() => {}); }, 5000);
    timer.unref?.();
    return timer;
}

export function claimTicket(store: Store, guildId: string, ticket: TicketRecord, member: GuildMember | null, previous: string | null) {
    const changed = store.run("UPDATE ticket_records SET claimed_by=? WHERE guild_id=? AND id=? AND status='open' AND claimed_by IS ?", member?.id ?? null, guildId, ticket.id, previous);
    return !!changed.changes;
}

export function activeTicketPriority(ticket: TicketRecord): TicketPriority {
    return (ticket.priority in PRIORITIES ? ticket.priority : 'normal') as TicketPriority;
}

// ---- statistics ------------------------------------------------------------------------------

export function ticketStats(store: Store, guildId: string) {
    const total = Number(store.get('SELECT COUNT(*) c FROM ticket_records WHERE guild_id=?', guildId)?.c ?? 0);
    const open = Number(store.get("SELECT COUNT(*) c FROM ticket_records WHERE guild_id=? AND status='open'", guildId)?.c ?? 0);
    const ratings = store.get('SELECT AVG(rating) a, COUNT(rating) n FROM ticket_records WHERE guild_id=? AND rating IS NOT NULL', guildId);
    const staff = store.all('SELECT claimed_by, COUNT(*) c, AVG(rating) r FROM ticket_records WHERE guild_id=? AND claimed_by IS NOT NULL GROUP BY claimed_by ORDER BY c DESC LIMIT 10', guildId);
    return { total, open, closed: total - open, average: ratings?.n ? Number(ratings.a) : null, ratingCount: Number(ratings?.n ?? 0), staff };
}

export interface WeeklyReport { opened: number; openedPrev: number; closed: number; openNow: number; unclaimed: number; urgent: number; average: number | null; ratingCount: number; topType: { name: string; count: number } | null; hoursToClose: number | null; staff: { id: string; count: number; rating: number | null }[] }

export function weeklyReport(store: Store, guildId: string, end = Date.now()): WeeklyReport {
    const start = end - 7 * 86400000, previous = start - 7 * 86400000;
    const count = (sql: string, ...args: (string | number)[]) => Number(store.get(sql, guildId, ...args)?.c ?? 0);
    const ratings = store.get('SELECT AVG(rating) a, COUNT(rating) n FROM ticket_records WHERE guild_id=? AND rating IS NOT NULL AND closed_at>=? AND closed_at<=?', guildId, start, end);
    const top = store.get('SELECT type, COUNT(*) c FROM ticket_records WHERE guild_id=? AND opened_at>=? AND opened_at<=? GROUP BY type ORDER BY c DESC LIMIT 1', guildId, start, end);
    const hours = store.get("SELECT AVG((closed_at-opened_at)/3600000.0) h FROM ticket_records WHERE guild_id=? AND status='closed' AND closed_at>=? AND closed_at<=?", guildId, start, end);
    return {
        // The window ends inclusively: a ticket opened in the same millisecond as the report counts.
        opened: count('SELECT COUNT(*) c FROM ticket_records WHERE guild_id=? AND opened_at>=? AND opened_at<=?', start, end),
        openedPrev: count('SELECT COUNT(*) c FROM ticket_records WHERE guild_id=? AND opened_at>=? AND opened_at<?', previous, start),
        closed: count("SELECT COUNT(*) c FROM ticket_records WHERE guild_id=? AND status='closed' AND closed_at>=? AND closed_at<=?", start, end),
        openNow: count("SELECT COUNT(*) c FROM ticket_records WHERE guild_id=? AND status='open'"),
        unclaimed: count("SELECT COUNT(*) c FROM ticket_records WHERE guild_id=? AND status='open' AND claimed_by IS NULL"),
        urgent: count("SELECT COUNT(*) c FROM ticket_records WHERE guild_id=? AND status='open' AND priority IN ('urgent','high')"),
        average: ratings?.n ? Number(ratings.a) : null, ratingCount: Number(ratings?.n ?? 0),
        topType: top ? { name: String(top.type), count: Number(top.c) } : null,
        hoursToClose: hours?.h === null || hours?.h === undefined ? null : Number(hours.h),
        staff: store.all('SELECT claimed_by, COUNT(*) c, AVG(rating) r FROM ticket_records WHERE guild_id=? AND status=\'closed\' AND claimed_by IS NOT NULL AND closed_at>=? AND closed_at<=? GROUP BY claimed_by ORDER BY c DESC LIMIT 5', guildId, start, end)
            .map(r => ({ id: String(r.claimed_by), count: Number(r.c), rating: r.r === null ? null : Number(r.r) })),
    };
}

export function reportEmbed(guild: Guild, report: WeeklyReport, end = Date.now()) {
    const trend = report.openedPrev === 0 ? (report.opened ? ' (new)' : '') : (() => {
        const change = Math.round((report.opened - report.openedPrev) / report.openedPrev * 100);
        return change === 0 ? ' (same as last week)' : ` (${change > 0 ? '▲' : '▼'} ${Math.abs(change)}% vs last week)`;
    })();
    const medals = ['🥇', '🥈', '🥉', '4.', '5.'];
    const card = embed(`📊 Weekly ticket report — ${guild.name}`, `<t:${Math.floor((end - 7 * 86400000) / 1000)}:D> → <t:${Math.floor(end / 1000)}:D>`, Colors.Blurple);
    card.addFields(
        { name: '📥 Opened', value: `**${report.opened}**${trend}`, inline: true },
        { name: '🔒 Closed', value: `**${report.closed}**`, inline: true },
        { name: '⏱️ Avg time to close', value: report.hoursToClose === null ? '—' : `**${report.hoursToClose.toFixed(1)}h**`, inline: true },
        { name: '⭐ Avg rating', value: report.average === null ? 'No ratings' : `**${report.average.toFixed(2)}** (${report.ratingCount} ratings)`, inline: true },
        { name: '🏷️ Most common type', value: report.topType ? `${report.topType.name} (${report.topType.count})` : '—', inline: true },
        { name: '📂 Still open', value: `**${report.openNow}** · ${report.unclaimed} unclaimed · ${report.urgent} high/urgent`, inline: true },
        { name: '🏆 Top staff this week', value: report.staff.map((s, index) => `${medals[index] ?? `${index + 1}.`} <@${s.id}> · ${s.count} closed${s.rating ? ` · ${s.rating.toFixed(1)}⭐` : ''}`).join('\n') || 'No claimed tickets closed' });
    card.setFooter({ text: 'Ghost Vanguard · Turn this off with /ticket settings weekly_report:False' });
    return card;
}

// ---- background upkeep ------------------------------------------------------------------------

export interface MaintenanceDeps { store: Store; client: Client; ready: (id: string) => boolean }

/**
 * Every run: warn tickets that have been quiet for `autoclose_hours`, close ones quiet for an hour
 * past the warning, and post the weekly report when one is due. Runs per authorized server only.
 */
export async function runTicketMaintenance({ store, client, ready }: MaintenanceDeps, now = Date.now()) {
    let warned = 0, closed = 0, reports = 0;
    for (const guild of client.guilds.cache.values()) {
        if (!ready(guild.id))
            continue;
        const outcome = await store.withAuthorized(guild.id, async () => {
            const config = ticketConfig(store, guild.id);
            let localWarned = 0, localClosed = 0, localReports = 0;
            const openRows = store.all("SELECT * FROM ticket_records WHERE guild_id=? AND status='open'", guild.id) as unknown as TicketRecord[];
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
                    await (channel as any).send({ embeds: [embed('⏰ Quiet ticket', `<@${ticket.user_id}> this ticket has been quiet for a while. It closes automatically in **1 hour** unless someone sends a message.`, Colors.Yellow)],
                        allowedMentions: { users: [ticket.user_id] } }).catch(() => {});
                    store.run('UPDATE ticket_records SET warned=1 WHERE guild_id=? AND id=?', guild.id, ticket.id);
                    localWarned++;
                } else if (ticket.warned && idle >= (config.autocloseHours + 1) * 3600000) {
                    await closeTicket({ store, guild, channel, ticket, closer: null, reason: 'Closed automatically for inactivity', config, client });
                    localClosed++;
                }
            }
            if (config.weeklyReport && (config.lastReportAt === null ? now - (store.get('SELECT MIN(opened_at) t FROM ticket_records WHERE guild_id=?', guild.id)?.t ?? now) >= 7 * 86400000 : now - config.lastReportAt >= 7 * 86400000)) {
                const channel = ticketLogChannel(guild, config);
                if (channel) {
                    await channel.send({ embeds: [reportEmbed(guild, weeklyReport(store, guild.id, now), now)], allowedMentions: { parse: [] } }).catch(() => {});
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
export function forgetGuildTickets(store: Store, guildId: string) {
    clearTicketCache(store, guildId);
    for (const [key] of lastOpened)
        if (key.startsWith(`${guildId}:`))
            lastOpened.delete(key);
}

/** Rows for the ticket history view. */
export function ticketHistory(store: Store, guildId: string, userId: string, limit = 15) {
    return store.all('SELECT * FROM ticket_records WHERE guild_id=? AND user_id=? ORDER BY id DESC LIMIT ?', guildId, userId, limit) as unknown as TicketRecord[];
}

export function ticketCount(store: Store, guildId: string, userId: string) {
    return Number(store.get('SELECT COUNT(*) c FROM ticket_records WHERE guild_id=? AND user_id=?', guildId, userId)?.c ?? 0);
}

export function blockedUsers(store: Store, guildId: string) {
    return store.all('SELECT * FROM ticket_blocks WHERE guild_id=? ORDER BY at DESC', guildId);
}

export function blockUser(store: Store, guildId: string, userId: string, reason: string | null, byId: string) {
    store.run('INSERT OR REPLACE INTO ticket_blocks(guild_id,user_id,reason,by_id,at) VALUES(?,?,?,?,?)', guildId, userId, reason ? clip(reason, 300) : null, byId, Date.now());
}

export function unblockUser(store: Store, guildId: string, userId: string) {
    return !!store.run('DELETE FROM ticket_blocks WHERE guild_id=? AND user_id=?', guildId, userId).changes;
}

export function blockedFromTickets(store: Store, guildId: string, userId: string) {
    return store.get('SELECT * FROM ticket_blocks WHERE guild_id=? AND user_id=?', guildId, userId);
}
