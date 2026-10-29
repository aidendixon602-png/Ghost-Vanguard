import { coverWithNetwork, uncoverNetwork } from '../audit/ban-log.js';
import { Colors, EmbedBuilder, PermissionFlagsBits, type Client, type Guild, type User } from 'discord.js';
import { developers } from '../bot/developers.js';
import { isSupreme } from '../bot/ranks.js';
import { config } from '../config.js';
import { clip } from '../core.js';
import type { Store } from '../database/db.js';
import { AppError, logEvent } from '../errors.js';
import type { LogQueue } from '../logging.js';
import { BOT_BELOW_TARGET, classify, MISSING_BAN_PERMISSION, type Outcome } from '../ui/progress.js';
import { embed } from '../ui/ui.js';
import { isProtectedUser } from '../bot/env-rules.js';

/**
 * Developer bans that reach every server Ghost Vanguard protects.
 *
 * - A genreban (`/network genreban`) bans the user in every authorized server and keeps them out:
 *   while it is active, the bot bans them again if they join, or are found as a member,
 *   in any authorized server. Lifted with `/network ungenreban`.
 * - A hardban (`/network hardban`) is stricter: the user must stay banned everywhere. If anyone
 *   unbans them, they join, or a periodic check finds them unbanned, the bot bans them
 *   again. Lifted only with `/network unhardban` (Developer).
 *
 * Records are stored in network_bans (never deleted, so revoked bans keep
 * their history) with one row per server outcome in network_ban_results. Only servers
 * that are authorized and fully initialized are touched. Every ban the bot places
 * starts its audit-log reason with a tag naming its type, so each unban command only
 * ever lifts its own type and never a ban a server's own staff placed.
 */

export type NetworkKind = 'genreban' | 'hardban';

export const TAG: Record<NetworkKind, string> = {
    genreban: '[Vanguard genreban]',
    hardban: '[Vanguard hardban]',
};

/** True when a Discord ban reason shows the bot placed it for this ban type. */
export function hasTag(reason: string | null | undefined, kind: NetworkKind): boolean {
    return !!reason && reason.startsWith(TAG[kind]);
}

export const KIND_NAME: Record<NetworkKind, string> = { genreban: 'Genreban', hardban: 'Hardban' };

export interface NetworkDeps {
    client: Client;
    store: Store;
    logs: LogQueue;
    /** True when the server is authorized and initialized. */
    isReady: (guildId: string) => boolean;
}

export type ServerOutcome = Outcome | 'skipped';

export interface ServerResult {
    guildId: string;
    name: string;
    outcome: ServerOutcome;
    reason: string;
    reference?: string;
}

export interface NetworkBan {
    id: number;
    kind: NetworkKind;
    user_id: string;
    username: string | null;
    reason: string;
    evidence: string | null;
    evidence_file: string | null;
    moderator_id: string;
    moderator_name: string | null;
    created_at: number;
    status: 'active' | 'revoked';
    revoked_by: string | null;
    revoked_by_name: string | null;
    revoked_at: number | null;
    revoke_reason: string | null;
}

/** Record IDs: GB-00012 for genrebans, HB-00003 for hardbans. */
export const recordId = (ban: Pick<NetworkBan, 'id' | 'kind'>) => `${ban.kind === 'hardban' ? 'HB' : 'GB'}-${String(ban.id).padStart(5, '0')}`;

// ---------------------------------------------------------------- finding the user

const ID = /^\d{17,20}$/;

/** Accepts a raw ID or a mention such as <@123> or <@!123>; null for anything else. */
export function idFrom(input: string): string | null {
    const id = input.trim().replace(/^<@!?(\d+)>$/, '$1');
    return /^\d+$/.test(id) ? id : null;
}

export function parseUserId(input: string): string {
    const id = idFrom(input);
    if (!id || !ID.test(id))
        throw new AppError('VALIDATION_ERROR', `\`${clip(input.trim(), 40)}\` is not a valid Discord user ID. IDs are 17–20 digits; turn on Developer Mode in Discord, then right-click the user and choose Copy User ID.`);
    return id;
}

async function fetchUser(client: Client, id: string): Promise<User> {
    try {
        return await client.users.fetch(id, { force: true });
    } catch (error) {
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
export async function resolveTarget(deps: NetworkDeps, input: string): Promise<User> {
    const raw = input.trim();
    const id = idFrom(raw);
    if (id !== null)
        return fetchUser(deps.client, parseUserId(raw));
    const query = raw.replace(/^@/, '').replace(/#0$/, '').toLowerCase();
    if (!query || query.length > 32)
        throw new AppError('VALIDATION_ERROR', 'Enter a Discord user ID, an @mention, or a username.');
    const byUsername = new Map<string, User>(), byDisplay = new Map<string, User>();
    const consider = (user: User, nickname?: string | null) => {
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
        return [...byUsername.values()][0]!;
    if (!byUsername.size && byDisplay.size === 1)
        return [...byDisplay.values()][0]!;
    const candidates = [...byUsername.values(), ...byDisplay.values()];
    if (candidates.length)
        throw new AppError('VALIDATION_ERROR', `More than one person matches \`${clip(raw, 40)}\`. Use their user ID instead:\n${candidates.slice(0, 8).map(u => `• **${u.tag}**: \`${u.id}\``).join('\n')}`);
    throw new AppError('VALIDATION_ERROR', `Could not find anyone called \`${clip(raw, 40)}\` in the protected servers. Use their Discord user ID instead; IDs work even for people who are in none of the servers.`);
}

/** People network bans must never reach, whatever the reason given. */
export function assertTargetable(client: Client, userId: string, actorId: string) {
    if (userId === actorId)
        throw new AppError('VALIDATION_ERROR', 'You cannot ban yourself.');
    if (userId === client.user?.id)
        throw new AppError('VALIDATION_ERROR', 'Ghost Vanguard cannot ban itself.');
    if (developers.has(userId) || isSupreme(userId) || userId === config.ownerId)
        throw new AppError('VALIDATION_ERROR', 'That user is a Ghost Vanguard developer or Supreme Leader, and cannot be network-banned.');
    if (isProtectedUser(userId) && !developers.has(actorId))
        throw new AppError('VALIDATION_ERROR', 'That user is a protected user (set in the bot settings), so only a Developer can network-ban them.');
}

/** Every server a network ban applies to, in a stable order. */
export function targetServers(deps: NetworkDeps): Guild[] {
    return [...deps.client.guilds.cache.values()].filter(g => deps.isReady(g.id)).sort((a, b) => a.name.localeCompare(b.name));
}

export function describeUser(user: { id: string; tag?: string | null; username?: string | null; createdTimestamp?: number; bot?: boolean }): string {
    const created = user.createdTimestamp ? ` · account created <t:${Math.floor(user.createdTimestamp / 1000)}:D>` : '';
    return `**${user.tag ?? user.username ?? 'Unknown user'}**${user.bot ? ' (bot account)' : ''}\nUser ID: \`${user.id}\`${created}`;
}

// ---------------------------------------------------------------- records

export function activeBan(store: Store, kind: NetworkKind, userId: string): NetworkBan | undefined {
    return store.get("SELECT * FROM network_bans WHERE kind=? AND user_id=? AND status='active'", kind, userId) as NetworkBan | undefined;
}

export function banById(store: Store, id: number): NetworkBan | undefined {
    return store.get('SELECT * FROM network_bans WHERE id=?', id) as NetworkBan | undefined;
}

export function isActive(store: Store, id: number): boolean {
    return !!store.get("SELECT 1 FROM network_bans WHERE id=? AND status='active'", id);
}

export function listActive(store: Store, kind?: NetworkKind): NetworkBan[] {
    return (kind
        ? store.all("SELECT * FROM network_bans WHERE status='active' AND kind=? ORDER BY created_at DESC", kind)
        : store.all("SELECT * FROM network_bans WHERE status='active' ORDER BY created_at DESC")) as unknown as NetworkBan[];
}

export interface NewBan {
    kind: NetworkKind;
    user: Pick<User, 'id'> & { tag?: string; username?: string };
    reason: string;
    evidence?: string | null;
    evidenceFile?: string | null;
    moderator: { id: string; tag?: string };
}

/** Saves a new active ban. Refuses a duplicate: one active ban per user and type. */
export function createBan(store: Store, b: NewBan): NetworkBan {
    if (activeBan(store, b.kind, b.user.id))
        throw new AppError('VALIDATION_ERROR', `That user already has an active ${b.kind}. No duplicate record was created.`);
    try {
        const id = Number(store.run('INSERT INTO network_bans(kind,user_id,username,reason,evidence,evidence_file,moderator_id,moderator_name,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
            b.kind, b.user.id, b.user.tag ?? b.user.username ?? null, b.reason, b.evidence ?? null, b.evidenceFile ?? null, b.moderator.id, b.moderator.tag ?? null, Date.now()).lastInsertRowid);
        logEvent(`${b.kind}_added`, { record: recordId({ id, kind: b.kind }), userId: b.user.id, by: b.moderator.id });
        return banById(store, id)!;
    } catch (error) {
        if (String((error as any)?.message ?? error).includes('UNIQUE'))
            throw new AppError('VALIDATION_ERROR', `That user already has an active ${b.kind}. No duplicate record was created.`);
        throw error;
    }
}

/** Marks a ban revoked. The record and its server results are kept. */
export function revokeBan(store: Store, ban: NetworkBan, by: { id: string; tag?: string }, reason: string): boolean {
    const changed = Number(store.run("UPDATE network_bans SET status='revoked',revoked_by=?,revoked_by_name=?,revoked_at=?,revoke_reason=? WHERE id=? AND status='active'",
        by.id, by.tag ?? null, Date.now(), reason, ban.id).changes) > 0;
    if (changed)
        logEvent(`${ban.kind}_revoked`, { record: recordId(ban), userId: ban.user_id, by: by.id });
    return changed;
}

export function recordResult(store: Store, banId: number, action: string, result: ServerResult) {
    store.run('INSERT INTO network_ban_results(ban_id,guild_id,guild_name,action,outcome,detail,at) VALUES(?,?,?,?,?,?,?)',
        banId, result.guildId, result.name, action, result.outcome, result.reason, Date.now());
}

export function serverResults(store: Store, banId: number) {
    return store.all('SELECT * FROM network_ban_results WHERE ban_id=? ORDER BY id', banId);
}

// ---------------------------------------------------------------- one server

async function memberOrNull(guild: Guild, userId: string) {
    try {
        return await guild.members.fetch({ user: userId, force: true });
    } catch (error) {
        if (typeof error === 'object' && error && 'code' in error && Number(error.code) === 10007)
            return null;
        throw error;
    }
}

async function currentBan(guild: Guild, userId: string): Promise<{ reason: string | null } | null> {
    try {
        const ban = await guild.bans.fetch({ user: userId, force: true });
        return { reason: ban.reason ?? null };
    } catch (error) {
        if (typeof error === 'object' && error && 'code' in error && Number(error.code) === 10026)
            return null;
        throw error;
    }
}

type Why = 'issued' | 'unbanned' | 'joined' | 'sweep';

const LIFT_AUTHORITY: Record<NetworkKind, string> = {
    genreban: 'A Supreme Leader or Developer',
    hardban: 'Only a Developer',
};

const WHY_NOTE: Record<Exclude<Why, 'issued'>, (kind: NetworkKind) => string> = {
    unbanned: kind => `Someone unbanned this user, but they have an active ${kind}, so the bot banned them again. ${LIFT_AUTHORITY[kind]} can lift it with /network un${kind}.`,
    joined: kind => `This user joined, but they have an active ${kind}, so the bot banned them. ${LIFT_AUTHORITY[kind]} can lift it with /network un${kind}.`,
    sweep: kind => `This user has an active ${kind} and was found unbanned here, so the bot banned them. ${LIFT_AUTHORITY[kind]} can lift it with /network un${kind}.`,
};

/**
 * Bans one user in one server for a network ban and reports what happened. Records
 * the outcome against the ban. Never throws.
 */
export function networkBanLogEmbed(guild: Guild, ban: NetworkBan, why: Why): EmbedBuilder {
    const isIssued = why === 'issued';
    const kindTitle = KIND_NAME[ban.kind];
    const recId = recordId(ban);
    const title = isIssued ? `${kindTitle} applied · ${recId}` : `${kindTitle} re-applied · ${recId}`;
    const color = 0xB10F2E; // Midtown Crimson

    const e = new EmbedBuilder()
        .setColor(color)
        .setAuthor({
            name: 'Ghost Vanguard • Network Ban Enforcement',
            iconURL: guild.client?.user?.displayAvatarURL?.() ?? undefined,
        })
        .setTitle(`🛡️ ${title}`)
        .addFields(
            { name: 'Server', value: `${guild.name}\n(\`${guild.id}\`)`, inline: true },
            { name: 'Target User', value: `<@${ban.user_id}> ${ban.username ? `(${ban.username}) ` : ''}\n\`${ban.user_id}\``, inline: true },
            { name: 'Authorized By', value: `<@${ban.moderator_id}>\n\`Ghost Vanguard Developer\``, inline: true },
            { name: 'Reason', value: `>>> ${clip(ban.reason || 'No reason given', 1024)}` },
        );

    if (ban.evidence) {
        e.addFields({ name: 'Evidence', value: `>>> ${clip(ban.evidence, 1024)}` });
    }

    if (ban.evidence_file) {
        e.addFields({ name: 'Evidence File', value: `\`${clip(ban.evidence_file, 256)}\`` });
    }

    const networkPolicy = isIssued
        ? ban.kind === 'hardban'
            ? '> 🌐 **Network Hardban Policy**\n> This user is permanently banned from every server Ghost Vanguard protects and is re-banned if unbanned.\n-# Only a Developer can lift it.'
            : '> 🌐 **Network Genreban Policy**\n> This user is banned from every server Ghost Vanguard protects and is banned again if they join.\n-# Only a Developer or Supreme Leader can lift it.'
        : `> ⚠️ **Network Enforcement**\n> ${WHY_NOTE[why](ban.kind)}`;

    e.addFields({ name: 'Network Scope', value: networkPolicy });

    e.setFooter({
        text: `Ghost Vanguard • Network Protocol • ${recId}`,
        iconURL: guild.iconURL?.() ?? undefined,
    }).setTimestamp();

    return e;
}

export function networkUnbanLogEmbed(guild: Guild, ban: NetworkBan, reason: string, actorId: string): EmbedBuilder {
    const kindTitle = KIND_NAME[ban.kind];
    const recId = recordId(ban);
    const color = 0x43B581; // Midtown Emerald Mint

    const e = new EmbedBuilder()
        .setColor(color)
        .setAuthor({
            name: 'Ghost Vanguard • Network Ban Enforcement',
            iconURL: guild.client?.user?.displayAvatarURL?.() ?? undefined,
        })
        .setTitle(`🔓 ${kindTitle} lifted · ${recId}`)
        .addFields(
            { name: 'Server', value: `${guild.name}\n(\`${guild.id}\`)`, inline: true },
            { name: 'Target User', value: `<@${ban.user_id}> ${ban.username ? `(${ban.username}) ` : ''}\n\`${ban.user_id}\``, inline: true },
            { name: 'Lifted By', value: `<@${actorId}>\n\`Ghost Vanguard Developer\``, inline: true },
            { name: 'Reason', value: `>>> ${clip(reason || 'No reason given', 1024)}` },
            {
                name: 'Network Status',
                value: '> 🕊️ **Network Ban Cleared**\n> The global network ban was lifted across all protected servers.\n-# The user may rejoin unless a local server ban applies.',
            },
        )
        .setFooter({
            text: `Ghost Vanguard • Network Protocol • ${recId}`,
            iconURL: guild.iconURL?.() ?? undefined,
        })
        .setTimestamp();

    return e;
}

export async function banIn(deps: NetworkDeps, guild: Guild, ban: NetworkBan, why: Why, deleteMessageSeconds = 0): Promise<ServerResult> {
    const base = { guildId: guild.id, name: guild.name };
    const userId = ban.user_id;
    let result: ServerResult;
    try {
        result = await deps.store.withAuthorized(guild.id, async () => {
            // A revoke that landed while this was queued wins: never re-apply a revoked ban.
            if (!isActive(deps.store, ban.id))
                return { ...base, outcome: 'skipped', reason: 'The ban was revoked before this server was reached.' } as ServerResult;
            if (guild.ownerId === userId)
                return { ...base, outcome: 'not-allowed', reason: 'They own this server, and Discord does not allow banning a server owner.' } as ServerResult;
            const me = guild.members.me ?? await guild.members.fetchMe();
            if (!me.permissions.has(PermissionFlagsBits.BanMembers))
                return { ...base, outcome: 'missing-permissions', reason: MISSING_BAN_PERMISSION } as ServerResult;
            const member = await memberOrNull(guild, userId);
            if (member && me.roles.highest.comparePositionTo(member.roles.highest) <= 0)
                return { ...base, outcome: 'hierarchy', reason: BOT_BELOW_TARGET } as ServerResult;
            if (why === 'issued' && !member) {
                const existing = await currentBan(guild, userId);
                if (existing && hasTag(existing.reason, ban.kind))
                    return { ...base, outcome: 'already', reason: `Already banned by this ${ban.kind}.` } as ServerResult;
                if (existing) {
                    // Already banned by the server's own staff (or another ban type): that ban stays, and from now
                    // on this genreban/hardban covers it too (re-applied if anyone unbans them).
                    deps.store.recordCase(guild.id, userId, ban.moderator_id, ban.kind, `${recordId(ban)}: ${ban.reason} (they were already banned here)`, { username: ban.username, evidence: ban.evidence });
                    coverWithNetwork(deps.store, deps.logs, guild.id, { id: userId, tag: ban.username }, ban);
                    return { ...base, outcome: 'success', reason: `Already banned here; the ${ban.kind} now covers that ban too.` } as ServerResult;
                }
            }
            await guild.members.ban(userId, { reason: clip(`${TAG[ban.kind]} ${recordId(ban)} ${ban.moderator_id}: ${ban.reason}`, 500), deleteMessageSeconds: why === 'issued' ? deleteMessageSeconds : 0 });
            deps.store.recordCase(guild.id, userId, ban.moderator_id, ban.kind, `${recordId(ban)}: ${ban.reason}`, { username: ban.username, evidence: ban.evidence });
            // The ban already happened: a log card that can't be built must never turn it into a "failed" result.
            try { deps.logs.push(guild.id, networkBanLogEmbed(guild, ban, why)); } catch { /* the ban already happened */ }
            return { ...base, outcome: 'success', reason: member ? 'Banned (they were a member).' : 'Banned by user ID (they were not a member).' } as ServerResult;
        });
    } catch (error) {
        result = { ...base, ...classify(error, ban.kind) };
    }
    if (why === 'issued' || result.outcome === 'success')
        safeRecord(deps.store, ban.id, why === 'issued' ? 'ban' : `enforce-${why}`, result);
    return result;
}

/** Lifts only bans of one type that the bot itself placed. Never throws. */
export async function unbanIn(deps: NetworkDeps, guild: Guild, ban: NetworkBan, reason: string, actorId: string): Promise<ServerResult> {
    const base = { guildId: guild.id, name: guild.name };
    let result: ServerResult;
    try {
        result = await deps.store.withAuthorized(guild.id, async () => {
            const me = guild.members.me ?? await guild.members.fetchMe();
            if (!me.permissions.has(PermissionFlagsBits.BanMembers))
                return { ...base, outcome: 'missing-permissions', reason: MISSING_BAN_PERMISSION } as ServerResult;
            const existing = await currentBan(guild, ban.user_id);
            if (!existing)
                return { ...base, outcome: 'skipped', reason: 'Not banned here.' } as ServerResult;
            if (!hasTag(existing.reason, ban.kind)) {
                // The server's own ban stays; its record goes back to showing that ban.
                uncoverNetwork(deps.store, deps.logs, guild.id, ban.user_id, ban, actorId);
                return { ...base, outcome: 'skipped', reason: 'Banned here by something other than this ' + ban.kind + ' (local staff or another ban type), so left in place.' } as ServerResult;
            }
            await guild.members.unban(ban.user_id, clip(`${actorId}: un${ban.kind} ${recordId(ban)}: ${reason}`, 500));
            deps.store.recordCase(guild.id, ban.user_id, actorId, `un${ban.kind}`, `${recordId(ban)}: ${reason}`, { username: ban.username });
            try { deps.logs.push(guild.id, networkUnbanLogEmbed(guild, ban, reason, actorId)); } catch { /* the unban already happened */ }
            return { ...base, outcome: 'success', reason: 'Unbanned.' } as ServerResult;
        });
    } catch (error) {
        result = { ...base, ...classify(error, `un${ban.kind}`) };
    }
    safeRecord(deps.store, ban.id, 'unban', result);
    return result;
}

function safeRecord(store: Store, banId: number, action: string, result: ServerResult) {
    try {
        recordResult(store, banId, action, result);
    } catch (error) {
        logEvent('network_ban_record_failure', { banId, guildId: result.guildId, error: String(error) });
    }
}

// ---------------------------------------------------------------- telling the user

/**
 * DMs the user why they are being banned everywhere. Sent before any server bans them,
 * while they may still share a server with the bot (Discord only allows DMs then).
 * Never throws; returns whether Discord accepted the message.
 */
export async function notifyBannedUser(client: Client, ban: NetworkBan, servers: number): Promise<boolean> {
    try {
        const user = await client.users.fetch(ban.user_id);
        if (user.bot) return false;
        await user.send({
            embeds: [embed(`You have been ${ban.kind === 'hardban' ? 'hardbanned' : 'genrebanned'} by Ghost Vanguard`, [
                `You are being banned from **${servers}** server${servers === 1 ? '' : 's'} protected by Ghost Vanguard${ban.kind === 'hardban' ? ', permanently,' : ''} and will be banned again if you join one.`,
                '',
                `**Reason:** ${clip(ban.reason, 1000)}`,
                `**Record:** ${recordId(ban)}`,
                '',
                `Server staff cannot lift this ban. ${LIFT_AUTHORITY[ban.kind]} can lift it with /network un${ban.kind}.`,
            ].join('\n'), Colors.DarkRed)],
            allowedMentions: { parse: [] },
        });
        return true;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------- every server

export type Progress = (done: number, total: number, results: ServerResult[]) => unknown;

async function eachServer(deps: NetworkDeps, work: (guild: Guild) => Promise<ServerResult>, onProgress?: Progress): Promise<ServerResult[]> {
    const servers = targetServers(deps);
    const results: ServerResult[] = [];
    await onProgress?.(0, servers.length, results);
    // One server at a time: discord.js queues per route anyway, and this keeps the
    // bot well clear of Discord's invalid-request limits if many servers refuse.
    for (const guild of servers) {
        results.push(await work(guild));
        await onProgress?.(results.length, servers.length, results);
    }
    return results;
}

export function banEverywhere(deps: NetworkDeps, ban: NetworkBan, deleteMessageSeconds = 0, onProgress?: Progress) {
    return eachServer(deps, guild => banIn(deps, guild, ban, 'issued', deleteMessageSeconds), onProgress);
}

export function unbanEverywhere(deps: NetworkDeps, ban: NetworkBan, reason: string, actorId: string, onProgress?: Progress) {
    return eachServer(deps, guild => unbanIn(deps, guild, ban, reason, actorId), onProgress);
}

// ---------------------------------------------------------------- enforcement

/** Problems already reported, so a server that keeps refusing does not flood the logs. */
const reported = new Set<string>();

// ---------------------------------------------------------------- per-server genreban exceptions

export interface NetworkException { id: number; ban_id: number; guild_id: string; guild_name: string | null; user_id: string; by_id: string; reason: string; at: number; revoked_by: string | null; revoked_at: number | null }

/** The exception that lets this genrebanned user into this one server, if any. Hardbans never have one. */
export function activeException(store: Store, guildId: string, banId: number): NetworkException | undefined {
    return store.get('SELECT * FROM network_exceptions WHERE ban_id=? AND guild_id=? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1', banId, guildId) as NetworkException | undefined;
}

export function addException(store: Store, ban: NetworkBan, guild: { id: string; name?: string | null }, byId: string, reason: string, at = Date.now()): NetworkException {
    if (ban.kind !== 'genreban') throw new AppError('PERMISSION_ERROR', 'Hardbans have no exceptions: only a developer can lift one, for every server.');
    const existing = activeException(store, guild.id, ban.id);
    if (existing) return existing;
    const id = Number(store.run('INSERT INTO network_exceptions(ban_id,guild_id,guild_name,user_id,by_id,reason,at) VALUES(?,?,?,?,?,?,?)', ban.id, guild.id, guild.name ?? null, ban.user_id, byId, reason, at).lastInsertRowid);
    return store.get('SELECT * FROM network_exceptions WHERE id=?', id) as NetworkException;
}

export function revokeException(store: Store, id: number, byId: string, at = Date.now()): NetworkException | undefined {
    store.run('UPDATE network_exceptions SET revoked_by=?, revoked_at=? WHERE id=? AND revoked_at IS NULL', byId, at, id);
    return store.get('SELECT * FROM network_exceptions WHERE id=?', id) as NetworkException | undefined;
}

export function listExceptions(store: Store, userId?: string): (NetworkException & { kind: string; status: string })[] {
    return store.all(`SELECT e.*, b.kind, b.status FROM network_exceptions e JOIN network_bans b ON b.id=e.ban_id WHERE e.revoked_at IS NULL AND b.status='active'${userId ? ' AND e.user_id=?' : ''} ORDER BY e.at DESC LIMIT 50`, ...(userId ? [userId] : [])) as any;
}

async function enforce(deps: NetworkDeps, guild: Guild, ban: NetworkBan, why: Exclude<Why, 'issued'>): Promise<boolean> {
    // This server's owner/Head Admin let them back in here only. The genreban still applies everywhere else.
    if (ban.kind === 'genreban' && activeException(deps.store, guild.id, ban.id)) return false;
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
export async function enforceOnJoin(deps: NetworkDeps, guild: Guild, userId: string): Promise<boolean> {
    if (!deps.isReady(guild.id))
        return false;
    const ban = activeBan(deps.store, 'hardban', userId) ?? activeBan(deps.store, 'genreban', userId);
    return ban ? enforce(deps, guild, ban, 'joined') : false;
}

/** Someone was unbanned: a hardban is re-applied immediately. */
export async function enforceOnUnban(deps: NetworkDeps, guild: Guild, userId: string): Promise<boolean> {
    if (!deps.isReady(guild.id))
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
export async function sweepNetworkBans(deps: NetworkDeps): Promise<number> {
    if (sweeping)
        return 0;
    sweeping = true;
    let applied = 0;
    try {
        const hard = listActive(deps.store, 'hardban');
        const gen = listActive(deps.store, 'genreban').filter(g => !hard.some(h => h.user_id === g.user_id));
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
            let banned: Set<string>;
            let complete = true;
            try {
                const list = await guild.bans.fetch({ limit: 1000, cache: false });
                banned = new Set(list.keys());
                complete = list.size < 1000;
            } catch {
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
    } finally {
        sweeping = false;
    }
    return applied;
}

/** Builds the dependencies from a command context or the bot's services. */
export function networkDeps(s: { client: Client; store: Store; logs: LogQueue; lifecycle: { isReady(id: string): boolean } }, ready: () => boolean = () => true): NetworkDeps {
    return { client: s.client, store: s.store, logs: s.logs, isReady: id => ready() && s.lifecycle.isReady(id) };
}

export const DELETE_MESSAGE_CHOICES = [
    { name: 'Keep messages', value: 0 },
    { name: 'Last hour', value: 3600 },
    { name: 'Last 24 hours', value: 86400 },
    { name: 'Last 7 days', value: 604800 },
];

export function deleteWindow(seconds: number): string | null {
    return seconds === 604800 ? 'the last 7 days' : seconds === 86400 ? 'the last 24 hours' : seconds === 3600 ? 'the last hour' : null;
}

/** What a server ban currently is, for /moderation unban: local, genreban or hardban. */
export function banTypeFromReason(reason: string | null | undefined): NetworkKind | 'local' {
    if (hasTag(reason, 'hardban'))
        return 'hardban';
    if (hasTag(reason, 'genreban'))
        return 'genreban';
    return 'local';
}

/** The ban currently on this server for a user: null if none, undefined if Discord could not say. */
export async function existingBan(guild: Guild, userId: string): Promise<{ reason: string | null } | null | undefined> {
    try {
        const ban = await guild.bans.fetch({ user: userId, force: true });
        return { reason: ban.reason ?? null };
    } catch (error) {
        if (typeof error === 'object' && error && 'code' in error && Number(error.code) === 10026)
            return null;
        return undefined;
    }
}

/**
 * Local unbans (/mod unban, accepted appeals, expiring tempbans) must never lift a
 * genreban or hardban. Throws a plain explanation when one is in force.
 */
export async function assertLocalUnban(store: Store, guild: Guild, userId: string, existing?: { reason: string | null } | null) {
    const network = activeBan(store, 'hardban', userId) ?? activeBan(store, 'genreban', userId);
    if (network) {
        const authority = network.kind === 'hardban'
            ? 'Only a Developer can lift it with `/network unhardban`.'
            : 'A Supreme Leader or Developer can lift it from the ban-log controls or with `/network ungenreban`.';
        throw new AppError('PERMISSION_ERROR', `This user has an active ${network.kind}, **${recordId(network)}**, placed by a Ghost Vanguard developer. Server staff cannot lift it. ${authority}${network.kind === 'hardban' ? ' Unbanning them by hand is undone immediately.' : ' If they were unbanned by hand they would be banned again on joining.'}`);
    }
    const ban = existing === undefined ? await existingBan(guild, userId) : existing;
    const type = banTypeFromReason(ban?.reason);
    if (type !== 'local')
        throw new AppError('PERMISSION_ERROR', `This server ban was placed by a Ghost Vanguard ${type}. Local unbans only lift local bans; a developer can lift it with \`/network un${type}\`.`);
}

/**
 * A developer lifts a genreban/hardban from the ban log: revoke it, then unban everywhere it
 * placed a ban. Same effect as `/network unhardban` or `/network ungenreban`.
 */
export async function liftNetworkBan(deps: NetworkDeps, userId: string, by: { id: string; tag?: string }, reason: string) {
    const ban = activeBan(deps.store, 'hardban', userId) ?? activeBan(deps.store, 'genreban', userId);
    if (!ban) return { lifted: 0, failed: 0, servers: 0 };
    revokeBan(deps.store, ban, by, reason);
    const results = await unbanEverywhere(deps, ban, reason, by.id);
    return {
        lifted: results.filter(r => r.outcome === 'success').length,
        failed: results.filter(r => !['success', 'skipped', 'already'].includes(r.outcome)).length,
        servers: results.length,
    };
}
