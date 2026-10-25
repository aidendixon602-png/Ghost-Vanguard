import { type Client } from 'discord.js';
import type { Store } from '../database/db.js';
import { clip } from '../core.js';

/**
 * The threat board is Ghost Vanguard's staff-facing incident memory. Anti-nuke incidents, scam posts,
 * ping-abuse cases and raid joins add points so staff can see repeat offenders and their history.
 *
 * Scores never cause automatic containment, strikes or server-log posts. Staff keep the manual
 * controls under `/antinuke threats`; ordinary anti-nuke enforcement is independent and unchanged.
 * Quiet scores halve every day and expire completely after a week.
 */

export const THREAT_POINTS: Record<string, { points: number; label: string }> = {
    mass_ban: { points: 40, label: 'Mass ban' },
    bot_add: { points: 35, label: 'Added a bot' },
    dangerous_grant: { points: 35, label: 'Granted dangerous permissions' },
    mass_kick: { points: 30, label: 'Mass kick' },
    channel_delete: { points: 25, label: 'Deleted channels' },
    role_delete: { points: 25, label: 'Deleted roles' },
    automod_tamper: { points: 25, label: 'Tampered with AutoMod' },
    member_prune: { points: 20, label: 'Pruned members' },
    webhook_change: { points: 20, label: 'Changed webhooks' },
    guild_update: { points: 15, label: 'Changed server settings' },
    role_create: { points: 15, label: 'Created roles' },
    scam_post: { points: 15, label: 'Posted a scam' },
    antiping: { points: 10, label: 'Mention-spammed staff' },
    join_flood: { points: 10, label: 'Join flood' },
    channel_create: { points: 10, label: 'Created channels' },
    role_grant: { points: 10, label: 'Gave out roles' },
    timeout: { points: 10, label: 'Mass timeouts' },
    channel_update: { points: 5, label: 'Changed channels' },
    role_update: { points: 5, label: 'Changed roles' },
};

export const THREAT_LEVELS = [
    { key: 'quiet', label: '🟢 Quiet', from: 0 },
    { key: 'watch', label: '🟡 Watch', from: 25 },
    { key: 'high', label: '🟠 High', from: 55 },
    { key: 'critical', label: '🔴 Critical', from: 85 },
] as const;
export type ThreatLevel = (typeof THREAT_LEVELS)[number]['key'];

/** Score for one incident; a rule the board does not know is worth a small amount, never nothing. */
export const pointsFor = (rule: string) => THREAT_POINTS[rule]?.points ?? 5;

export function levelFor(score: number): ThreatLevel {
    // A row we cannot read as a number is treated as no score rather than blowing up a caller mid-incident.
    const value = Number.isFinite(score) ? score : 0;
    return [...THREAT_LEVELS].reverse().find(level => value >= level.from)!.key;
}

export const levelLabel = (level: ThreatLevel) => THREAT_LEVELS.find(l => l.key === level)!.label;

/** Scores halve after this long without an incident. */
export const DECAY_AFTER_MS = 24 * 3600 * 1000;
/** A threat disappears from the board after this long. */
export const THREAT_TTL_MS = 7 * 24 * 3600 * 1000;

export interface ThreatRow {
    guild_id: string; user_id: string; score: number; level: ThreatLevel;
    first_at: number; last_at: number; last_rule: string; strikes: number;
    last_action_at: number | null; last_action: string | null; cleared_at: number | null;
}

export interface ThreatEvent { id: number; guild_id: string; user_id: string; rule: string; points: number; detail: string; at: number }
export interface ThreatAction { id: number; guild_id: string; user_id: string; action: string; detail: string; by_id: string; at: number; undone_at: number | null; undone_by: string | null }

/** Add points for something a person did. Returns their new row, or null for something we do not score. */
export function recordThreat(store: Store, guildId: string, userId: string, rule: string, detail: string, at = Date.now()): ThreatRow | null {
    if (!THREAT_POINTS[rule] && rule !== 'manual')
        return null;
    const points = pointsFor(rule);
    const found = store.get('SELECT * FROM threat_scores WHERE guild_id=? AND user_id=?', guildId, userId) as ThreatRow | undefined;
    // Only a row we can actually read counts: a caller with a stub store must not turn into a crash
    // in the middle of handling an incident on a live server.
    const existing = found && Number.isFinite(Number(found.score)) && Number.isFinite(Number(found.last_at)) ? found : undefined;
    // A cleared threat starts again from this incident, so staff clearing a false alarm is respected.
    const base = existing && !existing.cleared_at ? decayedScore(existing, at) : 0;
    const score = base + points;
    const level = levelFor(score);
    store.run(`INSERT INTO threat_scores(guild_id,user_id,score,level,first_at,last_at,last_rule,strikes,cleared_at)
            VALUES(?,?,?,?,?,?,?,?,NULL) ON CONFLICT(guild_id,user_id) DO UPDATE SET
            score=excluded.score, level=excluded.level, first_at=excluded.first_at, last_at=excluded.last_at,
            last_rule=excluded.last_rule, cleared_at=NULL`,
        guildId, userId, score, level, existing?.first_at ?? at, at, rule, existing?.strikes ?? 0);
    store.run('INSERT INTO threat_events(guild_id,user_id,rule,points,detail,at) VALUES(?,?,?,?,?,?)', guildId, userId, rule, points, clip(detail, 500), at);
    return store.get('SELECT * FROM threat_scores WHERE guild_id=? AND user_id=?', guildId, userId) as ThreatRow;
}

/**
 * The version every protection path calls: recording is bookkeeping, so a database hiccup must never
 * stop a raid from being contained or a scam message from being removed. Failures are logged and the
 * caller carries on.
 */
export function noteThreat(store: Store, guildId: string, userId: string, rule: string, detail: string, at = Date.now()): ThreatRow | null {
    try {
        return recordThreat(store, guildId, userId, rule, detail, at);
    } catch (error) {
        console.warn(`[threats] could not record ${rule} for ${userId}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}

/** Scores halve once per quiet day, so one bad hour does not mark someone forever. */
export function decayedScore(row: { score: number; last_at: number }, now = Date.now()) {
    const score = Number(row.score);
    if (!Number.isFinite(score) || score <= 0)
        return 0;
    const days = Math.floor((now - Number(row.last_at)) / DECAY_AFTER_MS);
    if (!Number.isFinite(days) || days <= 0)
        return score;
    return Math.floor(score / 2 ** Math.min(days, 8));
}

/** Refresh every stored score for a guild: decay the quiet ones and drop the expired ones. */
export function decayThreats(store: Store, guildId: string, now = Date.now()) {
    let changed = 0, expired = 0;
    for (const row of store.all('SELECT * FROM threat_scores WHERE guild_id=? AND cleared_at IS NULL', guildId) as unknown as ThreatRow[]) {
        if (now - row.last_at > THREAT_TTL_MS) {
            store.run('DELETE FROM threat_scores WHERE guild_id=? AND user_id=?', guildId, row.user_id).changes && expired++;
            continue;
        }
        const score = decayedScore(row, now);
        if (score === row.score)
            continue;
        store.run('UPDATE threat_scores SET score=?, level=? WHERE guild_id=? AND user_id=?', score, levelFor(score), guildId, row.user_id);
        changed++;
    }
    return { changed, expired };
}

export const board = (store: Store, guildId: string, limit = 25) =>
    store.all('SELECT * FROM threat_scores WHERE guild_id=? AND cleared_at IS NULL ORDER BY score DESC, last_at DESC LIMIT ?', guildId, limit) as unknown as ThreatRow[];

export const threatFor = (store: Store, guildId: string, userId: string) =>
    store.get('SELECT * FROM threat_scores WHERE guild_id=? AND user_id=?', guildId, userId) as ThreatRow | undefined;

export const threatEvents = (store: Store, guildId: string, userId: string, limit = 10) =>
    store.all('SELECT * FROM threat_events WHERE guild_id=? AND user_id=? ORDER BY at DESC LIMIT ?', guildId, userId, limit) as unknown as ThreatEvent[];

export const threatActions = (store: Store, guildId: string, limit = 15) =>
    store.all('SELECT * FROM threat_actions WHERE guild_id=? ORDER BY id DESC LIMIT ?', guildId, limit) as unknown as ThreatAction[];

export function clearThreat(store: Store, guildId: string, userId: string, byId: string) {
    const changed = store.run('UPDATE threat_scores SET cleared_at=?, cleared_by=?, score=0, level=? WHERE guild_id=? AND user_id=? AND cleared_at IS NULL',
        Date.now(), byId, 'quiet', guildId, userId);
    return !!changed.changes;
}

export function recordThreatAction(store: Store, guildId: string, userId: string, action: string, detail: string, byId: string) {
    const at = Date.now();
    store.run('INSERT INTO threat_actions(guild_id,user_id,action,detail,by_id,at) VALUES(?,?,?,?,?,?)', guildId, userId, action, clip(detail, 500), byId, at);
    store.run('UPDATE threat_scores SET last_action=?, last_action_at=? WHERE guild_id=? AND user_id=?', action, at, guildId, userId);
    if (action === 'strike')
        store.run('UPDATE threat_scores SET strikes=strikes+1 WHERE guild_id=? AND user_id=?', guildId, userId);
    return at;
}

export interface ThreatMaintenanceDeps {
    store: Store;
    client: Client;
    ready: (guildId: string) => boolean;
    now?: () => number;
}

export interface ThreatMaintenanceResult { guilds: number; changed: number; expired: number }

/**
 * Periodic board maintenance only: decay old scores and expire inactive entries. This deliberately
 * has no containment, ban or logging dependencies, so score upkeep cannot enforce or post cards.
 */
export async function maintainThreats(deps: ThreatMaintenanceDeps): Promise<ThreatMaintenanceResult> {
    const now = (deps.now ?? Date.now)();
    const result: ThreatMaintenanceResult = { guilds: 0, changed: 0, expired: 0 };
    for (const guild of deps.client.guilds.cache.values()) {
        if (!deps.ready(guild.id))
            continue;
        const outcome = await deps.store.withAuthorized(guild.id, async () => decayThreats(deps.store, guild.id, now));
        result.guilds++;
        result.changed += outcome.changed;
        result.expired += outcome.expired;
    }
    return result;
}

export interface BoardSummary { total: number; critical: number; high: number; watch: number; top: ThreatRow[] }

/** The numbers behind the dashboard and `/antinuke threats list`. */
export function boardSummary(store: Store, guildId: string, now = Date.now()): BoardSummary {
    const rows = board(store, guildId, 100).map(row => ({ ...row, score: decayedScore(row, now) }));
    return {
        total: rows.length,
        critical: rows.filter(r => levelFor(r.score) === 'critical').length,
        high: rows.filter(r => levelFor(r.score) === 'high').length,
        watch: rows.filter(r => levelFor(r.score) === 'watch').length,
        top: rows.sort((a, b) => b.score - a.score).slice(0, 5),
    };
}
