import { PermissionFlagsBits } from 'discord.js';
import { AppError } from '../errors.js';
import { COMPONENTS } from '../recovery/recovery.js';
import { addConfirmation, showLayoutReview } from './layout-ui.js';
import { defaults } from '../bot/registry.js';
/** Matches the window the incident alert reports deletions for. */
const DELETION_LOOKBACK_MS = 10 * 60 * 1000;
/**
 * Work out how to restore what an incident's actor deleted: which components to
 * select, and which snapshots (newest first) were taken before the first deletion.
 * Layout-copy templates hold another server's layout, so they are never candidates.
 */
export function incidentRestorePlan(store, guildId, incidentId) {
    const incident = store.get('SELECT * FROM incidents WHERE guild_id=? AND id=?', guildId, incidentId);
    if (!incident)
        throw new AppError('VALIDATION_ERROR', 'That incident no longer exists.');
    const deletions = store.all("SELECT rule, MIN(at) AS first, COUNT(*) AS n FROM observations WHERE guild_id=? AND actor_id=? AND rule IN ('channel_delete','role_delete') AND at>=? GROUP BY rule", guildId, incident.actor_id, Number(incident.at) - DELETION_LOOKBACK_MS);
    if (!deletions.length)
        throw new AppError('VALIDATION_ERROR', 'No channel or role deletions are recorded for this incident.');
    const first = Math.min(...deletions.map(d => Number(d.first)));
    const count = (rule) => Number(deletions.find(d => d.rule === rule)?.n ?? 0);
    const wanted = new Set(['permissions']);
    if (count('role_delete'))
        wanted.add('roles');
    if (count('channel_delete')) {
        wanted.add('categories');
        wanted.add('channels');
    }
    const candidates = store.all("SELECT s.id FROM snapshots s LEFT JOIN snapshot_metadata m ON m.snapshot_id=s.id WHERE s.guild_id=? AND s.at<? AND COALESCE(m.kind,'snapshot')<>'copy' ORDER BY s.at DESC, s.id DESC LIMIT 10", guildId, first).map(r => Number(r.id));
    return { channels: count('channel_delete'), roles: count('role_delete'), components: COMPONENTS.filter(c => wanted.has(c)), candidates };
}
export function registerIncidentControls(registry) {
    registry.component({ prefix: 'incident:restore:', kinds: ['button'], metadata: { ...defaults, category: 'security', access: 'security', botPermissions: [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels] },
        execute: async (ctx, i) => {
            const id = Number(/^incident:restore:(\d{1,12})$/.exec(i.customId)?.[1]);
            if (!id)
                throw new AppError('VALIDATION_ERROR', 'Invalid incident control.');
            const plan = incidentRestorePlan(ctx.store, i.guildId, id);
            // Use the newest snapshot from before the deletions that still loads cleanly.
            const snapshot = plan.candidates.find(candidate => {
                try {
                    ctx.snapshots.load(i.guildId, candidate);
                    return true;
                }
                catch {
                    return false;
                }
            });
            if (!snapshot)
                throw new AppError('VALIDATION_ERROR', 'No usable snapshot was taken before these deletions, so there is nothing to restore from. Keep a recent baseline with /recovery snapshot create or scheduled backups.');
            const key = addConfirmation(ctx, { guild: i.guildId, user: i.user.id, snapshot, prune: false, fingerprint: '', components: plan.components });
            await showLayoutReview(ctx, i, key, ctx.confirmations.get(key));
        } });
}
