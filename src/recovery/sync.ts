import type { EmbedBuilder, Guild } from 'discord.js';
import { Colors } from 'discord.js';
import type { Store } from '../database/db.js';
import { failure, logEvent } from '../errors.js';
import { plusConfig } from '../features/plus-settings.js';
import { lockdownState } from '../security/lockdown.js';
import { raidState } from '../security/raidmode.js';
import { embed } from '../ui/ui.js';
import { backupsDisabled } from './recovery.js';
import { layoutHash, type Snapshot, type Snapshots } from './snapshots.js';

/**
 * Keeps a recent backup of each server's roles and channels, so there is always something close to the
 * server as it is now to put deleted channels back from.
 *
 * Every few minutes the layout in memory is compared with the newest backup. When it differs and has stayed
 * the same across two looks, a "synced" backup is saved. Nothing is forced onto the server: a backup only
 * follows the server, it never changes it. A burst of edits makes one backup, and a server that is under
 * attack, locked down or in raid mode is never saved, so the backups from before the trouble stay put.
 */

/** How often each server's layout is compared with its newest backup. */
export const SYNC_EVERY_MS = 5 * 60_000;
/** At most one synced backup per server in this time, however much it changes. */
export const SYNC_MIN_GAP_MS = 15 * 60_000;
/** Synced backups kept per server. Older ones are deleted; manual, scheduled and baseline backups never are. */
export const SYNC_KEEP = 5;
/** After an anti-nuke incident nothing is synced for this long. */
export const CALM_MS = 60 * 60_000;
/** Losing at least this many channels (or roles), and this share of them, since the newest backup pauses the sync. */
export const SHRINK_COUNT = 8;
export const SHRINK_SHARE = 1 / 3;

export type SyncStatus = 'off' | 'busy' | 'not-calm' | 'unchanged' | 'waiting' | 'paused' | 'saved';

export interface SyncDeps {
    store: Store;
    snapshots: Snapshots;
    /** Posts a card to the server's security log (and its anti-nuke log). */
    post: (guildId: string, card: EmbedBuilder) => void;
    now?: () => number;
}

interface State { nextAt: number; pending?: string; lastSavedAt?: number; noted?: string }

/** A stable spread over the interval, so every server is not looked at in the same second after a restart. */
export const spread = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % SYNC_EVERY_MS;

const lost = (before: number, now: number) => before - now >= SHRINK_COUNT && (before - now) / before >= SHRINK_SHARE;

export class LayoutSync {
    private states = new Map<string, State>();
    private now: () => number;

    constructor(private d: SyncDeps) {
        this.now = d.now ?? Date.now;
    }

    forget(guildId: string) {
        this.states.delete(guildId);
    }

    private state(guildId: string, now: number): State {
        let st = this.states.get(guildId);
        if (!st)
            this.states.set(guildId, st = { nextAt: now + spread(guildId) });
        return st;
    }

    /** Called every minute: looks at the servers whose turn it is. */
    async tick(guilds: Iterable<Guild>, ready: (id: string) => boolean, now = this.now()) {
        for (const guild of guilds) {
            if (!ready(guild.id))
                continue;
            const st = this.state(guild.id, now);
            if (now < st.nextAt)
                continue;
            st.nextAt = now + SYNC_EVERY_MS;
            await this.d.store.withAuthorized(guild.id, () => this.check(guild, now)).catch(error => logEvent('layout_sync_failure', { guildId: guild.id, ...failure(error) }));
        }
    }

    /** Nothing that looks like trouble has happened lately. A backup saved mid-attack would push out the good ones. */
    private calm(guildId: string, now: number): boolean {
        const { store } = this.d;
        if (raidState(store, guildId, now).enabled || lockdownState(store, guildId))
            return false;
        if (store.get("SELECT 1 FROM incidents WHERE guild_id=? AND at>? AND mode<>'exempt' LIMIT 1", guildId, now - CALM_MS))
            return false;
        const gone = Number(store.get("SELECT COUNT(*) AS n FROM observations WHERE guild_id=? AND rule IN ('channel_delete','role_delete') AND at>?", guildId, now - 10 * 60_000)?.n ?? 0);
        return gone < 3;
    }

    private newest(guildId: string): { id: number; at: number; data: Snapshot } | null {
        // Layout-copy templates hold another server's layout, so they never count.
        const row = this.d.store.get("SELECT s.id, s.at, s.json FROM snapshots s LEFT JOIN snapshot_metadata m ON m.snapshot_id=s.id WHERE s.guild_id=? AND COALESCE(m.kind,'snapshot')<>'copy' ORDER BY s.id DESC LIMIT 1", guildId);
        if (!row)
            return null;
        try { return { id: Number(row.id), at: Number(row.at), data: JSON.parse(String(row.json)) as Snapshot }; } catch { return null; }
    }

    private prune(guild: Guild) {
        const { store, snapshots } = this.d;
        const stale = store.all("SELECT s.id FROM snapshots s JOIN snapshot_metadata m ON m.snapshot_id=s.id WHERE s.guild_id=? AND m.purpose='synced' ORDER BY s.id DESC LIMIT -1 OFFSET ?", guild.id, SYNC_KEEP);
        for (const row of stale) {
            store.run('DELETE FROM snapshots WHERE guild_id=? AND id=?', guild.id, row.id);
            snapshots.audit(guild.id, guild.client.user?.id ?? 'vanguard', 'synced_snapshot_expired', Number(row.id), `Synced backup retention keeps the newest ${SYNC_KEEP}; manual, scheduled and baseline backups are kept.`, true);
        }
    }

    /** Compare one server with its newest backup and save a synced one if it has moved on. */
    async check(guild: Guild, now = this.now()): Promise<SyncStatus> {
        const { store, snapshots } = this.d;
        const s = store.settings(guild.id);
        if (!s.authorized || !s.enabled || plusConfig(store, guild.id).backupSync === false || backupsDisabled(store, guild.id))
            return 'off';
        if (snapshots.locks.busy(guild.id))
            return 'busy';
        const st = this.state(guild.id, now);
        if (!this.calm(guild.id, now)) {
            st.pending = undefined;
            return 'not-calm';
        }
        const live = await snapshots.capture(guild, { cached: true }), hash = layoutHash(live), last = this.newest(guild.id);
        if (last && layoutHash(last.data) === hash) {
            st.pending = undefined;
            return 'unchanged';
        }
        // The layout has to be the same on two looks in a row: a burst of edits is one change, saved once it settles.
        if (st.pending !== hash) {
            st.pending = hash;
            return 'waiting';
        }
        const lastSynced = Number(store.get("SELECT MAX(s.at) AS at FROM snapshots s JOIN snapshot_metadata m ON m.snapshot_id=s.id WHERE s.guild_id=? AND m.purpose='synced'", guild.id)?.at ?? 0);
        if (now - Math.max(lastSynced, st.lastSavedAt ?? 0) < SYNC_MIN_GAP_MS)
            return 'waiting';
        // Much less than the newest backup holds: either a clean-up someone meant, or damage nobody has noticed yet.
        // Either way the backup is worth more than a copy of the smaller server, so keep it and say so once.
        if (last && (lost(last.data.channels.length, live.channels.length) || lost(last.data.roles.length, live.roles.length))) {
            if (st.noted !== hash) {
                st.noted = hash;
                const channels = last.data.channels.length - live.channels.length, roles = last.data.roles.length - live.roles.length;
                const fewer = [channels > 0 && `${channels} fewer channel${channels === 1 ? '' : 's'}`, roles > 0 && `${roles} fewer role${roles === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
                this.d.post(guild.id, embed('Backup sync paused', [
                    `The server has ${fewer} than backup #${snapshots.numberOf(guild.id, last.id)}, so Vanguard is not saving this layout over it.`,
                    'If you meant to remove them, save a new backup with `/recovery backup create` and syncing carries on. If you did not, review a restore with `/recovery backup restore`.',
                ].join('\n'), Colors.Orange));
            }
            return 'paused';
        }
        await snapshots.locks.run([guild.id], () => snapshots.save(guild, guild.client.user?.id ?? 'vanguard', 'backup', 'synced'));
        st.pending = undefined;
        st.lastSavedAt = now;
        this.prune(guild);
        logEvent('layout_sync', { guildId: guild.id });
        return 'saved';
    }
}
