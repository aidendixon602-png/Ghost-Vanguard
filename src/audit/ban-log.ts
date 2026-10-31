import {
    ActionRowBuilder, AuditLogEvent, ButtonBuilder, MessageFlags, ButtonStyle, Colors, EmbedBuilder, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle,
    type ButtonInteraction, type Guild, type ModalSubmitInteraction, type User,
} from 'discord.js';
import type { Store } from '../database/db.js';
import type { LogQueue } from '../logging.js';
import { clip, KeyedQueue } from '../core.js';
import { developers } from '../bot/developers.js';
import { canLiftNetworkBan } from '../bot/ranks.js';
import { activeBan, recordId, TAG, type NetworkBan, type NetworkKind } from '../security/network-ban.js';

type NetworkCover = Pick<NetworkBan, 'id' | 'kind' | 'reason' | 'moderator_id' | 'evidence' | 'evidence_file'>;
import { logChannels } from './log-setup.js';
import { redact } from './redact.js';
import { isWhitelistedPerson, whitelistedMessage } from '../bot/trusted-bots.js';

/**
 * The ban log: one record per ban in the server's #bans channel, numbered per server (BAN-####).
 *
 * Every ban is tracked, whoever made it: Vanguard commands, genrebans and hardbans, anti-nuke,
 * other bots and bans done directly in Discord. A ban is detected from Discord's ban event, then
 * Discord's audit log is checked to verify who did it. Nothing is guessed: when the audit log
 * cannot be read, the moderator is shown as unavailable.
 *
 * Unbans (by command, by hand, or a temporary ban expiring) update the same record. The record
 * keeps the original ban details and adds the current status, who changed it and when.
 * The server owner or a Developer can Unban or Reban from the record; each action re-checks
 * authorization and the user's real ban status. Network-wide lifts remain Developer-only.
 */

export const REF = 'banrec';
export type BanStatus = 'banned' | 'unbanned' | 'expired';

export interface BanRecord {
    id: number; guild_id: string; number: number; user_id: string; username: string | null; avatar_url: string | null;
    kind: string; reason: string | null; evidence: string | null; moderator_id: string | null;
    /** via-bot: staff member using Vanguard · manual: in Discord or another bot · automatic: Vanguard itself · unverified */
    moderator_role: 'via-bot' | 'manual' | 'automatic' | 'unverified';
    approved: string | null; duration: string | null; expires_at: number | null; banned_at: number;
    /** The genreban/hardban this ban belongs to, e.g. HB-00005. */
    network_record?: string | null;
    status: BanStatus; status_by: string | null; status_by_role: string | null; status_at: number | null; status_reason: string | null;
    history: string; channel_id: string | null; message_id: string | null;
}
interface HistoryEntry { action: string; by: string | null; role: string | null; at: number; reason?: string | null }

export const caseId = (r: Pick<BanRecord, 'number'>) => `BAN-${String(r.number).padStart(4, '0')}`;
const BAN_SETTLE_MS = 4000;
const KIND_LABEL: Record<string, string> = { ban: 'Ban', tempban: 'Temporary ban', softban: 'Softban', genreban: 'Genreban', hardban: 'Hardban', automatic: 'Automatic ban', manual: 'Ban' };

export function getRecord(store: Store, guildId: string, id: number): BanRecord | undefined {
    return store.get('SELECT * FROM ban_records WHERE guild_id=? AND id=?', guildId, id) as BanRecord | undefined;
}
export function latestRecord(store: Store, guildId: string, userId: string): BanRecord | undefined {
    return store.get('SELECT * FROM ban_records WHERE guild_id=? AND user_id=? ORDER BY id DESC LIMIT 1', guildId, userId) as BanRecord | undefined;
}
const openRecord = (store: Store, guildId: string, userId: string) =>
    store.get("SELECT * FROM ban_records WHERE guild_id=? AND user_id=? AND status='banned' ORDER BY id DESC LIMIT 1", guildId, userId) as BanRecord | undefined;

// ---------------------------------------------------------------- what the audit log says

export interface Verified { executorId: string | null; executorIsBot: boolean; reason: string | null; at: number }

/** The audit-log entry for this ban/unban, if Vanguard can read the audit log and it is recent. */
export async function findAudit(guild: Guild, type: AuditLogEvent.MemberBanAdd | AuditLogEvent.MemberBanRemove, userId: string, now = Date.now()): Promise<Verified | null> {
    if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return null;
    const logs = await guild.fetchAuditLogs({ type, limit: 10 }).catch(() => null);
    const entry = logs?.entries.find(e => e.targetId === userId && now - e.createdTimestamp < 120000);
    if (!entry) return null;
    const executor = entry.executor ?? (entry.executorId ? guild.client.users.cache.get(entry.executorId) : null);
    return { executorId: entry.executorId ?? null, executorIsBot: !!executor?.bot, reason: entry.reason ?? null, at: entry.createdTimestamp };
}

export interface BanDetails {
    kind: string; reason: string | null; evidence: string | null; moderatorId: string | null; moderatorRole: BanRecord['moderator_role'];
    approved: string | null; duration: string | null; expiresAt: number | null;
    networkRecord?: string | null;
}

/** Work out who banned and why from the verified audit entry and Vanguard's own records. */
const NETWORK_DURATION: Record<NetworkKind, string> = { hardban: 'Permanent (re-applied until a developer lifts it)', genreban: 'Permanent (every Midtown server)' };

export function explainBan(store: Store, guild: Guild, userId: string, audit: Verified | null, fallbackReason: string | null, now = Date.now()): BanDetails {
    const botId = guild.client.user?.id;
    const raw = audit?.reason ?? fallbackReason ?? null;
    const d: BanDetails = { kind: 'ban', reason: raw, evidence: null, moderatorId: null, moderatorRole: 'unverified', approved: null, duration: 'Permanent', expiresAt: null };
    // Genreban / hardban: "[Vanguard genreban] GB-00001 <developer id>: reason"
    for (const kind of ['hardban', 'genreban'] as NetworkKind[]) {
        if (!raw?.startsWith(TAG[kind])) continue;
        const m = /^\S+ \S+ (?:[GH]B-\d+ )?(\d{17,20}): ([\s\S]*)$/.exec(raw);
        const record = activeBan(store, kind, userId);
        d.kind = kind; d.reason = record?.reason ?? m?.[2] ?? raw; d.evidence = [record?.evidence, record?.evidence_file].filter(Boolean).join('\n') || null;
        d.moderatorId = record?.moderator_id ?? m?.[1] ?? null; d.moderatorRole = audit?.executorId === botId ? 'via-bot' : 'unverified';
        d.approved = record ? `<@${record.moderator_id}> (developer) · ${recordId(record)}` : null;
        d.duration = NETWORK_DURATION[kind];
        d.networkRecord = record ? recordId(record) : /\b([GH]B-\d+)\b/.exec(raw)?.[1] ?? null;
        return d;
    }
    if (audit && audit.executorId === botId) {
        const staff = /^(\d{17,20}): ([\s\S]*)$/.exec(raw ?? '');
        if (staff) {
            d.moderatorId = staff[1]!; d.moderatorRole = 'via-bot'; d.reason = staff[2]!;
            const temp = /^tempban ([^:]+): ([\s\S]*)$/.exec(d.reason);
            if (temp) { d.kind = 'tempban'; d.duration = temp[1]!; d.reason = temp[2]!; }
            const soft = /^softban: ([\s\S]*)$/.exec(d.reason);
            if (soft) { d.kind = 'softban'; d.duration = 'None (unbanned straight away)'; d.reason = soft[1]!; }
        } else {
            d.kind = 'automatic'; d.moderatorId = botId ?? null; d.moderatorRole = 'automatic';
            d.reason = raw?.replace(/^(?:Midtown |Ghost )Vanguard: /, '') ?? null;
        }
    } else if (audit?.executorId) {
        d.moderatorId = audit.executorId; d.moderatorRole = 'manual'; d.kind = 'manual';
    }
    const tempban = store.get('SELECT until FROM tempbans WHERE guild_id=? AND user_id=?', guild.id, userId);
    if (tempban) { d.kind = 'tempban'; d.expiresAt = Number(tempban.until); }
    // Evidence attached to the case the command recorded (within the last two minutes).
    const kase = store.get("SELECT evidence FROM cases WHERE guild_id=? AND user_id=? AND at>=? AND (action LIKE '%ban%') ORDER BY id DESC LIMIT 1", guild.id, userId, now - 120000);
    if (kase?.evidence) d.evidence = String(kase.evidence);
    return d;
}

// ---------------------------------------------------------------- creating and updating records

function pushHistory(record: Pick<BanRecord, 'history'>, entry: HistoryEntry): string {
    const list = JSON.parse(record.history || '[]') as HistoryEntry[];
    list.push(entry);
    return JSON.stringify(list.slice(-20));
}

export function createRecord(store: Store, guildId: string, user: { id: string; tag?: string | null; username?: string | null; avatar?: string | null }, d: BanDetails, at = Date.now()): BanRecord {
    const history = JSON.stringify([{ action: 'banned', by: d.moderatorId, role: d.moderatorRole, at, reason: null }]);
    const id = Number(store.run(`INSERT INTO ban_records(guild_id,number,user_id,username,avatar_url,kind,reason,evidence,moderator_id,moderator_role,approved,duration,expires_at,banned_at,status,history,network_record)
        VALUES(?, (SELECT COALESCE(MAX(number),0)+1 FROM ban_records WHERE guild_id=?), ?,?,?,?,?,?,?,?,?,?,?,?,'banned',?,?)`,
        guildId, guildId, user.id, user.tag ?? user.username ?? null, user.avatar ?? null, d.kind, redact(d.reason) ?? null, redact(d.evidence) ?? null, d.moderatorId, d.moderatorRole,
        d.approved, d.duration, d.expiresAt, at, history, d.networkRecord ?? null).lastInsertRowid);
    return getRecord(store, guildId, id)!;
}

export function setStatus(store: Store, record: BanRecord, status: BanStatus, by: string | null, role: string | null, reason: string | null, at = Date.now()) {
    const history = pushHistory(record, { action: status === 'banned' ? 'rebanned' : status, by, role, at, reason: redact(reason) });
    store.run('UPDATE ban_records SET status=?,status_by=?,status_by_role=?,status_at=?,status_reason=?,history=? WHERE guild_id=? AND id=?',
        status, by, role, at, redact(reason) ?? null, history, record.guild_id, record.id);
    return getRecord(store, record.guild_id, record.id)!;
}

/**
 * /mod ban on someone who is already banned (by hand, by another bot, or before the ban log existed):
 * Discord's ban stays as it is, and this staff member's reason and evidence go on the record, so the
 * ban is explained in #bans. Updates the open record, or starts one if there is none.
 */
export function recordExistingBan(store: Store, logs: LogQueue, guildId: string, user: { id: string; tag?: string | null; username?: string | null; avatar?: string | null },
    staffId: string, reason: string, evidence: string | null, at = Date.now(), change: { kind?: string; duration?: string; expiresAt?: number | null } = {}): { record: BanRecord; isNew: boolean } {
    const open = openRecord(store, guildId, user.id);
    if (!open) {
        const record = createRecord(store, guildId, user, { kind: change.kind ?? 'ban', reason, evidence, moderatorId: staffId, moderatorRole: 'via-bot', approved: null, duration: change.duration ?? 'Permanent', expiresAt: change.expiresAt ?? null }, at);
        const history = pushHistory(record, { action: 'recorded (was already banned)', by: staffId, role: 'via-bot', at, reason: null });
        store.run('UPDATE ban_records SET history=? WHERE guild_id=? AND id=?', history, guildId, record.id);
        const fresh = getRecord(store, guildId, record.id)!;
        publish(store, logs, fresh, true);
        return { record: fresh, isNew: true };
    }
    const history = pushHistory(open, { action: 'reason added', by: staffId, role: 'via-bot', at, reason: redact(reason) });
    // Someone unknown (or a bot without a reason) banned them: the staff member now stands behind it.
    const takeOver = !open.moderator_id || open.moderator_role === 'unverified' || !open.reason;
    store.run(`UPDATE ban_records SET reason=?, evidence=?, history=?${takeOver ? ", moderator_id=?, moderator_role='via-bot'" : ''} WHERE guild_id=? AND id=?`,
        redact(reason) ?? null, redact([open.evidence, evidence].filter(Boolean).join('\n')) || null, history, ...(takeOver ? [staffId] : []), guildId, open.id);
    // e.g. a tempban on someone already banned: the record now shows when the ban ends.
    if (change.kind) store.run('UPDATE ban_records SET kind=?, duration=?, expires_at=? WHERE guild_id=? AND id=?', change.kind, change.duration ?? null, change.expiresAt ?? null, guildId, open.id);
    const updated = getRecord(store, guildId, open.id)!;
    publish(store, logs, updated, false);
    return { record: updated, isNew: false };
}

/** Post a new record to #bans, or refresh the message it already has. */
export function publish(store: Store, logs: LogQueue, record: BanRecord, isNew: boolean) {
    if (!isNew) return logs.refreshRef(record.guild_id, REF, record.id);
    const channel = logChannels(store, record.guild_id).bansChannelId;
    if (channel) logs.pushRef(record.guild_id, channel, REF, record.id);
}

/** Lets the log queue render records from the database when it posts or edits them. */
export function registerBanLogRenderer(store: Store, logs: LogQueue) {
    // Reads are scoped to the record's own server, inside or outside a server context.
    const find = (guildId: string, id: number) => store.get('SELECT * FROM ban_records WHERE guild_id=? AND id=?', guildId, id) as BanRecord | undefined;
    logs.refs.set(REF, {
        render: (guildId, id) => { const r = find(guildId, id); return r ? renderRecord(r) : null; },
        location: (guildId, id) => { const r = find(guildId, id); return r?.channel_id && r.message_id ? { channelId: r.channel_id, messageId: r.message_id } : null; },
        posted: (guildId, id, channelId, messageId) => {
            void store.withAuthorized(guildId, async () => store.run('UPDATE ban_records SET channel_id=?,message_id=? WHERE guild_id=? AND id=?', channelId, messageId, guildId, id));
        },
    });
}

const queue = new KeyedQueue();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const timing = { settleMs: BAN_SETTLE_MS };

/** Discord reported a ban. Wait briefly for the audit log and Vanguard's case, then record it once. */
export async function onBanAdd(store: Store, logs: LogQueue, guild: Guild, user: User, fetchedReason: string | null = null) {
    await sleep(timing.settleMs);
    return queue.run(`${guild.id}:${user.id}`, async () => {
        const audit = await findAudit(guild, AuditLogEvent.MemberBanAdd, user.id);
        const reason = audit?.reason ?? fetchedReason ?? (await guild.bans.fetch({ user: user.id, force: true }).catch(() => null))?.reason ?? null;
        return store.withAuthorized(guild.id, async () => {
            // Already tracked: a reban from the ban log, or a duplicate event.
            if (openRecord(store, guild.id, user.id)) return null;
            const record = createRecord(store, guild.id, { id: user.id, tag: user.tag, username: user.username, avatar: user.displayAvatarURL() }, explainBan(store, guild, user.id, audit, reason));
            publish(store, logs, record, true);
            return record;
        });
    });
}

/** Discord reported an unban: update the user's open record, or start one if the ban predates the log. */
export async function onBanRemove(store: Store, logs: LogQueue, guild: Guild, user: User) {
    await sleep(timing.settleMs);
    return queue.run(`${guild.id}:${user.id}`, async () => {
        const audit = await findAudit(guild, AuditLogEvent.MemberBanRemove, user.id);
        return store.withAuthorized(guild.id, async () => {
            const botId = guild.client.user?.id;
            let by: string | null = null, role: string | null = 'unverified', reason = audit?.reason ?? null, status: BanStatus = 'unbanned';
            if (audit?.executorId === botId) {
                const staff = /^(\d{17,20}): ([\s\S]*)$/.exec(reason ?? '');
                if (staff) { by = staff[1]!; role = 'via-bot'; reason = staff[2]!; }
                else { by = botId ?? null; role = 'automatic'; reason = reason?.replace(/^(?:Midtown |Ghost )Vanguard: /, '') ?? null; if (/temporary ban expired/i.test(reason ?? '')) status = 'expired'; }
            } else if (audit?.executorId) { by = audit.executorId; role = 'manual'; }
            const open = openRecord(store, guild.id, user.id);
            if (open) {
                const updated = setStatus(store, open, status, by, role, reason);
                publish(store, logs, updated, false);
                return updated;
            }
            // Recently updated by the ban log's own Unban button: nothing to add.
            const latest = latestRecord(store, guild.id, user.id);
            if (latest && latest.status !== 'banned' && (latest.status_at ?? 0) > Date.now() - 120000) return latest;
            // A ban from before the ban log existed: keep a record of the unban, details marked unavailable.
            const record = createRecord(store, guild.id, { id: user.id, tag: user.tag, username: user.username, avatar: user.displayAvatarURL() },
                { kind: 'ban', reason: null, evidence: null, moderatorId: null, moderatorRole: 'unverified', approved: null, duration: null, expiresAt: null }, 0);
            const updated = setStatus(store, record, status, by, role, reason);
            publish(store, logs, updated, true);
            return updated;
        });
    });
}

/**
 * A genreban or hardban reached a server where the user was already banned by the server's own
 * staff. The existing ban stays (Discord keeps one ban per user) and the record is upgraded:
 * it now shows the network ban, its record ID, approval and evidence, and is enforced by it
 * (re-applied if anyone unbans them). A ban from before the ban log gets a new record.
 */
export function coverWithNetwork(store: Store, logs: LogQueue, guildId: string, user: { id: string; tag?: string | null }, ban: NetworkCover, at = Date.now()) {
    const id = recordId(ban);
    const open = openRecord(store, guildId, user.id);
    const approved = `<@${ban.moderator_id}> (developer) · ${id}`;
    const evidence = [ban.evidence, ban.evidence_file].filter(Boolean).join('\n') || null;
    if (open) {
        if (open.network_record === id) return open;
        const history = pushHistory(open, { action: `now covered by ${ban.kind} ${id} (was ${KIND_LABEL[open.kind]?.toLowerCase() ?? open.kind})`, by: ban.moderator_id, role: 'via-bot', at, reason: open.kind });
        store.run('UPDATE ban_records SET kind=?,network_record=?,approved=?,duration=?,evidence=COALESCE(evidence,?),expires_at=NULL,history=? WHERE guild_id=? AND id=?',
            ban.kind, id, approved, NETWORK_DURATION[ban.kind], redact(evidence) ?? null, history, guildId, open.id);
        const updated = getRecord(store, guildId, open.id)!;
        publish(store, logs, updated, false);
        return updated;
    }
    const record = createRecord(store, guildId, { id: user.id, tag: user.tag ?? null },
        { kind: ban.kind, reason: ban.reason, evidence, moderatorId: ban.moderator_id, moderatorRole: 'via-bot', approved, duration: NETWORK_DURATION[ban.kind], expiresAt: null, networkRecord: id }, at);
    publish(store, logs, record, true);
    return record;
}

/**
 * The genreban/hardban was lifted, but the server's own ban stays: the record goes back to the
 * kind of ban it was before, keeps every detail, and says what happened.
 */
export function uncoverNetwork(store: Store, logs: LogQueue, guildId: string, userId: string, ban: NetworkCover, by: string, at = Date.now()) {
    const id = recordId(ban);
    const open = openRecord(store, guildId, userId);
    if (!open || open.network_record !== id) return null;
    const previous = [...(JSON.parse(open.history || '[]') as HistoryEntry[])].reverse().find(h => h.action.startsWith(`now covered by ${ban.kind} ${id}`))?.reason ?? 'ban';
    const history = pushHistory(open, { action: `${id} lifted; this server's own ban stays`, by, role: 'via-bot', at, reason: null });
    store.run("UPDATE ban_records SET kind=?,network_record=NULL,approved=NULL,duration='Permanent',history=? WHERE guild_id=? AND id=?", previous, history, guildId, open.id);
    const updated = getRecord(store, guildId, open.id)!;
    publish(store, logs, updated, false);
    return updated;
}

// ---------------------------------------------------------------- how a record looks

const who = (id: string | null, role: string | null) => {
    if (!id || role === 'unverified') return 'Unavailable (could not be verified)';
    if (role === 'automatic') return `Ghost Vanguard (automatic)`;
    return `<@${id}> ( ${id} )`;
};
const moderatorHeading = (r: BanRecord) => r.moderator_role === 'via-bot' ? 'Moderator (via bot)' : 'Banned By';
const ts = (ms: number, style = 'f') => `<t:${Math.floor(ms / 1000)}:${style}>`;

export function renderRecord(r: BanRecord) {
    const banned = r.status === 'banned';
    const statusWord = banned ? 'Banned' : r.status === 'expired' ? 'Ban expired' : 'Unbanned';
    const e = new EmbedBuilder().setColor(banned ? 0xB10F2E : 0x43B581)
        .setAuthor({ name: `• ${r.username ?? r.user_id} - ${statusWord}`, iconURL: r.avatar_url ?? undefined })
        .setFooter({ text: `User ID: ${r.user_id}${r.network_record ? ` • ${r.network_record}` : ''}` });
    if (r.banned_at) e.setTimestamp(r.banned_at);
    const fields: { name: string; value: string; inline?: boolean }[] = [
        { name: 'User', value: `<@${r.user_id}>\n( ${r.user_id} )`, inline: true },
        { name: r.banned_at ? moderatorHeading(r) : 'Banned By', value: r.banned_at ? who(r.moderator_id, r.moderator_role) : 'Unavailable (banned before ban logging started)', inline: true },
        { name: 'Reason', value: clip(r.reason || (r.banned_at ? 'No reason given' : 'Unavailable'), 1024) },
    ];
    if (r.evidence) fields.push({ name: 'Evidence', value: clip(r.evidence, 1024) });
    if (r.approved) fields.push({ name: 'Approved by', value: clip(r.approved, 1024) });
    if (r.duration && r.kind !== 'ban' && r.kind !== 'manual') fields.push({ name: 'Type', value: KIND_LABEL[r.kind] ?? r.kind, inline: true });
    if (r.duration) fields.push({ name: 'Duration', value: r.duration, inline: true });
    if (r.expires_at) fields.push({ name: banned ? 'Expires' : 'Was due to expire', value: `${ts(r.expires_at)} (${ts(r.expires_at, 'R')})`, inline: true });
    if (r.banned_at) fields.push({ name: 'Banned', value: ts(r.banned_at), inline: true });
    if (r.status_at) {
        const action = r.status === 'banned' ? 'Rebanned' : r.status === 'expired' ? 'Expired' : 'Unbanned';
        fields.push({ name: 'Status', value: clip(`${action} by ${who(r.status_by, r.status_by_role)} · ${ts(r.status_at)}${r.status_reason ? `\n**Reason:** ${r.status_reason}` : ''}`, 1024) });
    }
    const history = JSON.parse(r.history || '[]') as HistoryEntry[];
    if (history.length > 2)
        fields.push({ name: 'History', value: clip(history.slice(-6).map(h => `${ts(h.at, 'd')} ${h.action} · ${h.role === 'unverified' || !h.by ? 'unverified' : h.role === 'automatic' ? 'automatic' : `<@${h.by}>`}`).join('\n'), 1024) });
    e.addFields(fields);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`${REF}:unban:${r.id}`).setLabel('Unban').setStyle(ButtonStyle.Success).setDisabled(!banned),
        new ButtonBuilder().setCustomId(`${REF}:reban:${r.id}`).setLabel('Reban').setStyle(ButtonStyle.Danger).setDisabled(banned),
    );
    return { embeds: [e.toJSON()], components: [row.toJSON()] };
}

// ---------------------------------------------------------------- developer buttons

export interface BanButtonDeps {
    store: Store; logs: LogQueue;
    /** Lifts a ban only if it is not a genreban/hardban (those belong to `/ungenreban` and `/unhardban`). */
    assertLocalUnban: (guild: Guild, userId: string) => Promise<void>;
    /**
     * Genrebans and hardbans: the active one for this user (shown as e.g. "HB-00005"), and a way
     * for Developers to lift it everywhere (same as `/unhardban` or `/ungenreban`).
     */
    network?: {
        active(userId: string): { kind: 'genreban' | 'hardban'; record: string } | null;
        lift(userId: string, by: { id: string; tag?: string }, reason: string): Promise<{ lifted: number; failed: number; servers: number }>;
    };
}

const NOT_ALLOWED = 'Only the server owner and Ghost Vanguard developers can use the ban log buttons.';
const networkLifter = (_kind: NetworkKind) => 'Developer';
const notNetwork = (kind: NetworkKind) => `This is a Midtown-wide **${kind}**: only a ${networkLifter(kind)} can lift it. Server Admins and owners can lift ordinary bans only.`;
const LOCAL_FOOTER = 'The server owner and developers can do this';
const confirmRow = (id: number, action: 'unban' | 'reban', label?: string) => new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${REF}:c${action}:${id}`).setLabel(label ?? (action === 'unban' ? 'Unban' : 'Reban')).setEmoji(action === 'unban' ? '🔓' : '🔨').setStyle(action === 'unban' ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${REF}:cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary));

const KIND_TITLE: Record<string, string> = { genreban: 'Genreban', hardban: 'Hardban', tempban: 'Temporary ban', softban: 'Softban', automatic: 'Automatic ban' };

/** The private prompts and results for the ban log buttons: same look as the record itself. */
function card(r: BanRecord, o: { title: string; color: number; ban?: string; fields?: { name: string; value: string; inline?: boolean }[]; footer?: string }) {
    const e = new EmbedBuilder().setColor(o.color).setTitle(o.title)
        .setAuthor({ name: r.username ?? r.user_id, iconURL: r.avatar_url ?? undefined })
        .addFields(
            { name: 'User', value: `<@${r.user_id}>\n\`${r.user_id}\``, inline: true },
            { name: 'Ban', value: o.ban ?? KIND_TITLE[r.kind] ?? 'Ban', inline: true },
            ...(o.fields ?? []),
        );
    if (o.footer) e.setFooter({ text: o.footer });
    return e;
}
const reasonField = (r: BanRecord) => ({ name: 'Original reason', value: clip(r.reason || 'No reason provided', 1024) });

/** Is this user banned right now? true / false, or null when Discord could not be asked. */
async function bannedNow(guild: Guild, userId: string): Promise<boolean | null> {
    try { await guild.bans.fetch({ user: userId, force: true }); return true; }
    catch (error: any) { return error?.code === 10026 ? false : null; }
}

/**
 * Handles every ban-log button and form. Checked on every single interaction:
 * ordinary bans: Admin rank (or Discord Administrator), the owner or a developer;
 * genrebans and hardbans: Developers only.
 */
export async function handleBanLogInteraction(i: ButtonInteraction<'cached'> | ModalSubmitInteraction<'cached'>, deps: BanButtonDeps) {
    const [, action, raw] = i.customId.split(':');
    const reply = (content: string) => i.replied || i.deferred ? i.followUp({ content, flags: MessageFlags.Ephemeral }) : i.reply({ content, flags: MessageFlags.Ephemeral });
    // These controls are deliberately narrower than /mod unban: only the guild owner or a Developer may use them.
    if (!developers.has(i.user.id) && i.guild.ownerId !== i.user.id) return reply(NOT_ALLOWED);
    if (action === 'cancel') return i.isButton() ? i.update({ content: 'Cancelled. Nothing was changed.', embeds: [], components: [] }) : undefined;
    const id = Number(raw);
    const { store, logs } = deps;
    return store.withAuthorized(i.guildId, async () => {
        const record = getRecord(store, i.guildId, id);
        if (!record) return reply('That ban record no longer exists.');
        const live = await bannedNow(i.guild, record.user_id);
        if (live === null) return reply('Discord could not confirm whether they are banned right now (Vanguard may be missing Ban Members). Nothing was changed.');
        const label = `**${record.username ?? record.user_id}** (\`${record.user_id}\`)`;
        // The record and Discord disagree (an event was missed): fix the record first, without guessing who did it.
        if (live !== (record.status === 'banned')) {
            const fixed = setStatus(store, record, live ? 'banned' : 'unbanned', null, 'unverified', 'Status corrected from Discord: the change was made while it was not being tracked.');
            publish(store, logs, fixed, false);
            return reply(`${label} is ${live ? 'already banned' : 'no longer banned'} on Discord, so the record was corrected. Nothing else was changed.`);
        }
        const net = deps.network?.active(record.user_id) ?? null;
        if (net && (action === 'unban' || action === 'cunban') && !canLiftNetworkBan(store, i.user.id, net.kind))
            return i.isButton() && action === 'cunban' ? i.update({ content: notNetwork(net.kind), embeds: [], components: [] }) : reply(notNetwork(net.kind));
        if (action === 'unban') {
            if (!live) return reply(`${label} is not banned.`);
            const name = record.username ?? record.user_id;
            if (net) return i.reply({ flags: MessageFlags.Ephemeral, embeds: [card(record, { title: `🔓 Unban ${name}?`, color: Colors.Blurple, ban: `${KIND_TITLE[net.kind]} · ${net.record}`,
                fields: [reasonField(record), { name: 'What happens', value: `• Unbanned in **every** Midtown server\n• ${net.record} is closed, so it won't be re-applied\n• Bans placed by a server's own staff stay` }],
                footer: `Only a ${networkLifter(net.kind)} can do this` })], components: [confirmRow(id, 'unban', 'Unban everywhere')] });
            return i.reply({ flags: MessageFlags.Ephemeral, embeds: [card(record, { title: `🔓 Unban ${name}?`, color: Colors.Blurple,
                fields: [reasonField(record), { name: 'What happens', value: '• They can rejoin this server\n• This ban record is updated, not deleted' }],
                footer: LOCAL_FOOTER })], components: [confirmRow(id, 'unban')] });
        }
        if (action === 'reban' || action === 'rebanform' || action === 'creban') {
            if (isWhitelistedPerson(record.user_id)) return reply(whitelistedMessage(record.user_id));
        }
        if (action === 'reban') {
            if (live) return reply(`${label} is already banned.`);
            if (!i.isButton()) return;
            return i.showModal(new ModalBuilder().setCustomId(`${REF}:rebanform:${id}`).setTitle(`Reban ${clip(record.username ?? record.user_id, 35)}`).addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason for the reban (required)')
                    .setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(3).setMaxLength(450))));
        }
        if (action === 'rebanform' && i.isModalSubmit()) {
            const reason = i.fields.getTextInputValue('reason').trim();
            if (reason.length < 3) return reply('A reason is required.');
            return i.reply({ flags: MessageFlags.Ephemeral, embeds: [card(record, { title: `🔨 Reban ${record.username ?? record.user_id}?`, color: Colors.Red,
                fields: [reasonField(record), { name: 'Reban reason', value: clip(reason, 1024) }, { name: 'What happens', value: '• They are banned from this server again\n• This ban record is updated with your reason' }],
                footer: LOCAL_FOOTER })], components: [confirmRow(id, 'reban')] });
        }
        if (action === 'cunban' && i.isButton()) {
            if (!live) return i.update({ content: `${label} is not banned any more. Nothing was changed.`, embeds: [], components: [] });
            if (net && deps.network) {
                const reason = 'Lifted from the ban log';
                await i.update({ embeds: [card(record, { title: `⏳ Unbanning ${record.username ?? record.user_id} everywhere…`, color: Colors.Blurple, ban: `${KIND_TITLE[net.kind]} · ${net.record}` })], components: [] });
                // Is this server's ban the network ban itself, or the server's own ban that it covers?
                const own = !TAG[net.kind] || !(await i.guild.bans.fetch({ user: record.user_id, force: true }).catch(() => null))?.reason?.startsWith(TAG[net.kind]);
                // Recorded first, so the unban events that follow do not add a second entry.
                if (!own) publish(store, logs, setStatus(store, record, 'unbanned', i.user.id, 'via-bot', `${net.kind} ${net.record} lifted by a ${networkLifter(net.kind)}`), false);
                const result = await deps.network.lift(record.user_id, { id: i.user.id, tag: i.user.tag }, reason);
                if (own) return i.editReply({ embeds: [card(getRecord(store, i.guildId, record.id) ?? record, { title: `✅ ${net.record} lifted everywhere`, color: Colors.Green, ban: `${KIND_TITLE[net.kind]} · ${net.record} (closed)`,
                    fields: [{ name: 'Servers', value: `Unbanned in **${result.lifted} of ${result.servers}**` }, { name: 'This server', value: "Still banned: this server's own ban was there first and stays. Press **Unban** again to lift it too." }],
                    footer: 'The ban record has been updated' })] });
                return i.editReply({ embeds: [card(record, { title: `${result.failed ? '⚠️' : '✅'} ${record.username ?? record.user_id} unbanned`, color: result.failed ? Colors.Orange : Colors.Green, ban: `${KIND_TITLE[net.kind]} · ${net.record} (closed)`,
                    fields: [{ name: 'Servers', value: `Unbanned in **${result.lifted} of ${result.servers}**${result.failed ? `\n${result.failed} could not be reached: check Vanguard's Ban Members permission there` : ''}` }],
                    footer: 'The ban record has been updated' })] });
            }
            try { await deps.assertLocalUnban(i.guild, record.user_id); }
            catch (error) { return i.update({ content: error instanceof Error ? error.message : 'This ban cannot be lifted here.', embeds: [], components: [] }); }
            const reason = 'Unbanned from the ban log';
            await i.guild.members.unban(record.user_id, clip(`${i.user.id}: ${reason}`, 500));
            const updated = setStatus(store, record, 'unbanned', i.user.id, 'via-bot', reason);
            publish(store, logs, updated, false);
            return i.update({ embeds: [card(updated, { title: `✅ ${record.username ?? record.user_id} unbanned`, color: Colors.Green, footer: 'The ban record has been updated' })], components: [] });
        }
        if (action === 'creban' && i.isButton()) {
            const reason = i.message.embeds[0]?.fields.find(f => f.name === 'Reban reason')?.value;
            if (!reason) return i.update({ content: 'The reban reason was missing. Press Reban again.', embeds: [], components: [] });
            if (live) return i.update({ content: `${label} is already banned. Nothing was changed.`, embeds: [], components: [] });
            if (record.user_id === i.guild.ownerId) return i.update({ content: 'The server owner cannot be banned.', embeds: [], components: [] });
            // Update the record first so the ban event that follows does not start a second record.
            const updated = setStatus(store, record, 'banned', i.user.id, 'via-bot', reason);
            try { await i.guild.members.ban(record.user_id, { reason: clip(`${i.user.id}: Reban: ${reason}`, 500) }); }
            catch (error) {
                const reverted = setStatus(store, updated, 'unbanned', null, 'unverified', `Reban by <@${i.user.id}> failed: ${error instanceof Error ? error.message : 'unknown error'}`);
                publish(store, logs, reverted, false);
                return i.update({ embeds: [card(record, { title: '❌ Reban failed', color: Colors.Red, fields: [{ name: 'Why', value: clip(`${error instanceof Error ? error.message : 'unknown error'}. Check Vanguard's role is above theirs and it has Ban Members.`, 1024) }] })], components: [] });
            }
            publish(store, logs, updated, false);
            return i.update({ embeds: [card(updated, { title: `🔨 ${record.username ?? record.user_id} rebanned`, color: Colors.Red, fields: [{ name: 'Reban reason', value: clip(reason, 1024) }], footer: 'The ban record has been updated' })], components: [] });
        }
        return reply('That button is no longer valid.');
    });
}
