import { ActionRowBuilder, AuditLogEvent, ButtonBuilder, MessageFlags, ButtonStyle, Colors, EmbedBuilder, ModalBuilder, PermissionFlagsBits, TextInputBuilder, TextInputStyle, } from 'discord.js';
import { clip, Cooldowns, KeyedQueue } from '../core.js';
import { developers } from '../bot/developers.js';
import { logEvent } from '../errors.js';
import { canLiftNetworkBan } from '../bot/ranks.js';
import { activeBan, recordId, TAG } from '../security/network-ban.js';
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
 * Repeated button actions are cooled down for 500 ms; successful actions post a public attribution note.
 */
export const REF = 'banrec';
export const caseId = (r) => `BAN-${String(r.number).padStart(4, '0')}`;
const BAN_SETTLE_MS = 4000;
const KIND_LABEL = { ban: 'Ban', tempban: 'Temporary ban', softban: 'Softban', genreban: 'Genreban', hardban: 'Hardban', automatic: 'Automatic ban', manual: 'Ban' };
export function getRecord(store, guildId, id) {
    return store.get('SELECT * FROM ban_records WHERE guild_id=? AND id=?', guildId, id);
}
export function latestRecord(store, guildId, userId) {
    return store.get('SELECT * FROM ban_records WHERE guild_id=? AND user_id=? ORDER BY id DESC LIMIT 1', guildId, userId);
}
const openRecord = (store, guildId, userId) => store.get("SELECT * FROM ban_records WHERE guild_id=? AND user_id=? AND status='banned' ORDER BY id DESC LIMIT 1", guildId, userId);
/** The audit-log entry for this ban/unban, if Vanguard can read the audit log and it is recent. */
export async function findAudit(guild, type, userId, now = Date.now()) {
    if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog))
        return null;
    const logs = await guild.fetchAuditLogs({ type, limit: 10 }).catch(() => null);
    const entry = logs?.entries.find(e => e.targetId === userId && now - e.createdTimestamp < 120000);
    if (!entry)
        return null;
    const executor = entry.executor ?? (entry.executorId ? guild.client.users.cache.get(entry.executorId) : null);
    return { executorId: entry.executorId ?? null, executorIsBot: !!executor?.bot, reason: entry.reason ?? null, at: entry.createdTimestamp };
}
/** Work out who banned and why from the verified audit entry and Vanguard's own records. */
const NETWORK_DURATION = { hardban: 'Permanent (re-applied until a developer lifts it)', genreban: 'Permanent (every Midtown server)' };
export function explainBan(store, guild, userId, audit, fallbackReason, now = Date.now()) {
    const botId = guild.client.user?.id;
    const raw = audit?.reason ?? fallbackReason ?? null;
    const d = { kind: 'ban', reason: raw, evidence: null, moderatorId: null, moderatorRole: 'unverified', approved: null, duration: 'Permanent', expiresAt: null };
    // Genreban / hardban: "[Vanguard genreban] GB-00001 <developer id>: reason"
    for (const kind of ['hardban', 'genreban']) {
        if (!raw?.startsWith(TAG[kind]))
            continue;
        const m = /^\S+ \S+ (?:[GH]B-\d+ )?(\d{17,20}): ([\s\S]*)$/.exec(raw);
        const record = activeBan(store, kind, userId);
        d.kind = kind;
        d.reason = record?.reason ?? m?.[2] ?? raw;
        d.evidence = [record?.evidence, record?.evidence_file].filter(Boolean).join('\n') || null;
        d.moderatorId = record?.moderator_id ?? m?.[1] ?? null;
        d.moderatorRole = audit?.executorId === botId ? 'via-bot' : 'unverified';
        d.approved = record ? `<@${record.moderator_id}> (developer) · ${recordId(record)}` : null;
        d.duration = NETWORK_DURATION[kind];
        d.networkRecord = record ? recordId(record) : /\b([GH]B-\d+)\b/.exec(raw)?.[1] ?? null;
        return d;
    }
    if (audit && audit.executorId === botId) {
        const staff = /^(\d{17,20}): ([\s\S]*)$/.exec(raw ?? '');
        if (staff) {
            d.moderatorId = staff[1];
            d.moderatorRole = 'via-bot';
            d.reason = staff[2];
            const temp = /^tempban ([^:]+): ([\s\S]*)$/.exec(d.reason);
            if (temp) {
                d.kind = 'tempban';
                d.duration = temp[1];
                d.reason = temp[2];
            }
            const soft = /^softban: ([\s\S]*)$/.exec(d.reason);
            if (soft) {
                d.kind = 'softban';
                d.duration = 'None (unbanned straight away)';
                d.reason = soft[1];
            }
        }
        else {
            d.kind = 'automatic';
            d.moderatorId = botId ?? null;
            d.moderatorRole = 'automatic';
            d.reason = raw?.replace(/^(?:Midtown |Ghost )Vanguard: /, '') ?? null;
        }
    }
    else if (audit?.executorId) {
        d.moderatorId = audit.executorId;
        d.moderatorRole = 'manual';
        d.kind = 'manual';
    }
    const tempban = store.get('SELECT until FROM tempbans WHERE guild_id=? AND user_id=?', guild.id, userId);
    if (tempban) {
        d.kind = 'tempban';
        d.expiresAt = Number(tempban.until);
    }
    // Evidence attached to the case the command recorded (within the last two minutes).
    const kase = store.get("SELECT evidence FROM cases WHERE guild_id=? AND user_id=? AND at>=? AND (action LIKE '%ban%') ORDER BY id DESC LIMIT 1", guild.id, userId, now - 120000);
    if (kase?.evidence)
        d.evidence = String(kase.evidence);
    return d;
}
// ---------------------------------------------------------------- creating and updating records
function pushHistory(record, entry) {
    const list = JSON.parse(record.history || '[]');
    list.push(entry);
    return JSON.stringify(list.slice(-20));
}
export function createRecord(store, guildId, user, d, at = Date.now()) {
    const history = JSON.stringify([{ action: 'banned', by: d.moderatorId, role: d.moderatorRole, at, reason: null }]);
    const id = Number(store.run(`INSERT INTO ban_records(guild_id,number,user_id,username,avatar_url,kind,reason,evidence,moderator_id,moderator_role,approved,duration,expires_at,banned_at,status,history,network_record)
        VALUES(?, (SELECT COALESCE(MAX(number),0)+1 FROM ban_records WHERE guild_id=?), ?,?,?,?,?,?,?,?,?,?,?,?,'banned',?,?)`, guildId, guildId, user.id, user.tag ?? user.username ?? null, user.avatar ?? null, d.kind, redact(d.reason) ?? null, redact(d.evidence) ?? null, d.moderatorId, d.moderatorRole, d.approved, d.duration, d.expiresAt, at, history, d.networkRecord ?? null).lastInsertRowid);
    return getRecord(store, guildId, id);
}
export function setStatus(store, record, status, by, role, reason, at = Date.now()) {
    const history = pushHistory(record, { action: status === 'banned' ? 'rebanned' : status, by, role, at, reason: redact(reason) });
    store.run('UPDATE ban_records SET status=?,status_by=?,status_by_role=?,status_at=?,status_reason=?,history=? WHERE guild_id=? AND id=?', status, by, role, at, redact(reason) ?? null, history, record.guild_id, record.id);
    return getRecord(store, record.guild_id, record.id);
}
/**
 * /mod ban on someone who is already banned (by hand, by another bot, or before the ban log existed):
 * Discord's ban stays as it is, and this staff member's reason and evidence go on the record, so the
 * ban is explained in #bans. Updates the open record, or starts one if there is none.
 */
export function recordExistingBan(store, logs, guildId, user, staffId, reason, evidence, at = Date.now(), change = {}) {
    const open = openRecord(store, guildId, user.id);
    if (!open) {
        const record = createRecord(store, guildId, user, { kind: change.kind ?? 'ban', reason, evidence, moderatorId: staffId, moderatorRole: 'via-bot', approved: null, duration: change.duration ?? 'Permanent', expiresAt: change.expiresAt ?? null }, at);
        const history = pushHistory(record, { action: 'recorded (was already banned)', by: staffId, role: 'via-bot', at, reason: null });
        store.run('UPDATE ban_records SET history=? WHERE guild_id=? AND id=?', history, guildId, record.id);
        const fresh = getRecord(store, guildId, record.id);
        publish(store, logs, fresh, true);
        return { record: fresh, isNew: true };
    }
    const history = pushHistory(open, { action: 'reason added', by: staffId, role: 'via-bot', at, reason: redact(reason) });
    // Someone unknown (or a bot without a reason) banned them: the staff member now stands behind it.
    const takeOver = !open.moderator_id || open.moderator_role === 'unverified' || !open.reason;
    store.run(`UPDATE ban_records SET reason=?, evidence=?, history=?${takeOver ? ", moderator_id=?, moderator_role='via-bot'" : ''} WHERE guild_id=? AND id=?`, redact(reason) ?? null, redact([open.evidence, evidence].filter(Boolean).join('\n')) || null, history, ...(takeOver ? [staffId] : []), guildId, open.id);
    // e.g. a tempban on someone already banned: the record now shows when the ban ends.
    if (change.kind)
        store.run('UPDATE ban_records SET kind=?, duration=?, expires_at=? WHERE guild_id=? AND id=?', change.kind, change.duration ?? null, change.expiresAt ?? null, guildId, open.id);
    const updated = getRecord(store, guildId, open.id);
    publish(store, logs, updated, false);
    return { record: updated, isNew: false };
}
/** Post a new record to #bans, or refresh the message it already has. */
export function publish(store, logs, record, isNew) {
    if (!isNew)
        return logs.refreshRef(record.guild_id, REF, record.id);
    const channel = logChannels(store, record.guild_id).bansChannelId;
    if (channel)
        logs.pushRef(record.guild_id, channel, REF, record.id);
}
/** Lets the log queue render records from the database when it posts or edits them. */
export function registerBanLogRenderer(store, logs) {
    // Reads are scoped to the record's own server, inside or outside a server context.
    const find = (guildId, id) => store.get('SELECT * FROM ban_records WHERE guild_id=? AND id=?', guildId, id);
    logs.refs.set(REF, {
        render: (guildId, id) => { const r = find(guildId, id); return r ? renderRecord(r) : null; },
        location: (guildId, id) => { const r = find(guildId, id); return r?.channel_id && r.message_id ? { channelId: r.channel_id, messageId: r.message_id } : null; },
        posted: (guildId, id, channelId, messageId) => {
            void store.withAuthorized(guildId, async () => store.run('UPDATE ban_records SET channel_id=?,message_id=? WHERE guild_id=? AND id=?', channelId, messageId, guildId, id));
        },
    });
}
const queue = new KeyedQueue();
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
export const timing = { settleMs: BAN_SETTLE_MS };
/** Discord reported a ban. Wait briefly for the audit log and Vanguard's case, then record it once. */
export async function onBanAdd(store, logs, guild, user, fetchedReason = null) {
    await sleep(timing.settleMs);
    return queue.run(`${guild.id}:${user.id}`, async () => {
        const audit = await findAudit(guild, AuditLogEvent.MemberBanAdd, user.id);
        const reason = audit?.reason ?? fetchedReason ?? (await guild.bans.fetch({ user: user.id, force: true }).catch(() => null))?.reason ?? null;
        return store.withAuthorized(guild.id, async () => {
            // Already tracked: a reban from the ban log, or a duplicate event.
            if (openRecord(store, guild.id, user.id))
                return null;
            const record = createRecord(store, guild.id, { id: user.id, tag: user.tag, username: user.username, avatar: user.displayAvatarURL() }, explainBan(store, guild, user.id, audit, reason));
            publish(store, logs, record, true);
            return record;
        });
    });
}
/** Discord reported an unban: update the user's open record, or start one if the ban predates the log. */
export async function onBanRemove(store, logs, guild, user) {
    await sleep(timing.settleMs);
    return queue.run(`${guild.id}:${user.id}`, async () => {
        const audit = await findAudit(guild, AuditLogEvent.MemberBanRemove, user.id);
        return store.withAuthorized(guild.id, async () => {
            const botId = guild.client.user?.id;
            let by = null, role = 'unverified', reason = audit?.reason ?? null, status = 'unbanned';
            if (audit?.executorId === botId) {
                const staff = /^(\d{17,20}): ([\s\S]*)$/.exec(reason ?? '');
                if (staff) {
                    by = staff[1];
                    role = 'via-bot';
                    reason = staff[2];
                }
                else {
                    by = botId ?? null;
                    role = 'automatic';
                    reason = reason?.replace(/^(?:Midtown |Ghost )Vanguard: /, '') ?? null;
                    if (/temporary ban expired/i.test(reason ?? ''))
                        status = 'expired';
                }
            }
            else if (audit?.executorId) {
                by = audit.executorId;
                role = 'manual';
            }
            const open = openRecord(store, guild.id, user.id);
            if (open) {
                const updated = setStatus(store, open, status, by, role, reason);
                publish(store, logs, updated, false);
                return updated;
            }
            // Recently updated by the ban log's own Unban button: nothing to add.
            const latest = latestRecord(store, guild.id, user.id);
            if (latest && latest.status !== 'banned' && (latest.status_at ?? 0) > Date.now() - 120000)
                return latest;
            // A ban from before the ban log existed: keep a record of the unban, details marked unavailable.
            const record = createRecord(store, guild.id, { id: user.id, tag: user.tag, username: user.username, avatar: user.displayAvatarURL() }, { kind: 'ban', reason: null, evidence: null, moderatorId: null, moderatorRole: 'unverified', approved: null, duration: null, expiresAt: null }, 0);
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
export function coverWithNetwork(store, logs, guildId, user, ban, at = Date.now()) {
    const id = recordId(ban);
    const open = openRecord(store, guildId, user.id);
    const approved = `<@${ban.moderator_id}> (developer) · ${id}`;
    const evidence = [ban.evidence, ban.evidence_file].filter(Boolean).join('\n') || null;
    if (open) {
        if (open.network_record === id)
            return open;
        const history = pushHistory(open, { action: `now covered by ${ban.kind} ${id} (was ${KIND_LABEL[open.kind]?.toLowerCase() ?? open.kind})`, by: ban.moderator_id, role: 'via-bot', at, reason: open.kind });
        store.run('UPDATE ban_records SET kind=?,network_record=?,approved=?,duration=?,evidence=COALESCE(evidence,?),expires_at=NULL,history=? WHERE guild_id=? AND id=?', ban.kind, id, approved, NETWORK_DURATION[ban.kind], redact(evidence) ?? null, history, guildId, open.id);
        const updated = getRecord(store, guildId, open.id);
        publish(store, logs, updated, false);
        return updated;
    }
    const record = createRecord(store, guildId, { id: user.id, tag: user.tag ?? null }, { kind: ban.kind, reason: ban.reason, evidence, moderatorId: ban.moderator_id, moderatorRole: 'via-bot', approved, duration: NETWORK_DURATION[ban.kind], expiresAt: null, networkRecord: id }, at);
    publish(store, logs, record, true);
    return record;
}
/**
 * The genreban/hardban was lifted, but the server's own ban stays: the record goes back to the
 * kind of ban it was before, keeps every detail, and says what happened.
 */
export function uncoverNetwork(store, logs, guildId, userId, ban, by, at = Date.now()) {
    const id = recordId(ban);
    const open = openRecord(store, guildId, userId);
    if (!open || open.network_record !== id)
        return null;
    const previous = [...JSON.parse(open.history || '[]')].reverse().find(h => h.action.startsWith(`now covered by ${ban.kind} ${id}`))?.reason ?? 'ban';
    const history = pushHistory(open, { action: `${id} lifted; this server's own ban stays`, by, role: 'via-bot', at, reason: null });
    store.run("UPDATE ban_records SET kind=?,network_record=NULL,approved=NULL,duration='Permanent',history=? WHERE guild_id=? AND id=?", previous, history, guildId, open.id);
    const updated = getRecord(store, guildId, open.id);
    publish(store, logs, updated, false);
    return updated;
}
// ---------------------------------------------------------------- how a record looks
const who = (id, role) => {
    if (!id || role === 'unverified')
        return 'Unavailable (could not be verified)';
    if (role === 'automatic')
        return `Ghost Vanguard (automatic)`;
    return `<@${id}> ( ${id} )`;
};
const moderatorHeading = (r) => r.moderator_role === 'via-bot' ? 'Moderator (via bot)' : 'Banned By';
const ts = (ms, style = 'f') => `<t:${Math.floor(ms / 1000)}:${style}>`;
export function renderRecord(r) {
    const banned = r.status === 'banned';
    const statusWord = banned ? 'Banned' : r.status === 'expired' ? 'Ban expired' : 'Unbanned';
    const e = new EmbedBuilder().setColor(banned ? 0xB10F2E : 0x43B581)
        .setAuthor({ name: `• ${r.username ?? r.user_id} - ${statusWord}`, iconURL: r.avatar_url ?? undefined })
        .setFooter({ text: `User ID: ${r.user_id}${r.network_record ? ` • ${r.network_record}` : ''}` });
    if (r.banned_at)
        e.setTimestamp(r.banned_at);
    const fields = [
        { name: 'User', value: `<@${r.user_id}>\n( ${r.user_id} )`, inline: true },
        { name: r.banned_at ? moderatorHeading(r) : 'Banned By', value: r.banned_at ? who(r.moderator_id, r.moderator_role) : 'Unavailable (banned before ban logging started)', inline: true },
        { name: 'Reason', value: clip(r.reason || (r.banned_at ? 'No reason given' : 'Unavailable'), 1024) },
    ];
    if (r.evidence)
        fields.push({ name: 'Evidence', value: clip(r.evidence, 1024) });
    if (r.approved)
        fields.push({ name: 'Approved by', value: clip(r.approved, 1024) });
    if (r.duration && r.kind !== 'ban' && r.kind !== 'manual')
        fields.push({ name: 'Type', value: KIND_LABEL[r.kind] ?? r.kind, inline: true });
    if (r.duration)
        fields.push({ name: 'Duration', value: r.duration, inline: true });
    if (r.expires_at)
        fields.push({ name: banned ? 'Expires' : 'Was due to expire', value: `${ts(r.expires_at)} (${ts(r.expires_at, 'R')})`, inline: true });
    if (r.banned_at)
        fields.push({ name: 'Banned', value: ts(r.banned_at), inline: true });
    if (r.status_at) {
        const action = r.status === 'banned' ? 'Rebanned' : r.status === 'expired' ? 'Expired' : 'Unbanned';
        fields.push({ name: 'Status', value: clip(`${action} by ${who(r.status_by, r.status_by_role)} · ${ts(r.status_at)}${r.status_reason ? `\n**Reason:** ${r.status_reason}` : ''}`, 1024) });
    }
    const history = JSON.parse(r.history || '[]');
    if (history.length > 2)
        fields.push({ name: 'History', value: clip(history.slice(-6).map(h => `${ts(h.at, 'd')} ${h.action} · ${h.role === 'unverified' || !h.by ? 'unverified' : h.role === 'automatic' ? 'automatic' : `<@${h.by}>`}`).join('\n'), 1024) });
    e.addFields(fields);
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${REF}:unban:${r.id}`).setLabel('Unban').setStyle(ButtonStyle.Success).setDisabled(!banned), new ButtonBuilder().setCustomId(`${REF}:reban:${r.id}`).setLabel('Reban').setStyle(ButtonStyle.Danger).setDisabled(banned));
    return { embeds: [e.toJSON()], components: [row.toJSON()] };
}
const NOT_ALLOWED = 'Only the server owner and Ghost Vanguard developers can use the ban log buttons.';
const networkLifter = (_kind) => 'Developer';
const notNetwork = (kind) => `This is a Midtown-wide **${kind}**: only a ${networkLifter(kind)} can lift it. Server Admins and owners can lift ordinary bans only.`;
const LOCAL_FOOTER = 'The server owner and developers can do this';
const BUTTON_COOLDOWN_MS = 500;
const buttonCooldowns = new WeakMap();
const announcementQueue = new KeyedQueue();
function cooldownsFor(store) {
    let cooldowns = buttonCooldowns.get(store);
    if (!cooldowns)
        buttonCooldowns.set(store, cooldowns = new Cooldowns());
    return cooldowns;
}
async function announceButtonAction(i, content) {
    const channel = i.channel;
    if (!channel?.isSendable())
        return;
    try {
        await announcementQueue.run(i.guildId, async () => {
            await new Promise(resolve => setTimeout(resolve, BUTTON_COOLDOWN_MS));
            await channel.send({ content, allowedMentions: { parse: [] } });
        });
    }
    catch (error) {
        logEvent('ban_log_button_announcement_failed', { guildId: i.guildId, userId: i.user.id, error: error instanceof Error ? error.message : String(error) });
    }
}
const confirmRow = (id, action, label) => new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${REF}:c${action}:${id}`).setLabel(label ?? (action === 'unban' ? 'Unban' : 'Reban')).setEmoji(action === 'unban' ? '🔓' : '🔨').setStyle(action === 'unban' ? ButtonStyle.Success : ButtonStyle.Danger), new ButtonBuilder().setCustomId(`${REF}:cancel:${id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary));
const KIND_TITLE = { genreban: 'Genreban', hardban: 'Hardban', tempban: 'Temporary ban', softban: 'Softban', automatic: 'Automatic ban' };
/** The private prompts and results for the ban log buttons: same look as the record itself. */
function card(r, o) {
    const e = new EmbedBuilder().setColor(o.color).setTitle(o.title)
        .setAuthor({ name: r.username ?? r.user_id, iconURL: r.avatar_url ?? undefined })
        .addFields({ name: 'User', value: `<@${r.user_id}>\n\`${r.user_id}\``, inline: true }, { name: 'Ban', value: o.ban ?? KIND_TITLE[r.kind] ?? 'Ban', inline: true }, ...(o.fields ?? []));
    if (o.footer)
        e.setFooter({ text: o.footer });
    return e;
}
const reasonField = (r) => ({ name: 'Original reason', value: clip(r.reason || 'No reason provided', 1024) });
/** Is this user banned right now? true / false, or null when Discord could not be asked. */
async function bannedNow(guild, userId) {
    try {
        await guild.bans.fetch({ user: userId, force: true });
        return true;
    }
    catch (error) {
        return error?.code === 10026 ? false : null;
    }
}
/**
 * Handles every ban-log button and form. On every interaction, only the server owner or a Developer
 * is admitted; lifting either network-ban type still requires a Developer.
 */
export async function handleBanLogInteraction(i, deps) {
    const [, action, raw] = i.customId.split(':');
    const reply = (content) => i.replied || i.deferred ? i.followUp({ content, flags: MessageFlags.Ephemeral }) : i.reply({ content, flags: MessageFlags.Ephemeral });
    // These controls are deliberately narrower than /mod unban: only the guild owner or a Developer may use them.
    if (!developers.has(i.user.id) && i.guild.ownerId !== i.user.id)
        return reply(NOT_ALLOWED);
    if (action === 'cancel')
        return i.isButton() ? i.update({ content: 'Cancelled. Nothing was changed.', embeds: [], components: [] }) : undefined;
    if (!cooldownsFor(deps.store).take(`${i.guildId}:${i.user.id}:${raw}:${action}`, BUTTON_COOLDOWN_MS))
        return reply('Please wait half a second before using that ban-log button again.');
    const id = Number(raw);
    const { store, logs } = deps;
    return store.withAuthorized(i.guildId, async () => {
        const record = getRecord(store, i.guildId, id);
        if (!record)
            return reply('That ban record no longer exists.');
        const live = await bannedNow(i.guild, record.user_id);
        if (live === null)
            return reply('Discord could not confirm whether they are banned right now (Vanguard may be missing Ban Members). Nothing was changed.');
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
            if (!live)
                return reply(`${label} is not banned.`);
            const name = record.username ?? record.user_id;
            if (net)
                return i.reply({ flags: MessageFlags.Ephemeral, embeds: [card(record, { title: `🔓 Unban ${name}?`, color: Colors.Blurple, ban: `${KIND_TITLE[net.kind]} · ${net.record}`,
                            fields: [reasonField(record), { name: 'What happens', value: `• Unbanned in **every** Midtown server\n• ${net.record} is closed, so it won't be re-applied\n• Bans placed by a server's own staff stay` }],
                            footer: `Only a ${networkLifter(net.kind)} can do this` })], components: [confirmRow(id, 'unban', 'Unban everywhere')] });
            return i.reply({ flags: MessageFlags.Ephemeral, embeds: [card(record, { title: `🔓 Unban ${name}?`, color: Colors.Blurple,
                        fields: [reasonField(record), { name: 'What happens', value: '• They can rejoin this server\n• This ban record is updated, not deleted' }],
                        footer: LOCAL_FOOTER })], components: [confirmRow(id, 'unban')] });
        }
        if (action === 'reban' || action === 'rebanform' || action === 'creban') {
            if (isWhitelistedPerson(record.user_id))
                return reply(whitelistedMessage(record.user_id));
        }
        if (action === 'reban') {
            if (live)
                return reply(`${label} is already banned.`);
            if (!i.isButton())
                return;
            return i.showModal(new ModalBuilder().setCustomId(`${REF}:rebanform:${id}`).setTitle(`Reban ${clip(record.username ?? record.user_id, 35)}`).addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason for the reban (required)')
                .setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(3).setMaxLength(450))));
        }
        if (action === 'rebanform' && i.isModalSubmit()) {
            const reason = i.fields.getTextInputValue('reason').trim();
            if (reason.length < 3)
                return reply('A reason is required.');
            return i.reply({ flags: MessageFlags.Ephemeral, embeds: [card(record, { title: `🔨 Reban ${record.username ?? record.user_id}?`, color: Colors.Red,
                        fields: [reasonField(record), { name: 'Reban reason', value: clip(reason, 1024) }, { name: 'What happens', value: '• They are banned from this server again\n• This ban record is updated with your reason' }],
                        footer: LOCAL_FOOTER })], components: [confirmRow(id, 'reban')] });
        }
        if (action === 'cunban' && i.isButton()) {
            if (!live)
                return i.update({ content: `${label} is not banned any more. Nothing was changed.`, embeds: [], components: [] });
            if (net && deps.network) {
                const reason = 'Lifted from the ban log';
                await i.update({ embeds: [card(record, { title: `⏳ Unbanning ${record.username ?? record.user_id} everywhere…`, color: Colors.Blurple, ban: `${KIND_TITLE[net.kind]} · ${net.record}` })], components: [] });
                // Is this server's ban the network ban itself, or the server's own ban that it covers?
                const own = !TAG[net.kind] || !(await i.guild.bans.fetch({ user: record.user_id, force: true }).catch(() => null))?.reason?.startsWith(TAG[net.kind]);
                // Recorded first, so the unban events that follow do not add a second entry.
                if (!own)
                    publish(store, logs, setStatus(store, record, 'unbanned', i.user.id, 'via-bot', `${net.kind} ${net.record} lifted by a ${networkLifter(net.kind)}`), false);
                const result = await deps.network.lift(record.user_id, { id: i.user.id, tag: i.user.tag }, reason);
                const auditMessage = `🌐 <@${i.user.id}> lifted the **${net.kind}** ${net.record} for <@${record.user_id}> from the ban log (${result.lifted} of ${result.servers} server bans lifted).`;
                if (own) {
                    await i.editReply({ embeds: [card(getRecord(store, i.guildId, record.id) ?? record, { title: `✅ ${net.record} lifted everywhere`, color: Colors.Green, ban: `${KIND_TITLE[net.kind]} · ${net.record} (closed)`,
                                fields: [{ name: 'Servers', value: `Unbanned in **${result.lifted} of ${result.servers}**` }, { name: 'This server', value: "Still banned: this server's own ban was there first and stays. Press **Unban** again to lift it too." }],
                                footer: 'The ban record has been updated' })] });
                }
                else {
                    await i.editReply({ embeds: [card(record, { title: `${result.failed ? '⚠️' : '✅'} ${record.username ?? record.user_id} unbanned`, color: result.failed ? Colors.Orange : Colors.Green, ban: `${KIND_TITLE[net.kind]} · ${net.record} (closed)`,
                                fields: [{ name: 'Servers', value: `Unbanned in **${result.lifted} of ${result.servers}**${result.failed ? `\n${result.failed} could not be reached: check Vanguard's Ban Members permission there` : ''}` }],
                                footer: 'The ban record has been updated' })] });
                }
                await announceButtonAction(i, auditMessage);
                return;
            }
            try {
                await deps.assertLocalUnban(i.guild, record.user_id);
            }
            catch (error) {
                return i.update({ content: error instanceof Error ? error.message : 'This ban cannot be lifted here.', embeds: [], components: [] });
            }
            const reason = 'Unbanned from the ban log';
            await i.guild.members.unban(record.user_id, clip(`${i.user.id}: ${reason}`, 500));
            const updated = setStatus(store, record, 'unbanned', i.user.id, 'via-bot', reason);
            publish(store, logs, updated, false);
            await i.update({ embeds: [card(updated, { title: `✅ ${record.username ?? record.user_id} unbanned`, color: Colors.Green, footer: 'The ban record has been updated' })], components: [] });
            await announceButtonAction(i, `🔓 <@${i.user.id}> used the ban-log **Unban** button for <@${record.user_id}> · ${caseId(record)}.`);
            return;
        }
        if (action === 'creban' && i.isButton()) {
            const reason = i.message.embeds[0]?.fields.find(f => f.name === 'Reban reason')?.value;
            if (!reason)
                return i.update({ content: 'The reban reason was missing. Press Reban again.', embeds: [], components: [] });
            if (live)
                return i.update({ content: `${label} is already banned. Nothing was changed.`, embeds: [], components: [] });
            if (record.user_id === i.guild.ownerId)
                return i.update({ content: 'The server owner cannot be banned.', embeds: [], components: [] });
            // Update the record first so the ban event that follows does not start a second record.
            const updated = setStatus(store, record, 'banned', i.user.id, 'via-bot', reason);
            try {
                await i.guild.members.ban(record.user_id, { reason: clip(`${i.user.id}: Reban: ${reason}`, 500) });
            }
            catch (error) {
                const reverted = setStatus(store, updated, 'unbanned', null, 'unverified', `Reban by <@${i.user.id}> failed: ${error instanceof Error ? error.message : 'unknown error'}`);
                publish(store, logs, reverted, false);
                return i.update({ embeds: [card(record, { title: '❌ Reban failed', color: Colors.Red, fields: [{ name: 'Why', value: clip(`${error instanceof Error ? error.message : 'unknown error'}. Check Vanguard's role is above theirs and it has Ban Members.`, 1024) }] })], components: [] });
            }
            publish(store, logs, updated, false);
            await i.update({ embeds: [card(updated, { title: `🔨 ${record.username ?? record.user_id} rebanned`, color: Colors.Red, fields: [{ name: 'Reban reason', value: clip(reason, 1024) }], footer: 'The ban record has been updated' })], components: [] });
            await announceButtonAction(i, `🔨 <@${i.user.id}> used the ban-log **Reban** button for <@${record.user_id}> · ${caseId(record)}.`);
            return;
        }
        return reply('That button is no longer valid.');
    });
}
