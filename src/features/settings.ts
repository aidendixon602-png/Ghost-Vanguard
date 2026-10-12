import type { Store } from '../database/db.js';

/**
 * Small per-server settings store for the 2.18 features (automod, welcome, appeals, duty,
 * lockdown schedule, weekly report). Each feature keeps one JSON object; missing fields fall
 * back to the defaults passed in, so new options never need a migration.
 */
export function getFeature<T extends object>(store: Store, guild: string, key: string, defaults: T): T {
    const row = store.get('SELECT json FROM guild_features WHERE guild_id=? AND key=?', guild, key);
    if (!row) return { ...defaults };
    try { return { ...defaults, ...JSON.parse(String(row.json)) }; } catch { return { ...defaults }; }
}

export function setFeature<T extends object>(store: Store, guild: string, key: string, defaults: T, change: Partial<T>, by?: string): T {
    const before = getFeature(store, guild, key, defaults);
    const next = { ...before, ...change };
    store.run('INSERT INTO guild_features(guild_id,key,json) VALUES(?,?,?) ON CONFLICT(guild_id,key) DO UPDATE SET json=excluded.json', guild, key, JSON.stringify(next));
    if (by) store.history(guild, `feature/${key}`, before, next, by);
    return next;
}
