import { Colors } from 'discord.js';
import { clip } from '../core.js';
import { logEvent } from '../errors.js';
import { embed } from '../ui/ui.js';
import { activeBan, recordId } from './network-ban.js';
/** Audit reason for anything Vanguard does on a staff member's behalf; anti-nuke counts it against them. */
export const staffReason = (actorId, reason) => clip(`${actorId}: ${reason}`, 500);
export const DAY = 86400000;
export function raidState(store, guild, now = Date.now()) {
    const row = store.get('SELECT * FROM raidmode WHERE guild_id=?', guild);
    const active = !!row?.enabled && (!row.until || row.until > now);
    return { enabled: active, minAgeDays: Number(row?.min_age_days ?? 7), action: (row?.action ?? 'kick'), until: row?.until ?? null, by: row?.by_id ?? null, handled: Number(row?.handled ?? 0) };
}
export function setRaidMode(store, guild, enabled, by, options = {}) {
    store.run('INSERT OR IGNORE INTO guild_data(guild_id) VALUES(?)', guild);
    // Settings that are not given keep their current values (turning raid mode on or off must not reset them).
    const current = raidState(store, guild);
    const until = enabled && options.hours ? Date.now() + options.hours * 3600000 : null;
    store.run(`INSERT INTO raidmode(guild_id,enabled,min_age_days,action,until,by_id,handled) VALUES(?,?,?,?,?,?,0)
        ON CONFLICT(guild_id) DO UPDATE SET enabled=excluded.enabled,min_age_days=excluded.min_age_days,action=excluded.action,until=excluded.until,by_id=excluded.by_id,handled=CASE WHEN excluded.enabled=1 THEN 0 ELSE raidmode.handled END`, guild, Number(enabled), options.minAgeDays ?? current.minAgeDays, options.action ?? current.action, until, by);
    return raidState(store, guild);
}
/** While raid mode is on, a joiner whose name matches this many other recent joiners is handled whatever its age. */
export const LOOKALIKE_WINDOW_MS = 10 * 60 * 1000;
export const LOOKALIKE_MATCHES = 2;
// ---- names (lookalike waves) ----
/** A name's pattern: lower case, letters only, numbers and separators dropped ("Raider_01" and "raider.02" match). */
export function nameKey(name) {
    const key = String(name ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z]/g, '');
    return key.length >= 3 ? key : null;
}
const joins = new Map();
/** Remember a join (for lookalike checks). */
export function rememberJoin(guildId, member, now = Date.now()) {
    const key = nameKey(member.user.username);
    const list = (joins.get(guildId) ?? []).filter(j => now - j.at < LOOKALIKE_WINDOW_MS && j.id !== member.id);
    if (key)
        list.push({ key, id: member.id, at: now });
    joins.set(guildId, list.slice(-500));
}
/** How many other recent joiners share this member's name pattern. */
export function lookalikes(guildId, member, now = Date.now()) {
    const key = nameKey(member.user.username);
    if (!key)
        return 0;
    return (joins.get(guildId) ?? []).filter(j => j.id !== member.id && j.key === key && now - j.at < LOOKALIKE_WINDOW_MS).length;
}
export function forgetJoins(guildId) {
    joins.delete(guildId);
}
/** Members already handled for this raid (a wave sweep and the join itself can both reach the same person). */
const handledRecently = new Map();
/** Summaries are batched so a 500-account raid does not flood the security log. */
const pending = new Map();
/**
 * Raid mode: new joins whose Discord account is younger than the configured age are kicked or
 * timed out. Bots are left to anti-nuke's Bot Add rule; trusted accounts are never touched.
 */
export async function handleRaidJoin(store, logs, member, trusted, now = Date.now()) {
    if (!member.user.bot)
        rememberJoin(member.guild.id, member, now);
    const state = raidState(store, member.guild.id, now);
    if (!state.enabled || member.user.bot || trusted(member.id))
        return 'ignored';
    // The same join reached twice (a wave sweep and the join event): handled once. A rejoin is a new join.
    const seenKey = member.joinedTimestamp ? `${member.guild.id}:${member.id}:${member.joinedTimestamp}` : null;
    if (seenKey && now - (handledRecently.get(seenKey) ?? 0) < 60000)
        return 'ignored';
    const ageDays = (now - member.user.createdTimestamp) / DAY;
    const alike = lookalikes(member.guild.id, member, now);
    if (ageDays >= state.minAgeDays && alike < LOOKALIKE_MATCHES)
        return 'ignored';
    if (seenKey)
        handledRecently.set(seenKey, now);
    for (const [k, at] of handledRecently)
        if (now - at > 60000)
            handledRecently.delete(k);
    const reason = ageDays < state.minAgeDays
        ? `Ghost Vanguard raid mode: account ${Math.floor(ageDays)} day(s) old (minimum ${state.minAgeDays})`
        : `Ghost Vanguard raid mode: name matches ${alike} other account(s) that just joined`;
    let result = 'failed';
    try {
        if (state.action === 'kick' && member.kickable) {
            await member.kick(reason);
            result = 'kicked';
        }
        else if (state.action === 'timeout' && member.moderatable) {
            await member.timeout(28 * DAY - 60000, reason);
            result = 'timed out';
        }
    }
    catch {
        result = 'failed';
    }
    store.run('UPDATE raidmode SET handled=handled+1 WHERE guild_id=?', member.guild.id);
    const key = member.guild.id, entry = pending.get(key) ?? { count: 0, names: [], timer: setTimeout(() => {
            const done = pending.get(key);
            pending.delete(key);
            if (done)
                logs.push(key, embed('Raid mode · new accounts handled', `${done.count} join(s) in the last 30 seconds:\n${done.names.slice(0, 15).join('\n')}${done.count > 15 ? `\n…and ${done.count - 15} more` : ''}\n\nTurn it off with \`/raid mode off\` when the raid is over.`, Colors.Orange));
        }, 30000) };
    entry.timer.unref?.();
    entry.count++;
    entry.names.push(`<@${member.id}> (${member.user.tag}) · ${ageDays < state.minAgeDays ? `${Math.floor(ageDays)}d old` : `lookalike of ${alike}`} · ${result}`);
    pending.set(key, entry);
    logEvent('raidmode_join', { guildId: member.guild.id, userId: member.id, result });
    return result;
}
/** Lift temporary bans whose time is up. Runs every minute. */
export async function sweepTempbans(store, logs, client, ready, now = Date.now()) {
    const due = store.db.prepare('SELECT * FROM tempbans WHERE until<=? ORDER BY until LIMIT 50').all(now);
    for (const row of due) {
        const guild = client.guilds.cache.get(row.guild_id);
        if (!guild || !ready(guild.id) || !store.isAuthorized(guild.id))
            continue;
        await store.withAuthorized(guild.id, async () => {
            // The tempban ends, but a genreban or hardban placed since keeps them banned.
            const network = activeBan(store, 'hardban', row.user_id) ?? activeBan(store, 'genreban', row.user_id);
            if (network) {
                store.run('DELETE FROM tempbans WHERE guild_id=? AND user_id=?', guild.id, row.user_id);
                logs.push(guild.id, embed('Temporary ban ended · still banned', `**User:** <@${row.user_id}> (${row.user_id})\n**Original case:** #${row.case_number ?? '?'}\nThe temporary ban ended, but they have an active ${network.kind} (**${recordId(network)}**), so they stay banned until a developer lifts it.`, Colors.Orange));
                return;
            }
            let outcome = 'unbanned';
            try {
                await guild.bans.remove(row.user_id, `Ghost Vanguard: temporary ban expired (case #${row.case_number ?? '?'})`);
            }
            catch (error) {
                outcome = error?.code === 10026 ? 'already unbanned' : 'unban failed';
                if (outcome === 'unban failed')
                    return;
            }
            store.run('DELETE FROM tempbans WHERE guild_id=? AND user_id=?', guild.id, row.user_id);
            const number = store.recordCase(guild.id, row.user_id, client.user?.id ?? 'system', 'unban', `Temporary ban from case #${row.case_number ?? '?'} expired (${outcome}).`);
            logs.push(guild.id, embed(`Case #${number} · temporary ban expired`, `**User:** <@${row.user_id}> (${row.user_id})\n**Original case:** #${row.case_number ?? '?'}\n**Result:** ${outcome}`, Colors.Green));
        });
    }
}
