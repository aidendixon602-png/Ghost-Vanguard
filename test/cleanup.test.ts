import { authorize } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/database/db.js';
import { Snapshots } from '../src/recovery/snapshots.js';
import { cleanupPlan, cleanupSnapshots } from '../src/recovery/cleanup.js';

const DAY = 86400000;

function setup() {
    const store = new Store(':memory:');
    authorize(store);
    const s = store.settings('g');
    s.authorized = true;
    store.save(s);
    const now = Date.now();
    const add = (daysAgo: number, kind?: string, purpose?: string) => {
        const id = Number(store.run('INSERT INTO snapshots(guild_id,by_id,at,json) VALUES(?,?,?,?)', 'g', 'owner', now - daysAgo * DAY, '{}').lastInsertRowid);
        if (kind)
            store.run('INSERT INTO snapshot_metadata(snapshot_id,guild_id,kind,source_guild,purpose) VALUES(?,?,?,?,?)', id, 'g', kind, kind === 'copy' ? 'other' : null, purpose ?? 'manual');
        return id;
    };
    const ids = {
        legacy: add(90),
        oldSnapshot: add(60, 'snapshot'),
        oldBackup: add(50, 'backup'),
        oldScheduled: add(40, 'backup', 'scheduled'),
        oldRollback: add(35, 'backup', 'rollback'),
        oldCopy: add(30, 'copy'),
        recentSnapshot: add(2, 'snapshot'),
        recentScheduled: add(1, 'backup', 'scheduled'),
    };
    return { store, snapshots: new Snapshots(store, 0), ids, now };
}

test('cleanup selects by type and age, and always keeps the newest matching points', () => {
    const { store, ids, now } = setup();
    const plan = (type: any, olderThanDays = 7, keepLatest = 1) => cleanupPlan(store, 'g', { type, olderThanDays, keepLatest }, now).ids.sort((a, b) => a - b);
    assert.deepEqual(plan('all'), [ids.legacy, ids.oldSnapshot, ids.oldBackup, ids.oldScheduled, ids.oldRollback, ids.oldCopy].sort((a, b) => a - b));
    assert.deepEqual(plan('snapshots'), [ids.legacy, ids.oldSnapshot].sort((a, b) => a - b), 'snapshots without metadata count as manual snapshots');
    assert.deepEqual(plan('backups'), [], 'the only manual backup is also the newest one, so it is kept');
    assert.deepEqual(plan('scheduled'), [ids.oldScheduled]);
    assert.deepEqual(plan('rollback'), [], 'a single rollback backup is kept as the newest');
    assert.deepEqual(plan('rollback', 7, 1).length, 0);
    assert.deepEqual(plan('copies'), []);
    assert.deepEqual(plan('all', 45), [ids.legacy, ids.oldSnapshot, ids.oldBackup].sort((a, b) => a - b), 'only points older than the cutoff');
    assert.equal(plan('all', 1, 7).length, 1, 'keep_latest spares the newest seven of eight');
    store.close();
});

test('even an old point is kept when it is the newest of its type', () => {
    const store = new Store(':memory:');
    authorize(store);
    store.run('INSERT INTO snapshots(guild_id,by_id,at,json) VALUES(?,?,?,?)', 'g', 'owner', Date.now() - 400 * DAY, '{}');
    assert.equal(cleanupPlan(store, 'g', { type: 'all', olderThanDays: 1, keepLatest: 1 }).ids.length, 0, 'a server is never left without a recovery point');
    store.close();
});

test('cleanup deletes exactly the planned points, audits each one, and waits for no restore', async () => {
    const { store, snapshots, ids } = setup();
    const options = { type: 'all' as const, olderThanDays: 7, keepLatest: 1 };
    const expected = cleanupPlan(store, 'g', options).ids;
    const done = await cleanupSnapshots(snapshots, store, 'g', options, 'admin');
    assert.deepEqual(done.ids, expected);
    const left = store.all('SELECT id FROM snapshots WHERE guild_id=? ORDER BY id', 'g').map(r => Number(r.id));
    assert.deepEqual(left, [ids.recentSnapshot, ids.recentScheduled]);
    assert.equal(store.all("SELECT * FROM recovery_events WHERE guild_id=? AND event='snapshot_deleted'", 'g').length, expected.length);
    await snapshots.locks.run(['g'], async () => {
        await assert.rejects(cleanupSnapshots(snapshots, store, 'g', options, 'admin'), /already|progress|busy|running/i, 'refused while a restore holds the lock');
    });
    store.close();
});
