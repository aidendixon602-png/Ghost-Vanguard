import { Colors, type Client, type GuildMember } from 'discord.js';
import type { Store } from '../database/db.js';
import type { LogQueue } from '../logging.js';
import { clip } from '../core.js';
import { logEvent } from '../errors.js';
import { embed } from '../ui/ui.js';
import { activeBan, recordId } from './network-ban.js';

/** Audit reason for anything Vanguard does on a staff member's behalf; anti-nuke counts it against them. */
export const staffReason = (actorId: string, reason: string) => clip(`${actorId}: ${reason}`, 500);

export const DAY = 86400000;
export type RaidAction = 'kick' | 'timeout';
export interface RaidState { enabled: boolean; minAgeDays: number; action: RaidAction; until: number | null; by: string | null; handled: number }

export function raidState(store: Store, guild: string, now = Date.now()): RaidState {
    const row = store.get('SELECT * FROM raidmode WHERE guild_id=?', guild);
    const active = !!row?.enabled && (!row.until || row.until > now);
    return { enabled: active, minAgeDays: Number(row?.min_age_days ?? 7), action: (row?.action ?? 'kick') as RaidAction, until: row?.until ?? null, by: row?.by_id ?? null, handled: Number(row?.handled ?? 0) };
}

export function setRaidMode(store: Store, guild: string, enabled: boolean, by: string, options: { minAgeDays?: number; action?: RaidAction; hours?: number } = {}) {
    store.run('INSERT OR IGNORE INTO guild_data(guild_id) VALUES(?)', guild);
    // Settings that are not given keep their current values (turning raid mode on or off must not reset them).
    const current = raidState(store, guild);
    const until = enabled && options.hours ? Date.now() + options.hours * 3600000 : null;
    store.run(`INSERT INTO raidmode(guild_id,enabled,min_age_days,action,until,by_id,handled) VALUES(?,?,?,?,?,?,0)
        ON CONFLICT(guild_id) DO UPDATE SET enabled=excluded.enabled,min_age_days=excluded.min_age_days,action=excluded.action,until=excluded.until,by_id=excluded.by_id,handled=CASE WHEN excluded.enabled=1 THEN 0 ELSE raidmode.handled END`,
        guild, Number(enabled), options.minAgeDays ?? current.minAgeDays, options.action ?? current.action, until, by);
    return raidState(store, guild);
}

/** Summaries are batched so a 500-account raid does not flood the security log. */
const pending = new Map<string, { count: number; names: string[]; timer: NodeJS.Timeout }>();

/**
 * Raid mode: new joins whose Discord account is younger than the configured age are kicked or
 * timed out. Bots are left to anti-nuke's Bot Add rule; trusted accounts are never touched.
 */
export async function handleRaidJoin(store: Store, logs: LogQueue, member: GuildMember, trusted: (id: string) => boolean, now = Date.now()): Promise<'ignored' | 'kicked' | 'timed out' | 'failed'> {
    const state = raidState(store, member.guild.id, now);
    if (!state.enabled || member.user.bot || trusted(member.id)) return 'ignored';
    const ageDays = (now - member.user.createdTimestamp) / DAY;
    if (ageDays >= state.minAgeDays) return 'ignored';
    const reason = `Ghost Vanguard raid mode: account ${Math.floor(ageDays)} day(s) old (minimum ${state.minAgeDays})`;
    let result: 'kicked' | 'timed out' | 'failed' = 'failed';
    try {
        if (state.action === 'kick' && member.kickable) { await member.kick(reason); result = 'kicked'; }
        else if (state.action === 'timeout' && member.moderatable) { await member.timeout(28 * DAY - 60000, reason); result = 'timed out'; }
    } catch { result = 'failed'; }
    store.run('UPDATE raidmode SET handled=handled+1 WHERE guild_id=?', member.guild.id);
    const key = member.guild.id, entry = pending.get(key) ?? { count: 0, names: [], timer: setTimeout(() => {
        const done = pending.get(key); pending.delete(key);
        if (done) logs.push(key, embed('Raid mode · new accounts handled', `${done.count} join(s) in the last 30 seconds:\n${done.names.slice(0, 15).join('\n')}${done.count > 15 ? `\n…and ${done.count - 15} more` : ''}\n\nTurn it off with \`/raid mode off\` when the raid is over.`, Colors.Orange));
    }, 30000) };
    entry.timer.unref?.();
    entry.count++; entry.names.push(`<@${member.id}> (${member.user.tag}) · ${Math.floor(ageDays)}d old · ${result}`);
    pending.set(key, entry);
    logEvent('raidmode_join', { guildId: member.guild.id, userId: member.id, result });
    return result;
}

/** Lift temporary bans whose time is up. Runs every minute. */
export async function sweepTempbans(store: Store, logs: LogQueue, client: Client, ready: (id: string) => boolean, now = Date.now()) {
    const due = store.db.prepare('SELECT * FROM tempbans WHERE until<=? ORDER BY until LIMIT 50').all(now) as any[];
    for (const row of due) {
        const guild = client.guilds.cache.get(row.guild_id);
        if (!guild || !ready(guild.id) || !store.isAuthorized(guild.id)) continue;
        await store.withAuthorized(guild.id, async () => {
            // The tempban ends, but a genreban or hardban placed since keeps them banned.
            const network = activeBan(store, 'hardban', row.user_id) ?? activeBan(store, 'genreban', row.user_id);
            if (network) {
                store.run('DELETE FROM tempbans WHERE guild_id=? AND user_id=?', guild.id, row.user_id);
                logs.push(guild.id, embed('Temporary ban ended · still banned', `**User:** <@${row.user_id}> (${row.user_id})\n**Original case:** #${row.case_number ?? '?'}\nThe temporary ban ended, but they have an active ${network.kind} (**${recordId(network)}**), so they stay banned until a developer lifts it.`, Colors.Orange));
                return;
            }
            let outcome = 'unbanned';
            try { await guild.bans.remove(row.user_id, `Ghost Vanguard: temporary ban expired (case #${row.case_number ?? '?'})`); }
            catch (error: any) { outcome = error?.code === 10026 ? 'already unbanned' : 'unban failed'; if (outcome === 'unban failed') return; }
            store.run('DELETE FROM tempbans WHERE guild_id=? AND user_id=?', guild.id, row.user_id);
            const number = store.recordCase(guild.id, row.user_id, client.user?.id ?? 'system', 'unban', `Temporary ban from case #${row.case_number ?? '?'} expired (${outcome}).`);
            logs.push(guild.id, embed(`Case #${number} · temporary ban expired`, `**User:** <@${row.user_id}> (${row.user_id})\n**Original case:** #${row.case_number ?? '?'}\n**Result:** ${outcome}`, Colors.Green));
        });
    }
}
