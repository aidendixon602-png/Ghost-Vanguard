export const CLEANUP_TYPES = ['all', 'snapshots', 'baselines', 'backups', 'scheduled', 'rollback', 'copies'];
export const CLEANUP_LABELS = {
    all: 'All recovery points',
    snapshots: 'Manual snapshots (/recovery snapshot create)',
    baselines: 'Anti-nuke baselines (taken when protection turns on)',
    backups: 'Manual backups (/recovery backup create)',
    scheduled: 'Scheduled backups',
    rollback: 'Automatic backups taken before restores',
    copies: 'Layout-copy templates (/recovery copylayout)',
};
function matches(type, row) {
    switch (type) {
        case 'all': return true;
        case 'snapshots': return row.kind === 'snapshot' && row.purpose === 'manual';
        case 'baselines': return row.purpose === 'baseline';
        case 'backups': return row.kind === 'backup' && row.purpose === 'manual';
        case 'scheduled': return row.purpose === 'scheduled';
        case 'rollback': return row.purpose === 'rollback';
        case 'copies': return row.kind === 'copy';
    }
}
/**
 * Which recovery points a cleanup would delete: those of the chosen type older than the
 * cutoff, always sparing the newest `keepLatest` of that type. Older snapshots without
 * metadata count as manual snapshots.
 */
export function cleanupPlan(store, guildId, options, now = Date.now()) {
    const rows = store.all("SELECT s.id, s.at, COALESCE(m.kind,'snapshot') AS kind, COALESCE(m.purpose,'manual') AS purpose FROM snapshots s LEFT JOIN snapshot_metadata m ON m.snapshot_id=s.id WHERE s.guild_id=? ORDER BY s.at DESC, s.id DESC", guildId)
        .map(r => ({ id: Number(r.id), at: Number(r.at), kind: String(r.kind), purpose: String(r.purpose) }));
    const matching = rows.filter(r => matches(options.type, r));
    const kept = new Set(matching.slice(0, Math.max(0, options.keepLatest)).map(r => r.id));
    const cutoff = now - options.olderThanDays * 86400000;
    const doomed = matching.filter(r => !kept.has(r.id) && (options.olderThanDays === 0 || r.at < cutoff));
    return { ids: doomed.map(r => r.id), total: rows.length, matching: matching.length, kept: kept.size, oldest: doomed.at(-1)?.at ?? null, newest: doomed[0]?.at ?? null };
}
/** Delete what `cleanupPlan` selects, worked out again under the recovery lock so a restore can't be running. */
export async function cleanupSnapshots(snapshots, store, guildId, options, actor) {
    return snapshots.locks.run([guildId], async () => {
        const plan = cleanupPlan(store, guildId, options);
        store.transaction(() => {
            for (const id of plan.ids) {
                store.run('DELETE FROM snapshots WHERE guild_id=? AND id=?', guildId, id);
                snapshots.audit(guildId, actor, 'snapshot_deleted', id, `Deleted by /recovery snapshot cleanup (${options.type}, older than ${options.olderThanDays} days). Server objects and mappings were preserved.`);
            }
        });
        return plan;
    });
}
