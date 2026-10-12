import type { Guild } from 'discord.js';
import type { Store } from '../database/db.js';
import type { Security } from './security.js';
import { logEvent } from '../errors.js';

/** A quarantine record outlives guild membership. Confirmed absence is not a startup failure. */
export async function reconcileStartupMembers(store: Store, security: Pick<Security, 'reconcile'>, guild: Guild,
    report: typeof logEvent = logEvent) {
    let reconciled = 0, absent = 0;
    for (const row of store.all('SELECT user_id FROM backups WHERE guild_id=? AND active=1', guild.id)) {
        store.assertAuthorized(guild.id);
        try {
            const member = await guild.members.fetch({ user: row.user_id, force: true });
            store.assertAuthorized(guild.id);
            await security.reconcile(member);
            reconciled++;
        } catch (error) {
            store.assertAuthorized(guild.id);
            if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 10007) throw error;
            absent++;
            report('quarantine_member_absent', { guildId: guild.id, userId: row.user_id, reason: 'Member no longer in this server; saved quarantine retained for rejoin.' });
        }
    }
    return { reconciled, absent };
}
