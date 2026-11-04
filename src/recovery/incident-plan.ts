import type { Store } from '../database/db.js';
import { AppError } from '../errors.js';
import { COMPONENTS, type Component } from './recovery.js';

/** How far back an incident looks for channels and roles its actor deleted. Matches the window the alert reports. */
export const DELETION_LOOKBACK_MS = 10 * 60 * 1000;

/**
 * Work out how to put back what an incident's actor deleted: which components to select, which
 * snapshots (newest first) were taken before the first deletion, and the IDs that were deleted.
 * Layout-copy templates hold another server's layout, so they are never candidates.
 */
export function incidentRestorePlan(store: Store, guildId: string, incidentId: number) {
    const incident = store.get('SELECT * FROM incidents WHERE guild_id=? AND id=?', guildId, incidentId);
    if (!incident)
        throw new AppError('VALIDATION_ERROR', 'That incident no longer exists.');
    const since = Number(incident.at) - DELETION_LOOKBACK_MS;
    const deletions = store.all("SELECT rule, MIN(at) AS first, COUNT(*) AS n FROM observations WHERE guild_id=? AND actor_id=? AND rule IN ('channel_delete','role_delete') AND at>=? GROUP BY rule", guildId, incident.actor_id, since);
    if (!deletions.length)
        throw new AppError('VALIDATION_ERROR', 'No channel or role deletions are recorded for this incident.');
    const first = Math.min(...deletions.map(d => Number(d.first)));
    const count = (rule: string) => Number(deletions.find(d => d.rule === rule)?.n ?? 0);
    const wanted = new Set<Component>(['permissions']);
    if (count('role_delete'))
        wanted.add('roles');
    if (count('channel_delete')) {
        wanted.add('categories');
        wanted.add('channels');
    }
    const candidates = store.all("SELECT s.id FROM snapshots s LEFT JOIN snapshot_metadata m ON m.snapshot_id=s.id WHERE s.guild_id=? AND s.at<? AND COALESCE(m.kind,'snapshot')<>'copy' ORDER BY s.at DESC, s.id DESC LIMIT 10", guildId, first).map(r => Number(r.id));
    const ids = store.all("SELECT DISTINCT rule, target_id FROM observations WHERE guild_id=? AND actor_id=? AND rule IN ('channel_delete','role_delete') AND at>=? AND target_id IS NOT NULL", guildId, incident.actor_id, since);
    const deleted = {
        channels: ids.filter(r => r.rule === 'channel_delete').map(r => String(r.target_id)),
        roles: ids.filter(r => r.rule === 'role_delete').map(r => String(r.target_id)),
    };
    return { channels: count('channel_delete'), roles: count('role_delete'), components: COMPONENTS.filter(c => wanted.has(c)), candidates, first, deleted };
}
