import type { Store } from '../src/database/db.js';

export function authorize(store: Store, guild = 'g') {
    store.run("INSERT OR REPLACE INTO guild_authorization(guild_id,name,state,joined_at,authorized_at,authorized_by) VALUES(?,?,'AUTHORIZED',?,?,?)", guild, 'Test server', Date.now(), Date.now(), '1277709272041394187');
}
