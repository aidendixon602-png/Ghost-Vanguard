import { Colors, type Client, type Guild } from 'discord.js';
import type { Store } from '../database/db.js';
import { activeWorkspaceConfig } from './config.js';
import { selectedChannel } from './permissions.js';
import { WorkspaceStore } from './store.js';
import { embed } from '../ui/ui.js';

export function workspaceReport(store: Store, guildId: string): string {
    const ws = new WorkspaceStore(store);
    const counts = ws.counts(guildId);
    const refreshed = ws.lastRefresh(guildId);
    const reviewLoad = ws.workload(guildId).slice(0, 10).map(row => `<@${row.reviewer_id}>: ${row.n}`).join(' · ');
    const taskLoad = ws.taskWorkload(guildId).slice(0, 10).map(row => `<@${row.owner_id}>: ${row.n}`).join(' · ');
    return [`**Awaiting review:** ${counts.awaitingReview}`, `**Needs information:** ${counts.needsInformation}`, `**Reviews in progress:** ${counts.inProgress}`, `**Records needing correction:** ${counts.unresolvedRecords}`, `**Blocked tasks:** ${counts.blockedTasks}`, `**Overdue tasks:** ${counts.overdueTasks}`, `**Listed staff:** ${counts.listedStaff}`, `**Confirmed capacity:** ${counts.confirmedCapacity} · vacancies: ${counts.vacancies}`, `**Proposed capacity:** ${counts.proposedCapacity} · vacancies: ${counts.proposedVacancies}`, reviewLoad ? `**Review workload:** ${reviewLoad}` : '**Review workload:** none assigned', taskLoad ? `**Task workload:** ${taskLoad}` : '**Task workload:** none assigned', '', refreshed ? `Last Workspace refresh: <t:${Math.floor(refreshed / 1000)}:R>` : 'Last Workspace refresh: not available'].join('\n');
}

export function reportsPayload(store: Store, guildId: string, title = 'Workspace · Reports') {
    const cfg = activeWorkspaceConfig(store, guildId);
    return { embeds: [embed(title, workspaceReport(store, guildId), cfg?.branding.primaryColor ?? Colors.Blurple)], components: [], allowedMentions: { parse: [] as never[] } };
}

function localParts(now: number, timezone: string) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
    return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')), year: get('year'), month: get('month'), day: get('day'), hour: Number(get('hour')) % 24, minute: Number(get('minute')) };
}

export interface WorkspaceScheduleDeps { store: Store; client: Client; ready: (guildId: string) => boolean }

export async function runWorkspaceReminders(d: WorkspaceScheduleDeps, now = Date.now()) {
    for (const guild of d.client.guilds.cache.values()) {
        if (!d.ready(guild.id)) continue;
        await d.store.withAuthorized(guild.id, async () => {
            const cfg = activeWorkspaceConfig(d.store, guild.id);
            if (!cfg?.modules.reports || !cfg.reminders.enabled || !cfg.reminders.channelId) return;
            const local = localParts(now, cfg.reminders.timezone);
            if (local.weekday !== cfg.reminders.weekday || local.hour !== cfg.reminders.hour || Math.abs(local.minute - cfg.reminders.minute) > 4) return;
            const slot = `${local.year}-${local.month}-${local.day}`;
            const job = d.store.get('SELECT * FROM workspace_jobs WHERE guild_id=? AND kind=?', guild.id, 'reminder');
            if (job?.last_message_id === slot) return;
            const channel = await selectedChannel(guild, cfg.reminders.channelId, 'Reminder channel');
            const message = await channel.send({ embeds: [embed(`${cfg.branding.shortName} · Scheduled Workspace summary`, workspaceReport(d.store, guild.id), cfg.branding.primaryColor)], allowedMentions: { parse: [] } });
            d.store.run('INSERT INTO workspace_jobs(guild_id,kind,next_at,last_at,last_message_id) VALUES(?,?,?,?,?) ON CONFLICT(guild_id,kind) DO UPDATE SET last_at=excluded.last_at,last_message_id=excluded.last_message_id', guild.id, 'reminder', 0, now, slot);
            new WorkspaceStore(d.store).audit(guild.id, null, 'report/reminder-sent', message.id, `slot=${slot}`);
        }).catch(() => { /* one guild's Sheets/Discord failure must not stop other guilds */ });
    }
}
