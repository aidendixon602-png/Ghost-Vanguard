import { Colors, type Client, type Guild } from 'discord.js';
import type { Store } from '../database/db.js';
import type { LogQueue } from '../logging.js';
import { embed } from '../ui/ui.js';
import { lockGuild, lockdownState, unlockGuild } from '../security/lockdown.js';
import { getFeature, setFeature } from './settings.js';

/**
 * Timed jobs, checked once a minute:
 *  - Lockdown schedule ("quiet hours"): lock the server at the start time and unlock at the end.
 *    Only a lock this schedule made is undone; a manual /raid lockdown is left alone.
 *  - Weekly staff activity report in the security log.
 */
export interface LockScheduleConfig { enabled: boolean; start: string; end: string; utcOffset: number; lockedBySchedule: boolean }
export const LOCK_SCHEDULE_DEFAULTS: LockScheduleConfig = { enabled: false, start: '00:00', end: '07:00', utcOffset: 0, lockedBySchedule: false };
export const lockScheduleConfig = (store: Store, guild: string) => getFeature(store, guild, 'lockschedule', LOCK_SCHEDULE_DEFAULTS);

const toMinutes = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h! * 60 + m!; };
export const validTime = (v: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

/** True when `now` falls inside the daily window (which may cross midnight) in the server's time zone. */
export function inWindow(c: Pick<LockScheduleConfig, 'start' | 'end' | 'utcOffset'>, now = Date.now()): boolean {
    const local = ((Math.floor(now / 60000) + Math.round(c.utcOffset * 60)) % 1440 + 1440) % 1440;
    const start = toMinutes(c.start), end = toMinutes(c.end);
    if (start === end) return false;
    return start < end ? local >= start && local < end : local >= start || local < end;
}

export const SCHEDULE_REASON = 'Scheduled lockdown (quiet hours)';

export interface ScheduleDeps { store: Store; logs: LogQueue; client: Client; ready: (id: string) => boolean; locks: { run<T>(ids: string[], fn: () => Promise<T>): Promise<T>; busy(id: string): boolean } }

async function runLockSchedule(d: ScheduleDeps, guild: Guild, now: number) {
    const c = lockScheduleConfig(d.store, guild.id);
    if (!c.enabled && !c.lockedBySchedule) return;
    const inside = c.enabled && inWindow(c, now);
    const locked = !!lockdownState(d.store, guild.id);
    if (inside && !c.lockedBySchedule && !locked && !d.locks.busy(guild.id)) {
        setFeature(d.store, guild.id, 'lockschedule', LOCK_SCHEDULE_DEFAULTS, { lockedBySchedule: true });
        const reopen = `${c.end} (UTC${c.utcOffset >= 0 ? '+' : ''}${c.utcOffset})`;
        const r = await d.locks.run([guild.id], () => lockGuild(d, guild, d.client.user!.id, `Quiet hours: chat is paused until ${reopen}.`, SCHEDULE_REASON));
        d.logs.push(guild.id, embed('🔒 Scheduled lockdown started', `Quiet hours began. **${r.locked}** of ${r.total} channels locked. Chat reopens automatically at **${reopen}**.\nUse \`/raid unlock\` to end it early.`, Colors.Orange));
    } else if (!inside && c.lockedBySchedule) {
        const state = lockdownState(d.store, guild.id);
        // Only undo a lockdown this schedule made. A manual /raid lockdown (e.g. during a raid) is left alone.
        const ours = state && String(state.reason ?? '') === SCHEDULE_REASON;
        if (ours && d.locks.busy(guild.id)) return; // try again next minute; keep the flag so we do not forget
        if (ours) {
            const r = await d.locks.run([guild.id], () => unlockGuild(d, guild, d.client.user!.id, 'Quiet hours are over. Chat is open again.', true));
            d.logs.push(guild.id, embed('🔓 Scheduled lockdown ended', `Quiet hours ended; **${r.restored}** of ${r.total} channels were restored exactly as they were.`, Colors.Green));
        }
        setFeature(d.store, guild.id, 'lockschedule', LOCK_SCHEDULE_DEFAULTS, { lockedBySchedule: false });
    }
}

export interface ReportConfig { enabled: boolean; lastAt: number }
export const REPORT_DEFAULTS: ReportConfig = { enabled: true, lastAt: 0 };
const WEEK = 7 * 24 * 3600000;

/** Cases per staff member over the last `days`. */
export function activityReport(store: Store, guild: string, botId: string, days = 7, now = Date.now()): string {
    const since = now - days * 24 * 3600000;
    const rows = store.all('SELECT moderator_id,action,COUNT(*) AS n FROM cases WHERE guild_id=? AND at>=? GROUP BY moderator_id,action', guild, since);
    const people = new Map<string, Map<string, number>>();
    for (const r of rows) {
        const id = String(r.moderator_id);
        if (id === botId || !/^\d{17,20}$/.test(id)) continue;
        const m = people.get(id) ?? new Map<string, number>(); m.set(String(r.action), Number(r.n)); people.set(id, m);
    }
    const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    const lines = [...people.entries()].sort((a, b) => total(b[1]) - total(a[1])).slice(0, 25).map(([id, m], n) => {
        const parts = [...m.entries()].sort((a, b) => b[1] - a[1]).map(([a, c]) => `${c} ${a}`).join(', ');
        return `**${n + 1}.** <@${id}> · **${total(m)}** action${total(m) === 1 ? '' : 's'}${parts ? ` (${parts})` : ''}`;
    });
    const botActions = Number(store.get('SELECT COUNT(*) AS n FROM cases WHERE guild_id=? AND at>=? AND moderator_id=?', guild, since, botId)?.n ?? 0);
    return `${lines.join('\n') || 'No staff actions in this period.'}${botActions ? `\n\n🤖 Vanguard took **${botActions}** automatic action${botActions === 1 ? '' : 's'}.` : ''}`;
}

async function runWeeklyReport(d: ScheduleDeps, guild: Guild, now: number) {
    const c = getFeature(d.store, guild.id, 'report', REPORT_DEFAULTS);
    if (!c.enabled) return;
    if (!c.lastAt) { setFeature(d.store, guild.id, 'report', REPORT_DEFAULTS, { lastAt: now }); return; } // first report a week from now
    if (now - c.lastAt < WEEK) return;
    setFeature(d.store, guild.id, 'report', REPORT_DEFAULTS, { lastAt: now });
    d.logs.push(guild.id, embed('📊 Weekly staff activity', `<t:${Math.floor((now - WEEK) / 1000)}:d> → <t:${Math.floor(now / 1000)}:d>\n\n${activityReport(d.store, guild.id, d.client.user!.id, 7, now)}\n\n-# Turn off with \`/setup staff report weekly:false\`.`, Colors.Blurple));
}

export async function runSchedules(d: ScheduleDeps, now = Date.now()) {
    for (const guild of d.client.guilds.cache.values()) {
        if (!d.ready(guild.id)) continue;
        await d.store.withAuthorized(guild.id, async () => {
            await runLockSchedule(d, guild, now).catch(() => { });
            await runWeeklyReport(d, guild, now).catch(() => { });
        }).catch(() => { });
    }
}
