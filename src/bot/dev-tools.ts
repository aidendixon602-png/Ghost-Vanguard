import { Colors } from 'discord.js';
import type { Store } from '../database/db.js';
import type { LogQueue } from '../logging.js';
import { embed } from '../ui/ui.js';
import { eventLogConfig } from '../audit/event-log.js';
import { lockdownState } from '../security/lockdown.js';
// ---- Temporary custom bot status, kept in the database so it survives restarts ----

const OVERRIDE_KEY = 'presence_override';

export type PresenceMode = 'online' | 'idle' | 'dnd';

export interface PresenceOverride {
    text: string;
    mode: PresenceMode;
    until: number | null;
}

/** The active custom status, or null when the normal rotation should show. Expired ones are cleared. */
export function presenceOverride(store: Store, now = Date.now()): PresenceOverride | null {
    const raw = store.get('SELECT value FROM runtime_meta WHERE key=?', OVERRIDE_KEY)?.value;
    if (!raw)
        return null;
    try {
        const value = JSON.parse(raw) as PresenceOverride;
        if (value.until !== null && value.until <= now) {
            clearPresenceOverride(store);
            return null;
        }
        return value;
    } catch {
        clearPresenceOverride(store);
        return null;
    }
}

export function setPresenceOverride(store: Store, text: string, mode: PresenceMode, minutes: number | null, now = Date.now()): PresenceOverride {
    const value = { text, mode, until: minutes ? now + minutes * 60000 : null };
    store.run('INSERT INTO runtime_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', OVERRIDE_KEY, JSON.stringify(value));
    return value;
}

export function clearPresenceOverride(store: Store) {
    store.run('DELETE FROM runtime_meta WHERE key=?', OVERRIDE_KEY);
}
// ---- Broadcasts to every authorized server's log channel ----

/** Which servers would receive a broadcast: authorized with a log channel, versus authorized without one. */
export function broadcastTargets(store: Store, guildIds: string[]) {
    const authorized = guildIds.filter(id => store.isAuthorized(id));
    const withChannel = authorized.filter(id => store.readGuild(id, () => !!store.settings(id).logChannelId));
    return { deliver: withChannel, noChannel: authorized.filter(id => !withChannel.includes(id)) };
}

export async function broadcast(store: Store, logs: LogQueue, guildIds: string[], title: string, message: string, developerId: string) {
    const { deliver } = broadcastTargets(store, guildIds);
    const notice = embed(`📢 ${title}`, `${message}\n\n— Midtown Vanguard developers`, Colors.Blurple);
    let sent = 0;
    for (const id of deliver)
        await store.withAuthorized(id, async () => {
            logs.push(id, notice);
            sent++;
        }).catch(() => { });
    store.run('INSERT INTO runtime_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'last_broadcast', JSON.stringify({ at: Date.now(), by: developerId, servers: sent }));
    return sent;
}
// ---- Read-only overview of any server, for support ----

const when = (ms: number | null | undefined) => ms ? `<t:${Math.floor(ms / 1000)}:R>` : 'never';

export function inspectGuild(store: Store, guildId: string, name: string | null, members: number | null, now = Date.now()): string[] {
    const auth = store.authorization(guildId);
    const header = [`**Server:** ${name ?? 'Not in this server'} (${guildId})${members !== null ? ` · ${members.toLocaleString('en-US')} members` : ''}`,
        `**Authorization:** ${auth?.state ?? 'never seen'}${auth?.authorized_at ? ` · authorized ${when(auth.authorized_at)} by <@${auth.authorized_by}>` : ''}`];
    if (!store.isAuthorized(guildId))
        return [...header, 'Settings are only shown for authorized servers.'];
    return store.readGuild(guildId, () => {
        const s = store.settings(guildId);
        const count = (sql: string, ...args: (string | number)[]) => Number(store.get(sql, ...args)?.n ?? 0);
        const incidents = count('SELECT COUNT(*) AS n FROM incidents WHERE guild_id=? AND at>?', guildId, now - 7 * 86400000);
        const last = store.get('SELECT rule, at FROM incidents WHERE guild_id=? ORDER BY at DESC LIMIT 1', guildId);
        const lockdown = lockdownState(store, guildId);
        const logging = eventLogConfig(store, guildId);
        const snapshots = store.get('SELECT COUNT(*) AS n, MAX(at) AS latest FROM snapshots WHERE guild_id=?', guildId);
        return [
            ...header,
            `**Anti-nuke:** ${s.enabled ? `on · ${s.mode}` : 'off'} · ${Object.keys(s.rules ?? {}).length} custom limit(s) · bots ${store.kickBots(guildId) ? 'kicked' : 'stripped'}`,
            `**Log channel:** ${s.logChannelId ? 'set' : 'not set'} · **Event logging:** ${logging.enabled ? 'on' : 'off'}`,
            `**Lockdown:** ${lockdown ? `active since ${when(lockdown.started_at)} (${lockdown.channel_count} channels)` : 'none'}`,
            `**Incidents (7 days):** ${incidents}${last ? ` · last: ${last.rule} ${when(last.at)}` : ''}`,
            `**Trusted users:** ${count("SELECT COUNT(*) AS n FROM grants WHERE guild_id=? AND kind='trust' AND (expires IS NULL OR expires>?)", guildId, now)}`,
            `**Snapshots:** ${Number(snapshots?.n ?? 0)} · latest ${when(snapshots?.latest)}`,
        ];
    });
}
