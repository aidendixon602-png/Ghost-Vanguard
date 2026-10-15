import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/database/db.js';
import { authorize } from './helpers.js';
import { Roblox } from '../src/integrations/roblox.js';
import { sweepTempbans } from '../src/security/raidmode.js';

function setup() {
    const store = new Store(':memory:');
    for (const id of ['inactive', 'active']) { authorize(store, id); store.save(store.settings(id)); }
    store.run("UPDATE guild_authorization SET state='DEAUTHORIZED' WHERE guild_id='inactive'");
    return store;
}

test('expired bans from inactive guilds cannot starve due unbans in an active guild', async () => {
    const store = setup(), removed: string[] = [];
    try {
        for (let n = 0; n < 50; n++) store.run('INSERT INTO tempbans VALUES(?,?,?,?,?,?)', 'inactive', `old${n}`, n, 'mod', 'old', 1);
        store.run('INSERT INTO tempbans VALUES(?,?,?,?,?,?)', 'active', 'due', 100, 'mod', 'due', 1);
        const guild: any = { id: 'active', bans: { remove: async (id: string) => { removed.push(id); } } };
        await sweepTempbans(store, { push: () => {} } as any, { guilds: { cache: new Map([['active', guild]]) }, user: { id: 'bot' } } as any, () => true, Date.now());
        assert.deepEqual(removed, ['due']);
        assert.equal(store.get('SELECT COUNT(*) AS n FROM tempbans WHERE guild_id=?', 'inactive')!.n, 50);
    } finally { store.close(); }
});

test('stale links in inactive guilds cannot starve verification refresh for active guilds', async () => {
    const store = setup(), refreshed: string[] = [];
    try {
        for (let n = 0; n < 10; n++) store.run('INSERT INTO links VALUES(?,?,?,?,?)', 'inactive', `old${n}`, '123', 'old', n);
        store.run('INSERT INTO links VALUES(?,?,?,?,?)', 'active', 'due', '123', 'current', 100);
        const guild: any = { id: 'active', members: { fetch: async () => ({ id: 'due', guild }) } };
        const roblox = new Roblox(store, { push: () => {} } as any);
        roblox.sync = async member => { refreshed.push(member.id); return 'synced'; };
        await roblox.refresh({ guilds: { cache: new Map([['active', guild]]) } } as any);
        assert.deepEqual(refreshed, ['due']);
        assert.equal(store.get('SELECT COUNT(*) AS n FROM links WHERE guild_id=?', 'inactive')!.n, 10);
    } finally { store.close(); }
});
