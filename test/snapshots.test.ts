import { authorize } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionsBitField } from 'discord.js';
import { Store } from '../src/database/db.js';
import { Snapshots, type Snapshot } from '../src/recovery/snapshots.js';

function fixture() {
    const store = new Store(':memory:'), service = new Snapshots(store, 0), calls: string[] = [];
    authorize(store);
    const data: Snapshot = { version: 1, guildId: 'g', name: 'Guild', roles: [{ id: 'g', name: '@everyone', color: 0, hoist: false, mentionable: false, permissions: '0', position: 0, managed: false }], channels: [], unsupported: [], roleMap: {}, channelMap: {} };
    const guild: any = { id: 'g', name: 'Guild', members: { fetchMe: async () => ({ roles: { highest: { comparePositionTo: () => 1, position: 10 }, cache: new Map() } }) },
        roles: { cache: new Collection([['g', { ...data.roles[0], rawPosition: 0, permissions: new PermissionsBitField(0n), editable: true, edit: async () => calls.push('edit') }]]), setPositions: async () => calls.push('rolepositions') },
        channels: { cache: new Collection(), setPositions: async () => calls.push('channelpositions') } };
    service.capture = async () => structuredClone(data);
    store.run('INSERT INTO snapshots(guild_id,by_id,at,json) VALUES(?,?,?,?)', 'g', 'owner', 0, JSON.stringify(data));
    return { store, service, calls, guild, data };
}

test('snapshot IDs cannot be restored across guilds', () => {
    const f = fixture();
    assert.throws(() => f.service.load('other', 1), /No snapshot/);
    f.store.close();
});

test('stale recovery previews reject before any Discord mutation', async () => {
    const f = fixture();
    await assert.rejects(f.service.restore(f.guild, 1, false, 'old-fingerprint'), /server changed/);
    assert.deepEqual(f.calls, []);
    f.store.close();
});

test('a no-op snapshot restore does not send role/channel mutation requests', async () => {
    const f = fixture(), p = await f.service.plan(f.guild, f.data, false);
    assert.equal(p.roleUpdate, 0);
    assert.equal(p.roleCreate, 0);
    const result = await f.service.restore(f.guild, 1, false, p.fingerprint);
    assert.deepEqual(f.calls, []);
    assert.match(result, /Failures:\*\* 0/);
    f.store.close();
});

test('snapshot pruning protects managed roles, bot roles and configured roles', async () => {
    const f = fixture();
    const s = f.store.settings('g');
    s.verifiedRoleId = 'verified';
    f.store.save(s);
    for (const [id, managed] of [['managed', true], ['verified', false], ['extra', false]] as const)
        f.guild.roles.cache.set(id, { id, managed, editable: true });
    const p = await f.service.plan(f.guild, f.data, true);
    assert.deepEqual(p.roleDelete, ['extra']);
    f.store.close();
});
