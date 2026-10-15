import type { Store } from '../database/db.js';
import { VERSION } from '../config.js';
import { board, boardSummary, decayedScore, levelFor, levelLabel, THREAT_POINTS, threatActions } from '../security/threat-board.js';
import { reportEmbed, ticketStats, weeklyReport } from '../features/tickets.js';

/**
 * Everything the dashboard shows, assembled from the same tables the bot uses — no second copy of the
 * data and no writes. Every function is pure and safe to call from an HTTP handler or a test.
 */

export interface GuildSummary {
    id: string;
    name: string;
    active: boolean;
    authorized: boolean;
    protection: { enabled: boolean; mode: string; rules: number; trusted: number };
    threats: { total: number; critical: number; high: number; watch: number };
    tickets: { total: number; open: number; closed: number; average: number | null; openNow: number; unclaimed: number };
    incidents: { last24h: number; total: number };
    cases: number;
    snapshots: number;
    scams: number;
}

const ids = (store: Store) =>
    store.all('SELECT guild_id,name,active FROM guild_data ORDER BY name').map(row => ({ id: String(row.guild_id), name: String(row.name || row.guild_id), active: !!row.active }));

export function guilds(store: Store): { id: string; name: string; active: boolean; authorized: boolean }[] {
    return ids(store).map(guild => ({ ...guild, authorized: store.isAuthorized(guild.id) }));
}

export function guildSummary(store: Store, guildId: string, now = Date.now()): GuildSummary {
    const row = store.get('SELECT guild_id,name,active FROM guild_data WHERE guild_id=?', guildId);
    const settings = store.settings(guildId);
    const threats = boardSummary(store, guildId, now);
    const tickets = ticketStats(store, guildId);
    const week = weeklyReport(store, guildId, now);
    const rules = store.all('SELECT rule FROM antinuke_rules WHERE guild_id=? AND enabled=1', guildId);
    const trusted = store.all('SELECT user_id FROM grants WHERE guild_id=? AND kind=?', guildId, 'trusted');
    const count = (sql: string, ...args: (string | number)[]) => Number(store.get(sql, guildId, ...args)?.n ?? 0);
    return {
        id: guildId,
        name: String(row?.name || guildId),
        active: row ? !!row.active : false,
        authorized: store.isAuthorized(guildId),
        protection: { enabled: settings.enabled, mode: settings.mode, rules: rules.length, trusted: trusted.length },
        threats: { total: threats.total, critical: threats.critical, high: threats.high, watch: threats.watch },
        tickets: { total: tickets.total, open: tickets.open, closed: tickets.closed, average: tickets.average, openNow: week.openNow, unclaimed: week.unclaimed },
        incidents: { last24h: count('SELECT COUNT(*) n FROM incidents WHERE guild_id=? AND at>?', now - 86400000), total: count('SELECT COUNT(*) n FROM incidents WHERE guild_id=?') },
        cases: count('SELECT COUNT(*) n FROM cases WHERE guild_id=?'),
        snapshots: count('SELECT COUNT(*) n FROM snapshots WHERE guild_id=?'),
        scams: count('SELECT COUNT(*) n FROM scam_events WHERE guild_id=?'),
    };
}

export function overview(store: Store, now = Date.now()) {
    const summaries = guilds(store).map(guild => guildSummary(store, guild.id, now));
    return {
        service: 'Ghost Vanguard',
        version: VERSION,
        generatedAt: now,
        totals: {
            servers: summaries.length,
            authorized: summaries.filter(s => s.authorized).length,
            protected: summaries.filter(s => s.protection.enabled).length,
            critical: summaries.reduce((n, s) => n + s.threats.critical, 0),
            high: summaries.reduce((n, s) => n + s.threats.high, 0),
            watch: summaries.reduce((n, s) => n + s.threats.watch, 0),
            openTickets: summaries.reduce((n, s) => n + s.tickets.open, 0),
            tickets: summaries.reduce((n, s) => n + s.tickets.total, 0),
            incidents24h: summaries.reduce((n, s) => n + s.incidents.last24h, 0),
        },
        servers: summaries,
    };
}

/** The board itself: who is being watched, why, and what the bot has already done about it. */
export function threats(store: Store, guildId: string, now = Date.now()) {
    const rows = board(store, guildId, 50).map(row => {
        const score = decayedScore(row, now);
        return {
            userId: row.user_id,
            score,
            level: levelFor(score),
            levelLabel: levelLabel(levelFor(score)),
            lastRule: row.last_rule,
            lastRuleLabel: THREAT_POINTS[row.last_rule]?.label ?? row.last_rule,
            firstSeen: row.first_at,
            lastSeen: row.last_at,
            strikes: row.strikes,
            lastAction: row.last_action,
            lastActionAt: row.last_action_at,
        };
    });
    return {
        guildId,
        generatedAt: now,
        summary: boardSummary(store, guildId, now),
        threats: rows,
        actions: threatActions(store, guildId, 25).map(action => ({ at: action.at, userId: action.user_id, action: action.action, detail: action.detail, by: action.by_id })),
    };
}

export function incidents(store: Store, guildId: string, limit = 25) {
    return store.all('SELECT id,actor_id,rule,at,mode,result FROM incidents WHERE guild_id=? ORDER BY id DESC LIMIT ?', guildId, limit)
        .map(row => ({ id: Number(row.id), actor: String(row.actor_id), rule: String(row.rule), at: Number(row.at), mode: String(row.mode), result: String(row.result) }));
}

export function tickets(store: Store, guildId: string, now = Date.now()) {
    const rows = store.all('SELECT number,user_id,type,subject,claimed_by,priority,status,opened_at,closed_at,rating FROM ticket_records WHERE guild_id=? ORDER BY id DESC LIMIT 25', guildId)
        .map(row => ({ number: Number(row.number), user: String(row.user_id), type: String(row.type), subject: String(row.subject ?? ''), claimedBy: row.claimed_by ?? null,
            priority: String(row.priority), status: String(row.status), openedAt: Number(row.opened_at), closedAt: row.closed_at === null ? null : Number(row.closed_at), rating: row.rating === null ? null : Number(row.rating) }));
    const recent = store.all('SELECT * FROM ticket_records WHERE guild_id=? LIMIT 1', guildId);
    return { guildId, generatedAt: now, stats: ticketStats(store, guildId), week: weeklyReport(store, guildId, now), tickets: rows, hasTickets: recent.length > 0 };
}

export function serverDetail(store: Store, guildId: string, now = Date.now()) {
    return {
        ...guildSummary(store, guildId, now),
        board: threats(store, guildId, now),
        incidents: incidents(store, guildId, 10),
        tickets: tickets(store, guildId, now),
    };
}

/** The report the dashboard shows for one server's week, as text lines (kept out of the HTTP layer). */
export function weeklyLines(store: Store, guildId: string, guildName: string, now = Date.now()) {
    const card = reportEmbed({ name: guildName } as any, weeklyReport(store, guildId, now), now);
    const json = card.toJSON();
    return (json.fields ?? []).map(field => `${field.name}: ${field.value.replace(/\*\*/g, '')}`);
}
