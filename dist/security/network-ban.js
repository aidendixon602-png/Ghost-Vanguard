import { coverWithNetwork, uncoverNetwork } from '../audit/ban-log.js';
import { Colors, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { developers } from '../bot/developers.js';
import { isSupreme } from '../bot/ranks.js';
import { config } from '../config.js';
import { clip } from '../core.js';
import { AppError, logEvent } from '../errors.js';
import { BOT_BELOW_TARGET, classify, MISSING_BAN_PERMISSION } from '../ui/progress.js';
import { embed } from '../ui/ui.js';
import { isProtectedUser } from '../bot/env-rules.js';
import { isWhitelistedPerson, whitelistedMessage } from '../bot/trusted-bots.js';
export const TAG = {
    genreban: '[Vanguard genreban]',
    hardban: '[Vanguard hardban]',
};
/** True when a Discord ban reason shows the bot placed it for this ban type. */
export function hasTag(reason, kind) {
    return !!reason && reason.startsWith(TAG[kind]);
}
export const KIND_NAME = { genreban: 'Genreban', hardban: 'Hardban' };
/** Record IDs: GB-00012 for genrebans, HB-00003 for hardbans. */
export const recordId = (ban) => `${ban.kind === 'hardban' ? 'HB' : 'GB'}-${String(ban.id).padStart(5, '0')}`;
// ---------------------------------------------------------------- finding the user
const ID = /^\d{17,20}$/;
/** Accepts a raw ID or a mention such as <@123> or <@!123>; null for anything else. */
export function idFrom(input) {
    const id = input.trim().replace(/^<@!?(\d+)>$/, '$1');
    return /^\d+$/.test(id) ? id : null;
}
export function parseUserId(input) {
    const id = idFrom(input);
    if (!id || !ID.test(id))
        throw new AppError('VALIDATION_ERROR', `\`${clip(input.trim(), 40)}\` is not a valid Discord user ID. IDs are 17–20 digits; turn on Developer Mode in Discord, then right-click the user and choose Copy User ID.`);
    return id;
}
async function fetchUser(client, id) {
    try {
        return await client.users.fetch(id, { force: true });
    }
    catch (error) {
        if (typeof error === 'object' && error && 'code' in error && [10013, 50035].includes(Number(error.code)))
            throw new AppError('VALIDATION_ERROR', `No Discord account has the user ID \`${id}\`. Check the ID and try again.`);
        throw new AppError('INTEGRATION_ERROR', 'Could not reach Discord to look up that user. Nothing was changed; try again shortly.', { cause: error });
    }
}
/**
 * Finds the target from a user ID, a mention, or a username.
 *
 * IDs work for anyone, including people in none of the bot's servers. Discord has no
 * global username search, so a username is matched against members of the protected
 * servers: the exact username first, then the display name if that is unambiguous.
 */
export async function resolveTarget(deps, input) {
    const raw = input.trim();
    const id = idFrom(raw);
    if (id !== null)
        return fetchUser(deps.client, parseUserId(raw));
    const query = raw.replace(/^@/, '').replace(/#0$/, '').toLowerCase();
    if (!query || query.length > 32)
        throw new AppError('VALIDATION_ERROR', 'Enter a Discord user ID, an @mention, or a username.');
    const byUsername = new Map(), byDisplay = new Map();
    const consider = (user, nickname) => {
        if (user.username.toLowerCase() === query)
            byUsername.set(user.id, user);
        else if (user.globalName?.toLowerCase() === query || nickname?.toLowerCase() === query)
            byDisplay.set(user.id, user);
    };
    const servers = targetServers(deps);
    for (const guild of servers)
        for (const member of guild.members.cache.values())
            consider(member.user, member.nickname);
    if (!byUsername.size)
        for (const guild of servers) {
            const found = await guild.members.search({ query, limit: 10 }).catch(() => null);
            for (const member of found?.values() ?? [])
                consider(member.user, member.nickname);
            if (byUsername.size)
                break;
        }
    if (byUsername.size === 1)
        return [...byUsername.values()][0];
    if (!byUsername.size && byDisplay.size === 1)
        return [...byDisplay.values()][0];
    const candidates = [...byUsername.values(), ...byDisplay.values()];
    if (candidates.length)
        throw new AppError('VALIDATION_ERROR', `More than one person matches \`${clip(raw, 40)}\`. Use their user ID instead:\n${candidates.slice(0, 8).map(u => `• **${u.tag}**: \`${u.id}\``).join('\n')}`);
    throw new AppError('VALIDATION_ERROR', `Could not find anyone called \`${clip(raw, 40)}\` in the protected servers. Use their Discord user ID instead; IDs work even for people who are in none of the servers.`);
}
/** People network bans must never reach, whatever the reason given. */
export function assertTargetable(client, userId, actorId) {
    if (userId === actorId)
        throw new AppError('VALIDATION_ERROR', 'You cannot ban yourself.');
    if (userId === client.user?.id)
        throw new AppError('VALIDATION_ERROR', 'Ghost Vanguard cannot ban itself.');
    if (isWhitelistedPerson(userId))
        throw new AppError('VALIDATION_ERROR', whitelistedMessage(userId));
    if (developers.has(userId) || isSupreme(userId) || userId === config.ownerId)
        throw new AppError('VALIDATION_ERROR', 'That user is a Ghost Vanguard developer or Supreme Leader, and cannot be network-banned.');
    if (isProtectedUser(userId) && !developers.has(actorId))
        throw new AppError('VALIDATION_ERROR', 'That user is a protected user (set in the bot settings), so only a Developer can network-ban them.');
}
/** Every server a network ban applies to, in a stable order. */
export function targetServers(deps) {
    return [...deps.client.guilds.cache.values()].filter(g => deps.isReady(g.id)).sort((a, b) => a.name.localeCompare(b.name));
}
export function describeUser(user) {
    const created = user.createdTimestamp ? ` · account created <t:${Math.floor(user.createdTimestamp / 1000)}:D>` : '';
    return `**${user.tag ?? user.username ?? 'Unknown user'}**${user.bot ? ' (bot account)' : ''}\nUser ID: \`${user.id}\`${created}`;
}
// ---------------------------------------------------------------- records
export function activeBan(store, kind, userId) {
    return store.get("SELECT * FROM network_bans WHERE kind=? AND user_id=? AND status='active'", kind, userId);
}
export function banById(store, id) {
    return store.get('SELECT * FROM network_bans WHERE id=?', id);
}
export function isActive(store, id) {
    return !!store.get("SELECT 1 FROM network_bans WHERE id=? AND status='active'", id);
}
export function listActive(store, kind) {
    return (kind
        ? store.all("SELECT * FROM network_bans WHERE status='active' AND kind=? ORDER BY created_at DESC", kind)
        : store.all("SELECT * FROM network_bans WHERE status='active' ORDER BY created_at DESC"));
}
/** Saves a new active ban. Refuses a duplicate: one active ban per user and type. */
export function createBan(store, b) {
    if (activeBan(store, b.kind, b.user.id))
        throw new AppError('VALIDATION_ERROR', `That user already has an active ${b.kind}. No duplicate record was created.`);
    try {
        const id = Number(store.run('INSERT INTO network_bans(kind,user_id,username,reason,evidence,evidence_file,moderator_id,moderator_name,created_at) VALUES(?,?,?,?,?,?,?,?,?)', b.kind, b.user.id, b.user.tag ?? b.user.username ?? null, b.reason, b.evidence ?? null, b.evidenceFile ?? null, b.moderator.id, b.moderator.tag ?? null, Date.now()).lastInsertRowid);
        logEvent(`${b.kind}_added`, { record: recordId({ id, kind: b.kind }), userId: b.user.id, by: b.moderator.id });
        return banById(store, id);
    }
    catch (error) {
        if (String(error?.message ?? error).includes('UNIQUE'))
            throw new AppError('VALIDATION_ERROR', `That user already has an active ${b.kind}. No duplicate record was created.`);
        throw error;
    }
}
/** Marks a ban revoked. The record and its server results are kept. */
export function revokeBan(store, ban, by, reason) {
    const changed = Number(store.run("UPDATE network_bans SET status='revoked',revoked_by=?,revoked_by_name=?,revoked_at=?,revoke_reason=? WHERE id=? AND status='active'", by.id, by.tag ?? null, Date.now(), reason, ban.id).changes) > 0;
    if (changed)
        logEvent(`${ban.kind}_revoked`, { record: recordId(ban), userId: ban.user_id, by: by.id });
    return changed;
}
export function recordResult(store, banId, action, result) {
    store.run('INSERT INTO network_ban_results(ban_id,guild_id,guild_name,action,outcome,detail,at) VALUES(?,?,?,?,?,?,?)', banId, result.guildId, result.name, action, result.outcome, result.reason, Date.now());
}
export function serverResults(store, banId) {
    return store.all('SELECT * FROM network_ban_results WHERE ban_id=? ORDER BY id', banId);
}
// ---------------------------------------------------------------- one server
async function memberOrNull(guild, userId) {
    try {
        return await guild.members.fetch({ user: userId, force: true });
    }
    catch (error) {
        if (typeof error === 'object' && error && 'code' in error && Number(error.code) === 10007)
            return null;
        throw error;
    }
}
async function currentBan(guild, userId) {
    try {
        const ban = await guild.bans.fetch({ user: userId, force: true });
        return { reason: ban.reason ?? null };
    }
    catch (error) {
        if (typeof error === 'object' && error && 'code' in error && Number(error.code) === 10026)
            return null;
        throw error;
    }
}
const LIFT_AUTHORITY = {
    genreban: 'Only a Developer',
    hardban: 'Only a Developer',
};
const WHY_NOTE = {
    unbanned: kind => `Someone unbanned this user, but they have an active ${kind}, so the bot banned them again. ${LIFT_AUTHORITY[kind]} can lift it with /un${kind}.`,
    joined: kind => `This user joined, but they have an active ${kind}, so the bot banned them. ${LIFT_AUTHORITY[kind]} can lift it with /un${kind}.`,
    sweep: kind => `This user has an active ${kind} and was found unbanned here, so the bot banned them. ${LIFT_AUTHORITY[kind]} can lift it with /un${kind}.`,
};
export function networkBanLogEmbed(guild, ban, why) {
    const recId = recordId(ban);
    const issued = why === 'issued';
    const lifts = 'Only a Developer can lift it.';
    const e = new EmbedBuilder()
        .setColor(Colors.DarkRed)
        .setTitle(`${KIND_NAME[ban.kind]} ${issued ? 'applied' : 're-applied'} · ${recId}`)
        .addFields({ name: 'Server', value: `${guild.name}\n(\`${guild.id}\`)`, inline: true }, { name: 'User', value: `<@${ban.user_id}>${ban.username ? ` ${ban.username}` : ''}\n\`${ban.user_id}\``, inline: true }, { name: 'By', value: `<@${ban.moderator_id}>`, inline: true }, { name: 'Reason', value: clip(ban.reason || 'No reason given', 1024) });
    if (ban.evidence)
        e.addFields({ name: 'Evidence', value: clip(ban.evidence, 1024) });
    if (ban.evidence_file)
        e.addFields({ name: 'Evidence file', value: `\`${clip(ban.evidence_file, 256)}\`` });
    e.addFields({ name: issued ? 'Scope' : 'Why again', value: issued
            ? `${ban.kind === 'hardban' ? 'Banned in every protected server and re-banned if unbanned.' : 'Banned in every protected server and banned again if they rejoin.'} ${lifts}`
            : WHY_NOTE[why](ban.kind) });
    return e.setFooter({ text: recId }).setTimestamp();
}
export function networkUnbanLogEmbed(guild, ban, reason, actorId) {
    const recId = recordId(ban);
    return new EmbedBuilder()
        .setColor(Colors.Green)
        .setTitle(`${KIND_NAME[ban.kind]} lifted · ${recId}`)
        .addFields({ name: 'Server', value: `${guild.name}\n(\`${guild.id}\`)`, inline: true }, { name: 'User', value: `<@${ban.user_id}>${ban.username ? ` ${ban.username}` : ''}\n\`${ban.user_id}\``, inline: true }, { name: 'Lifted by', value: `<@${actorId}>`, inline: true }, { name: 'Reason', value: clip(reason || 'No reason given', 1024) }, { name: 'Scope', value: 'Lifted in every protected server. A ban this server placed itself still applies.' })
        .setFooter({ text: recId })
        .setTimestamp();
}
/**
 * Bans one user in one server for a network ban and reports what happened. Records
 * the outcome against the ban. Never throws.
 */
export async function banIn(deps, guild, ban, why, deleteMessageSeconds = 0) {
    const base = { guildId: guild.id, name: guild.name };
    const userId = ban.user_id;
    let result;
    try {
        result = await deps.store.withAuthorized(guild.id, async () => {
            // A revoke that landed while this was queued wins: never re-apply a revoked ban.
            if (!isActive(deps.store, ban.id))
                return { ...base, outcome: 'skipped', reason: 'The ban was revoked before this server was reached.' };
            if (guild.ownerId === userId)
                return { ...base, outcome: 'not-allowed', reason: 'They own this server, and Discord does not allow banning a server owner.' };
            const me = guild.members.me ?? await guild.members.fetchMe();
            if (!me.permissions.has(PermissionFlagsBits.BanMembers))
                return { ...base, outcome: 'missing-permissions', reason: MISSING_BAN_PERMISSION };
            const member = await memberOrNull(guild, userId);
            if (member && me.roles.highest.comparePositionTo(member.roles.highest) <= 0)
                return { ...base, outcome: 'hierarchy', reason: BOT_BELOW_TARGET };
            if (why === 'issued' && !member) {
                const existing = await currentBan(guild, userId);
                if (existing && hasTag(existing.reason, ban.kind))
                    return { ...base, outcome: 'already', reason: `Already banned by this ${ban.kind}.` };
                if (existing) {
                    // Already banned by the server's own staff (or another ban type): that ban stays, and from now
                    // on this genreban/hardban covers it too (re-applied if anyone unbans them).
                    deps.store.recordCase(guild.id, userId, ban.moderator_id, ban.kind, `${recordId(ban)}: ${ban.reason} (they were already banned here)`, { username: ban.username, evidence: ban.evidence });
                    coverWithNetwork(deps.store, deps.logs, guild.id, { id: userId, tag: ban.username }, ban);
                    return { ...base, outcome: 'success', reason: `Already banned here; the ${ban.kind} now covers that ban too.` };
                }
            }
            await guild.members.ban(userId, { reason: clip(`${TAG[ban.kind]} ${recordId(ban)} ${ban.moderator_id}: ${ban.reason}`, 500), deleteMessageSeconds: why === 'issued' ? deleteMessageSeconds : 0 });
            deps.store.recordCase(guild.id, userId, ban.moderator_id, ban.kind, `${recordId(ban)}: ${ban.reason}`, { username: ban.username, evidence: ban.evidence });
            // The ban already happened: a log card that can't be built must never turn it into a "failed" result.
            try {
                deps.logs.push(guild.id, networkBanLogEmbed(guild, ban, why));
            }
            catch { /* the ban already happened */ }
            return { ...base, outcome: 'success', reason: member ? 'Banned (they were a member).' : 'Banned by user ID (they were not a member).' };
        });
    }
    catch (error) {
        result = { ...base, ...classify(error, ban.kind) };
    }
    if (why === 'issued' || result.outcome === 'success')
        safeRecord(deps.store, ban.id, why === 'issued' ? 'ban' : `enforce-${why}`, result);
    return result;
}
/** Lifts only bans of one type that the bot itself placed. Never throws. */
export async function unbanIn(deps, guild, ban, reason, actorId) {
    const base = { guildId: guild.id, name: guild.name };
    let result;
    try {
        result = await deps.store.withAuthorized(guild.id, async () => {
            const me = guild.members.me ?? await guild.members.fetchMe();
            if (!me.permissions.has(PermissionFlagsBits.BanMembers))
                return { ...base, outcome: 'missing-permissions', reason: MISSING_BAN_PERMISSION };
            const existing = await currentBan(guild, ban.user_id);
            if (!existing)
                return { ...base, outcome: 'skipped', reason: 'Not banned here.' };
            if (!hasTag(existing.reason, ban.kind)) {
                // The server's own ban stays; its record goes back to showing that ban.
                uncoverNetwork(deps.store, deps.logs, guild.id, ban.user_id, ban, actorId);
                return { ...base, outcome: 'skipped', reason: 'Banned here by something other than this ' + ban.kind + ' (local staff or another ban type), so left in place.' };
            }
            await guild.members.unban(ban.user_id, clip(`${actorId}: un${ban.kind} ${recordId(ban)}: ${reason}`, 500));
            deps.store.recordCase(guild.id, ban.user_id, actorId, `un${ban.kind}`, `${recordId(ban)}: ${reason}`, { username: ban.username });
            try {
                deps.logs.push(guild.id, networkUnbanLogEmbed(guild, ban, reason, actorId));
            }
            catch { /* the unban already happened */ }
            return { ...base, outcome: 'success', reason: 'Unbanned.' };
        });
    }
    catch (error) {
        result = { ...base, ...classify(error, `un${ban.kind}`) };
    }
    safeRecord(deps.store, ban.id, 'unban', result);
    return result;
}
function safeRecord(store, banId, action, result) {
    try {
        recordResult(store, banId, action, result);
    }
    catch (error) {
        logEvent('network_ban_record_failure', { banId, guildId: result.guildId, error: String(error) });
    }
}
// ---------------------------------------------------------------- telling the user
/**
 * DMs the user why they are being banned everywhere. Sent before any server bans them,
 * while they may still share a server with the bot (Discord only allows DMs then).
 * Never throws; returns whether Discord accepted the message.
 */
export async function notifyBannedUser(client, ban, servers) {
    try {
        const user = await client.users.fetch(ban.user_id);
        if (user.bot)
            return false;
        await user.send({
            embeds: [embed(`You have been ${ban.kind === 'hardban' ? 'hardbanned' : 'genrebanned'} by Ghost Vanguard`, [
                    `You are being banned from **${servers}** server${servers === 1 ? '' : 's'} protected by Ghost Vanguard${ban.kind === 'hardban' ? ', permanently,' : ''} and will be banned again if you join one.`,
                    '',
                    `**Reason:** ${clip(ban.reason, 1000)}`,
                    `**Record:** ${recordId(ban)}`,
                    '',
                    `Server staff cannot lift this ban. ${LIFT_AUTHORITY[ban.kind]} can lift it with /un${ban.kind}.`,
                ].join('\n'), Colors.DarkRed)],
            allowedMentions: { parse: [] },
        });
        return true;
    }
    catch {
        return false;
    }
}
async function eachServer(deps, work, onProgress) {
    const servers = targetServers(deps);
    const results = [];
    await onProgress?.(0, servers.length, results);
    // One server at a time: discord.js queues per route anyway, and this keeps the
    // bot well clear of Discord's invalid-request limits if many servers refuse.
    for (const guild of servers) {
        results.push(await work(guild));
        await onProgress?.(results.length, servers.length, results);
    }
    return results;
}
export function banEverywhere(deps, ban, deleteMessageSeconds = 0, onProgress) {
    return eachServer(deps, guild => banIn(deps, guild, ban, 'issued', deleteMessageSeconds), onProgress);
}
export function unbanEverywhere(deps, ban, reason, actorId, onProgress) {
    return eachServer(deps, guild => unbanIn(deps, guild, ban, reason, actorId), onProgress);
}
// ---------------------------------------------------------------- enforcement
/** Problems already reported, so a server that keeps refusing does not flood the logs. */
const reported = new Set();
/** The exception that lets this genrebanned user into this one server, if any. Hardbans never have one. */
export function activeException(store, guildId, banId) {
    return store.get('SELECT * FROM network_exceptions WHERE ban_id=? AND guild_id=? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1', banId, guildId);
}
export function addException(store, ban, guild, byId, reason, at = Date.now()) {
    if (ban.kind !== 'genreban')
        throw new AppError('PERMISSION_ERROR', 'Hardbans have no exceptions: only a developer can lift one, for every server.');
    const existing = activeException(store, guild.id, ban.id);
    if (existing)
        return existing;
    const id = Number(store.run('INSERT INTO network_exceptions(ban_id,guild_id,guild_name,user_id,by_id,reason,at) VALUES(?,?,?,?,?,?,?)', ban.id, guild.id, guild.name ?? null, ban.user_id, byId, reason, at).lastInsertRowid);
    return store.get('SELECT * FROM network_exceptions WHERE id=?', id);
}
export function revokeException(store, id, byId, at = Date.now()) {
    store.run('UPDATE network_exceptions SET revoked_by=?, revoked_at=? WHERE id=? AND revoked_at IS NULL', byId, at, id);
    return store.get('SELECT * FROM network_exceptions WHERE id=?', id);
}
export function listExceptions(store, userId) {
    return store.all(`SELECT e.*, b.kind, b.status FROM network_exceptions e JOIN network_bans b ON b.id=e.ban_id WHERE e.revoked_at IS NULL AND b.status='active'${userId ? ' AND e.user_id=?' : ''} ORDER BY e.at DESC LIMIT 50`, ...(userId ? [userId] : []));
}
async function enforce(deps, guild, ban, why) {
    // A Developer let them back in here only. The genreban still applies everywhere else.
    if (ban.kind === 'genreban' && activeException(deps.store, guild.id, ban.id))
        return false;
    const result = await banIn(deps, guild, ban, why);
    const key = `${guild.id}:${ban.id}`;
    if (result.outcome === 'success') {
        reported.delete(key);
        logEvent(`${ban.kind}_reapplied`, { record: recordId(ban), guildId: guild.id, userId: ban.user_id, why });
        return true;
    }
    if (!reported.has(key) && result.outcome !== 'skipped') {
        reported.add(key);
        safeRecord(deps.store, ban.id, `enforce-${why}`, result);
        logEvent(`${ban.kind}_enforcement_unavailable`, { record: recordId(ban), guildId: guild.id, guild: guild.name, userId: ban.user_id, why, outcome: result.outcome, reason: result.reason });
    }
    return false;
}
/** Someone joined an authorized server: ban them if they have an active hardban or genreban. */
export async function enforceOnJoin(deps, guild, userId) {
    if (!deps.isReady(guild.id) || isWhitelistedPerson(userId))
        return false;
    const ban = activeBan(deps.store, 'hardban', userId) ?? activeBan(deps.store, 'genreban', userId);
    return ban ? enforce(deps, guild, ban, 'joined') : false;
}
/** Someone was unbanned: a hardban is re-applied immediately. */
export async function enforceOnUnban(deps, guild, userId) {
    if (!deps.isReady(guild.id) || isWhitelistedPerson(userId))
        return false;
    const ban = activeBan(deps.store, 'hardban', userId);
    return ban ? enforce(deps, guild, ban, 'unbanned') : false;
}
let sweeping = false;
/**
 * Re-checks every active ban in every authorized server. Runs after startup and every
 * ten minutes, so enforcement survives restarts and reaches servers authorized later
 * or whose permissions were fixed since.
 *
 * - Hardbans: the user must be on each server's ban list.
 * - Genrebans: the user must not be a member of any server (checked against the
 *   member cache, so it costs no extra requests). Joining is caught by enforceOnJoin.
 */
export async function sweepNetworkBans(deps) {
    if (sweeping)
        return 0;
    sweeping = true;
    let applied = 0;
    try {
        const hard = listActive(deps.store, 'hardban').filter(h => !isWhitelistedPerson(h.user_id));
        const gen = listActive(deps.store, 'genreban').filter(g => !hard.some(h => h.user_id === g.user_id) && !isWhitelistedPerson(g.user_id));
        if (!hard.length && !gen.length)
            return 0;
        for (const guild of targetServers(deps)) {
            const me = guild.members.me;
            if (me && !me.permissions.has(PermissionFlagsBits.BanMembers))
                continue;
            for (const ban of gen)
                if (guild.members.cache.has(ban.user_id) && await enforce(deps, guild, ban, 'sweep'))
                    applied++;
            if (!hard.length)
                continue;
            let banned;
            let complete = true;
            try {
                const list = await guild.bans.fetch({ limit: 1000, cache: false });
                banned = new Set(list.keys());
                complete = list.size < 1000;
            }
            catch {
                continue;
            }
            for (const ban of hard) {
                if (banned.has(ban.user_id))
                    continue;
                if (!complete && await currentBan(guild, ban.user_id).then(b => !!b, () => true))
                    continue;
                if (await enforce(deps, guild, ban, 'sweep'))
                    applied++;
            }
        }
    }
    finally {
        sweeping = false;
    }
    return applied;
}
/** Builds the dependencies from a command context or the bot's services. */
export function networkDeps(s, ready = () => true) {
    return { client: s.client, store: s.store, logs: s.logs, isReady: id => ready() && s.lifecycle.isReady(id) };
}
export const DELETE_MESSAGE_CHOICES = [
    { name: 'Keep messages', value: 0 },
    { name: 'Last hour', value: 3600 },
    { name: 'Last 24 hours', value: 86400 },
    { name: 'Last 7 days', value: 604800 },
];
export function deleteWindow(seconds) {
    return seconds === 604800 ? 'the last 7 days' : seconds === 86400 ? 'the last 24 hours' : seconds === 3600 ? 'the last hour' : null;
}
/** What a server ban currently is, for /moderation unban: local, genreban or hardban. */
export function banTypeFromReason(reason) {
    if (hasTag(reason, 'hardban'))
        return 'hardban';
    if (hasTag(reason, 'genreban'))
        return 'genreban';
    return 'local';
}
/** The ban currently on this server for a user: null if none, undefined if Discord could not say. */
export async function existingBan(guild, userId) {
    try {
        const ban = await guild.bans.fetch({ user: userId, force: true });
        return { reason: ban.reason ?? null };
    }
    catch (error) {
        if (typeof error === 'object' && error && 'code' in error && Number(error.code) === 10026)
            return null;
        return undefined;
    }
}
/**
 * Local unbans (/mod unban, accepted appeals, expiring tempbans) must never lift a
 * genreban or hardban. Throws a plain explanation when one is in force.
 */
export async function assertLocalUnban(store, guild, userId, existing) {
    const network = activeBan(store, 'hardban', userId) ?? activeBan(store, 'genreban', userId);
    if (network) {
        const authority = network.kind === 'hardban'
            ? 'Only a Developer can lift it with `/unhardban`.'
            : 'Only a Developer can lift it from the ban-log controls or with `/ungenreban`.';
        throw new AppError('PERMISSION_ERROR', `This user has an active ${network.kind}, **${recordId(network)}**, placed by a Ghost Vanguard developer. Server staff cannot lift it. ${authority}${network.kind === 'hardban' ? ' Unbanning them by hand is undone immediately.' : ' If they were unbanned by hand they would be banned again on joining.'}`);
    }
    const ban = existing === undefined ? await existingBan(guild, userId) : existing;
    const type = banTypeFromReason(ban?.reason);
    if (type !== 'local')
        throw new AppError('PERMISSION_ERROR', `This server ban was placed by a Ghost Vanguard ${type}. Local unbans only lift local bans; a developer can lift it with \`/un${type}\`.`);
}
/**
 * A developer lifts a genreban/hardban from the ban log: revoke it, then unban everywhere it
 * placed a ban. Same effect as `/unhardban` or `/ungenreban`.
 */
export async function liftNetworkBan(deps, userId, by, reason) {
    const ban = activeBan(deps.store, 'hardban', userId) ?? activeBan(deps.store, 'genreban', userId);
    if (!ban)
        return { lifted: 0, failed: 0, servers: 0 };
    revokeBan(deps.store, ban, by, reason);
    const results = await unbanEverywhere(deps, ban, reason, by.id);
    return {
        lifted: results.filter(r => r.outcome === 'success').length,
        failed: results.filter(r => !['success', 'skipped', 'already'].includes(r.outcome)).length,
        servers: results.length,
    };
}
