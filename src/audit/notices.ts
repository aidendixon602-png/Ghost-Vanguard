import type { Store } from '../database/db.js';

/**
 * Startup notices (back online, saved protection, scam protection ready) are posted only when
 * there is something new to say, so log channels are not filled on every restart.
 *
 * The last posted state is remembered per server in runtime_meta, which survives restarts.
 */

/** A restart shorter than this is "quick": nothing is posted unless something changed. */
export const QUIET_RESTART_MS = 15 * 60000;

/**
 * Should this notice be posted? Remembers the new state either way.
 *  - force: post regardless (first start, real outage).
 *  - quietIfNew: when nothing was remembered yet, just remember it (used on quick restarts, so
 *    servers set up before this feature do not get one more round of notices).
 */
export function shouldPost(store: Store, guildId: string, kind: string, state: string, opts: { quietIfNew: boolean; force?: boolean }): boolean {
    const key = `notice:${kind}:${guildId}`;
    const previous = store.get('SELECT value FROM runtime_meta WHERE key=?', key)?.value as string | undefined;
    const changed = previous !== state;
    const post = !!opts.force || changed && !(previous === undefined && opts.quietIfNew);
    if (changed)
        store.run('INSERT INTO runtime_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, state);
    return post;
}
