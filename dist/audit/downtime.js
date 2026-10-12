import { logEvent } from '../errors.js';
import { readiness } from '../security/readiness.js';
import { Colors, PermissionFlagsBits } from 'discord.js';
import { overrideRule, ruleFor, RULES } from '../core.js';
import { responsibleActor } from '../security/security.js';
import { embed } from '../ui/ui.js';
import { describeAudit, eventLogConfig, recordEvent } from './event-log.js';
import { QUIET_RESTART_MS, shouldPost } from './notices.js';
// When the bot was last known to be running, updated every minute and on shutdown.
const LAST_SEEN = 'last_seen';
export function lastSeen(store) {
    const value = Number(store.get('SELECT value FROM runtime_meta WHERE key=?', LAST_SEEN)?.value);
    return Number.isFinite(value) && value > 0 ? value : null;
}
export function markSeen(store, now = Date.now()) {
    store.run('INSERT INTO runtime_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', LAST_SEEN, String(now));
}
export function formatDuration(ms) {
    if (ms < 60000)
        return 'less than a minute';
    const minutes = Math.round(ms / 60000);
    if (minutes < 90)
        return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    const hours = Math.round(minutes / 60);
    if (hours < 48)
        return `${hours} hours`;
    return `${Math.round(hours / 24)} days`;
}
/** The "back online" notice: proof that this server's settings were restored after a restart. */
export function restartNotice(store, settings, offlineSince, now = Date.now()) {
    const customized = Object.keys(settings.rules ?? {}).length;
    const trusted = Number(store.get("SELECT COUNT(*) AS n FROM grants WHERE guild_id=? AND kind='trust' AND (expires IS NULL OR expires>?)", settings.guildId, now)?.n ?? 0);
    const logging = eventLogConfig(store, settings.guildId);
    return [
        offlineSince ? `Offline for about ${formatDuration(now - offlineSince)} (last seen <t:${Math.floor(offlineSince / 1000)}:t>).` : 'Started for the first time with this database.',
        `**Anti-nuke:** ${settings.enabled ? `on · ${settings.mode} mode` : 'off'}`,
        `**Rules:** ${RULES.length}${customized ? ` (${customized} with custom limits)` : ''}${settings.ruleDefaults ? ' · shared "All" limit set' : ''}`,
        `**Trusted users:** ${trusted}`,
        `**Event logging:** ${logging.enabled ? `on${logging.channelId ? ` in <#${logging.channelId}>` : ''}` : 'off · turn on with /setup logs enable'}`,
        'All settings were restored from the database. Nothing needs to be set up again.',
    ];
}
/** Group audit entries from the offline period by who did what, flagging anything above a rule's limit. */
export function summarizeMissed(entries, guild, settings, trusted) {
    const groups = new Map();
    for (const entry of entries) {
        const rule = ruleFor(entry.action);
        const actor = responsibleActor(entry, guild);
        if (!rule || !actor || trusted(actor) || overrideRule(rule, settings.rules, settings.ruleDefaults).enabled === false)
            continue;
        const key = `${actor}:${rule.key}`;
        const group = groups.get(key) ?? { actor, title: rule.title, count: 0, limit: overrideRule(rule, settings.rules, settings.ruleDefaults).count };
        group.count++;
        groups.set(key, group);
    }
    const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
    const flagged = sorted.filter(g => g.count >= g.limit).length;
    const lines = sorted.slice(0, 10).map(g => `<@${g.actor}> · ${g.count}× ${g.title}${g.count >= g.limit ? ' · ⚠️ at or above the anti-nuke limit' : ''}`);
    return { lines, flagged, actions: sorted.reduce((n, g) => n + g.count, 0) };
}
/**
 * After a restart: post the restored-settings notice, add anything that happened while the
 * bot was offline to the event log, and report destructive actions anti-nuke could not see.
 * The caller runs this inside the guild's authorized context.
 */
export async function catchUp(guild, store, logs, trusted, offlineSince, now = Date.now()) {
    const settings = store.settings(guild.id);
    // A quick restart with nothing changed stays quiet; a first start or a real outage is announced.
    const quick = !!offlineSince && now - offlineSince < QUIET_RESTART_MS;
    const notice = restartNotice(store, settings, offlineSince, now);
    if (shouldPost(store, guild.id, 'restart', JSON.stringify(notice.slice(1)), { quietIfNew: quick, force: !quick }))
        logs.push(guild.id, embed('🟢 Midtown Vanguard is back online', notice.join('\n'), Colors.Green));
    if (settings.enabled) {
        const ready = readiness(guild, settings.logChannelId, store);
        logEvent('protection_startup', { guildId: guild.id, mode: settings.mode, missingPermissions: ready.missing, hierarchyWarnings: ready.above });
        const disabled = Object.values(settings.rules).filter(r => r.enabled === false).length;
        if (shouldPost(store, guild.id, 'protection', JSON.stringify([settings.mode, disabled, ready.missing, ready.above]), { quietIfNew: quick }))
            logs.push(guild.id, embed('Saved protection loaded', `${Object.values(settings.rules).filter(r => r.enabled === false).length} rules disabled · mode: ${settings.mode}\n${ready.text}`, ready.missing.length || ready.above.length ? Colors.Orange : Colors.Green));
    }
    if (!offlineSince || guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog) === false)
        return;
    const fetched = await guild.fetchAuditLogs({ limit: 100 }).catch(() => null);
    const missed = fetched ? [...fetched.entries.values()].filter(e => e.createdTimestamp > offlineSince && e.createdTimestamp <= now).reverse() : [];
    for (const entry of missed) {
        const event = describeAudit(entry, guild);
        if (event)
            recordEvent(store, logs, guild.id, event);
    }
    const summary = summarizeMissed(missed, guild, settings, trusted);
    if (!summary.lines.length)
        return;
    const title = summary.flagged ? '⚠️ Possible incident while Vanguard was offline' : 'Activity while Vanguard was offline';
    const intro = `Discord's audit log recorded ${summary.actions} protected action(s) between <t:${Math.floor(offlineSince / 1000)}:t> and <t:${Math.floor(now / 1000)}:t>. Anti-nuke could not respond to these live.`;
    const advice = summary.flagged ? '\nReview them now. Use `/security quarantine` on the actor and `/recovery snapshot restore` to repair damage if needed.' : '';
    logs.push(guild.id, embed(title, `${intro}\n\n${summary.lines.join('\n')}${advice}`, summary.flagged ? Colors.Red : Colors.Orange));
}
