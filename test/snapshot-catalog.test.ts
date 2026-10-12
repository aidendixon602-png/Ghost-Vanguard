import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/database/db.js';
import { Snapshots } from '../src/recovery/snapshots.js';
import { Registry } from '../src/bot/registry.js';
import { registerComponents } from '../src/ui/components.js';
import { snapshotPage, deletionReview } from '../src/ui/snapshot-ui.js';
import { authorize } from './helpers.js';

const user = '1277709272041394187';
const data = { version: 1, guildId: 'g', name: 'Guild', roles: [{ id: 'g', name: '@everyone', color: 0, hoist: false, mentionable: false, permissions: '0', position: 0, managed: false }], channels: [], unsupported: [], roleMap: {}, channelMap: {} };

function fixture() {
    const store = new Store(':memory:');
    authorize(store);
    authorize(store, 'other');
    const snapshots = new Snapshots(store, 0), confirmations = new Map(), events: any[] = [], replies: any[] = [];
    snapshots.onAudit = (guild, title, detail) => events.push({ guild, title, detail });
    const ctx: any = { store, snapshots, confirmations, logs: { push: () => {} } }, i: any = { guildId: 'g', user: { id: user }, editReply: async (r: any) => replies.push(r) };
    const insert = (guild = 'g', value: any = data) => Number(store.run('INSERT INTO snapshots(guild_id,by_id,at,json) VALUES(?,?,?,?)', guild, user, Date.now(), typeof value === 'string' ? value : JSON.stringify(value)).lastInsertRowid);
    return { store, snapshots, ctx, i, insert, events, replies };
}

test('catalog pagination reaches all 25 saved snapshots and never shows another guild', () => {
    const f = fixture();
    const ids = Array.from({ length: 25 }, () => f.insert());
    f.insert('other', { ...data, guildId: 'other' });
    const seen: number[] = [];
    for (let page = 1; page <= 4; page++) {
        const rows = f.snapshots.page('g', page);
        assert.equal(rows.total, 25);
        assert.equal(rows.pages, 4);
        seen.push(...rows.rows.map(r => r.id));
    }
    assert.deepEqual(seen, ids.reverse());
    assert.equal(f.snapshots.page('g', 1).rows[0]!.older, false);
    assert.equal(f.snapshots.page('g', 4).rows[0]!.older, true);
    assert.equal(f.snapshots.page('g', 999).page, 4);
    assert.throws(() => f.snapshots.page('g', 0));
    const payload = snapshotPage(f.ctx, 'g', user, 1);
    assert.equal(payload.components[0]!.toJSON().components[1]!.disabled, false);
    assert.match(payload.embeds[0]!.toJSON().description!, /25 saved recovery points/);
    assert.match(payload.embeds[0]!.toJSON().description!, /\*\*#25 · Snapshot\*\* · newest/);
    assert.equal(payload.components[0]!.toJSON().components[1]!.label, 'Older');
    f.store.close();
});

test('legacy/unreadable snapshots stay visible and can be explicitly deleted', async () => {
    const f = fixture();
    const id = f.insert('g', 'not valid JSON');
    const page = f.snapshots.page('g');
    assert.equal(page.rows[0]!.roles, null);
    const preview = f.snapshots.deletionPreview('g', id);
    await f.snapshots.delete('g', id, user, preview.digest);
    assert.equal(f.snapshots.page('g').total, 0);
    f.store.close();
});

test('snapshot deletion waits for explicit confirmation and preserves server mappings and audit history', async () => {
    const f = fixture();
    const id = f.insert();
    f.store.run('INSERT INTO snapshot_metadata(snapshot_id,guild_id,kind) VALUES(?,?,?)', id, 'g', 'backup');
    f.store.run('INSERT INTO recovery_mappings VALUES(?,?,?,?,?,?)', 'g', 'g', 'role', 'old', 'new', 0);
    await deletionReview(f.ctx, f.i, id);
    assert.equal(f.snapshots.page('g').total, 1);
    assert.equal(f.events.length, 0);
    const registry = new Registry();
    registerComponents(registry);
    const confirm = registry.components.find(c => c.prefix === 'snapshotdelete:')!;
    f.i.customId = f.replies[0].components[0].toJSON().components[0].custom_id;
    await confirm.execute(f.ctx, f.i);
    assert.equal(f.snapshots.page('g').total, 0);
    assert.equal(f.store.all('SELECT * FROM snapshot_metadata').length, 0);
    assert.equal(f.store.all('SELECT * FROM recovery_mappings').length, 1);
    assert.equal(f.store.all('SELECT * FROM recovery_events WHERE event=?', 'snapshot_deleted').length, 1);
    assert.equal(f.events[0].title, 'snapshot deleted');
    assert.equal(f.ctx.confirmations.size, 0);
    await assert.rejects(confirm.execute(f.ctx, f.i), /confirmation expired/);
    f.store.close();
});

test('deletion confirmation rejects another user, guild, expiry, and altered snapshots', async () => {
    const f = fixture(), id = f.insert();
    const registry = new Registry();
    registerComponents(registry);
    const confirm = registry.components.find(c => c.prefix === 'snapshotdelete:')!;
    await deletionReview(f.ctx, f.i, id);
    const key = [...f.ctx.confirmations.keys()][0];
    f.i.customId = `snapshotdelete:${key}`;
    await assert.rejects(confirm.execute(f.ctx, { ...f.i, user: { id: 'someone' } }), /another user\/server/);
    await assert.rejects(confirm.execute(f.ctx, { ...f.i, guildId: 'other' }), /another user\/server/);
    f.ctx.confirmations.get(key).expires = 0;
    await assert.rejects(confirm.execute(f.ctx, f.i), /confirmation expired/);
    const preview = f.snapshots.deletionPreview('g', id);
    f.store.run('UPDATE snapshots SET json=? WHERE id=?', JSON.stringify({ ...data, name: 'Changed' }), id);
    await assert.rejects(f.snapshots.delete('g', id, user, preview.digest), /changed after confirmation/);
    assert.equal(f.snapshots.page('g').total, 1);
    f.store.close();
});

test('deletion cannot cross guilds or overlap an active restore/copy', async () => {
    const f = fixture(), id = f.insert(), preview = f.snapshots.deletionPreview('g', id);
    assert.throws(() => f.snapshots.deletionPreview('other', id), /not found/);
    await assert.rejects(f.snapshots.delete('other', id, user, preview.digest), /not found/);
    let release!: () => void;
    const operation = f.snapshots.locks.run(['g'], () => new Promise<void>(resolve => {
        release = resolve;
    }));
    await assert.rejects(f.snapshots.delete('g', id, user, preview.digest), /already running/);
    assert.equal(f.snapshots.page('g').total, 1);
    release();
    await operation;
    f.store.close();
});

test('cancelling snapshot deletion changes nothing and cannot be used as a restore confirmation', async () => {
    const f = fixture(), id = f.insert();
    const registry = new Registry();
    registerComponents(registry);
    await deletionReview(f.ctx, f.i, id);
    const key = [...f.ctx.confirmations.keys()][0];
    await assert.rejects(registry.components.find(c => c.prefix === 'restore:')!.execute(f.ctx, { ...f.i, customId: `restore:${key}` }), /expired or belongs/);
    await registry.components.find(c => c.prefix === 'snapshotcancel:')!.execute(f.ctx, { ...f.i, customId: `snapshotcancel:${key}` });
    assert.equal(f.snapshots.page('g').total, 1);
    assert.equal(f.ctx.confirmations.size, 0);
    f.store.close();
});

test('snapshot/backup creation and failed restores have persistent actor-tagged audit events', async () => {
    const f = fixture();
    f.snapshots.capture = async () => structuredClone(data) as any;
    const backup = await f.snapshots.save({ id: 'g' } as any, user, 'backup');
    assert.equal(f.snapshots.page('g').rows[0]!.kind, 'backup');
    assert.equal(f.store.get('SELECT actor_id FROM recovery_events WHERE event=?', 'backup_created')!.actor_id, user);
    await assert.rejects(f.snapshots.restore({ id: 'g', roles: { cache: new Map() }, channels: { cache: new Map() } } as any, backup, false, 'bad', { actor: user }), /server changed/);
    assert.equal(f.store.get('SELECT actor_id FROM recovery_events WHERE event=?', 'restore_failed')!.actor_id, user);
    f.store.close();
});

test('numbers are per server, have no gaps from other servers, and restart at #1 when all are deleted', async () => {
    const f = fixture();
    const g1 = f.insert(), o1 = f.insert('other', { ...data, guildId: 'other' }), g2 = f.insert(), o2 = f.insert('other', { ...data, guildId: 'other' }), g3 = f.insert();
    assert.deepEqual([g1, g2, g3].map(id => f.snapshots.numberOf('g', id)), [1, 2, 3]);
    assert.deepEqual([o1, o2].map(id => f.snapshots.numberOf('other', id)), [1, 2]);
    assert.equal(f.snapshots.idFor('g', 2), g2);
    assert.throws(() => f.snapshots.idFor('g', 9), /#9 was not found/);
    // Deleting #1 keeps #2/#3 stable; the next is #4 (no renumbering of existing points).
    let preview = f.snapshots.deletionPreview('g', g1);
    await f.snapshots.delete('g', g1, user, preview.digest);
    assert.equal(f.snapshots.numberOf('g', f.insert()), 4);
    // Delete everything: numbering starts again at #1.
    const all = f.snapshots.resolveNumbers('g', 'all').map(n => f.snapshots.idFor('g', n));
    preview = f.snapshots.deletionPreview('g', all);
    await f.snapshots.delete('g', all, user, preview.digest);
    assert.equal(f.snapshots.page('g').total, 0);
    assert.equal(f.snapshots.numberOf('g', f.insert()), 1);
    assert.equal(f.snapshots.page('other').total, 2, 'other servers are untouched');
    f.store.close();
});

test('delete accepts single numbers, lists, ranges and all; rejects unknown or malformed input', () => {
    const f = fixture();
    for (let n = 0; n < 6; n++) f.insert();
    const backup = f.insert();
    f.store.run('INSERT INTO snapshot_metadata(snapshot_id,guild_id,kind) VALUES(?,?,?)', backup, 'g', 'backup');
    assert.deepEqual(f.snapshots.resolveNumbers('g', '3'), [3]);
    assert.deepEqual(f.snapshots.resolveNumbers('g', '#5, 2 ,3'), [2, 3, 5]);
    assert.deepEqual(f.snapshots.resolveNumbers('g', '2-4'), [2, 3, 4]);
    assert.deepEqual(f.snapshots.resolveNumbers('g', '5-50'), [5, 6, 7], 'ranges may extend past existing points');
    assert.deepEqual(f.snapshots.resolveNumbers('g', 'ALL'), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(f.snapshots.resolveNumbers('g', 'all', 'backups'), [7]);
    assert.throws(() => f.snapshots.resolveNumbers('g', '3', 'backups'), /as backups/);
    assert.throws(() => f.snapshots.resolveNumbers('g', '99'), /None of those/);
    assert.throws(() => f.snapshots.resolveNumbers('g', '2,99'), /Not found: #99/);
    assert.throws(() => f.snapshots.resolveNumbers('g', 'drop table'), /Use numbers like/);
    assert.throws(() => f.snapshots.resolveNumbers('g', '6-2'), /range/);
    f.store.close();
});

test('bulk delete needs one confirmation click and removes exactly the reviewed points', async () => {
    const f = fixture();
    const ids = Array.from({ length: 4 }, () => f.insert());
    await deletionReview(f.ctx, f.i, [ids[0]!, ids[2]!]);
    const embedJson = f.replies[0].embeds[0].toJSON();
    assert.match(embedJson.title, /Delete 2 recovery points/);
    assert.match(embedJson.description, /#1[\s\S]*#3/);
    assert.equal(f.snapshots.page('g').total, 4, 'nothing deleted before the click');
    const registry = new Registry();
    registerComponents(registry);
    f.i.customId = f.replies[0].components[0].toJSON().components[0].custom_id;
    await registry.components.find(c => c.prefix === 'snapshotdelete:')!.execute(f.ctx, f.i);
    assert.deepEqual(f.snapshots.page('g').rows.map(r => r.number), [4, 2]);
    f.store.close();
});

test('cleanup can remove anti-nuke baselines of any age, keeping none if asked', async () => {
    const { cleanupPlan } = await import('../src/recovery/cleanup.js');
    const f = fixture();
    const manual = f.insert(), b1 = f.insert(), b2 = f.insert();
    for (const id of [b1, b2]) f.store.run('INSERT INTO snapshot_metadata(snapshot_id,guild_id,kind,purpose) VALUES(?,?,?,?)', id, 'g', 'snapshot', 'baseline');
    assert.deepEqual(cleanupPlan(f.store, 'g', { olderThanDays: 0, type: 'baselines', keepLatest: 0 }).ids.sort(), [b1, b2].sort());
    assert.deepEqual(cleanupPlan(f.store, 'g', { olderThanDays: 0, type: 'baselines', keepLatest: 1 }).ids, [b1]);
    assert.deepEqual(cleanupPlan(f.store, 'g', { olderThanDays: 1, type: 'baselines', keepLatest: 0 }).ids, [], 'brand-new points are not older than a day');
    assert.equal(f.snapshots.page('g').rows.find(r => r.id === b2)!.label, 'Anti-nuke baseline');
    void manual;
    f.store.close();
});
