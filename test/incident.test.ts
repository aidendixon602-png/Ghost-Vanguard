import { authorize } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/database/db.js';
import { LogQueue } from '../src/logging.js';
import { incidentRestorePlan } from '../src/ui/incident-ui.js';

function setup() {
    const store = new Store(':memory:');
    authorize(store);
    const settings = store.settings('g');
    settings.authorized = true;
    settings.logChannelId = 'logs';
    store.save(settings);
    return store;
}

const snapshot = (store: Store, at: number, kind?: string) => {
    const id = Number(store.run('INSERT INTO snapshots(guild_id,by_id,at,json) VALUES(?,?,?,?)', 'g', 'owner', at, '{}').lastInsertRowid);
    if (kind)
        store.run('INSERT INTO snapshot_metadata(snapshot_id,guild_id,kind,source_guild) VALUES(?,?,?,?)', id, 'g', kind, kind === 'copy' ? 'other' : null);
    return id;
};

test('incident restore uses the newest real snapshot from before the first deletion', () => {
    const store = setup(), now = Date.now();
    const before = snapshot(store, now - 300000, 'snapshot');
    const older = snapshot(store, now - 900000);
    snapshot(store, now - 120000, 'copy');
    snapshot(store, now);
    store.observe('d1', 'g', 'nuker', 'channel_delete', 'c1', now - 60000);
    store.observe('d2', 'g', 'nuker', 'role_delete', 'r1', now - 30000);
    store.observe('x1', 'g', 'someone-else', 'channel_delete', 'c2', now - 200000);
    const incident = store.incident('g', 'nuker', 'channel_delete', 'observe', 'Observed only');
    const plan = incidentRestorePlan(store, 'g', incident);
    assert.deepEqual(plan.candidates, [before, older], 'copy templates and later snapshots are skipped');
    assert.deepEqual(plan.components, ['roles', 'categories', 'channels', 'permissions']);
    assert.deepEqual([plan.channels, plan.roles], [1, 1]);
    store.close();
});

test('incident restore refuses incidents without recorded deletions', () => {
    const store = setup();
    const incident = store.incident('g', 'pruner', 'member_prune', 'observe', 'Observed only');
    assert.throws(() => incidentRestorePlan(store, 'g', incident), /No channel or role deletions/);
    assert.throws(() => incidentRestorePlan(store, 'g', 999), /no longer exists/);
    store.close();
});

test('the log outbox delivers alerts with buttons and still delivers older plain alerts', async () => {
    const store = setup();
    const sent: any[] = [];
    const client: any = { isReady: () => true, channels: { fetch: async () => ({ isSendable: () => true, send: async (m: unknown) => {
                    sent.push(m);
                } }) } };
    const logs = new LogQueue(store, client);
    store.run('INSERT INTO outbox(guild_id,channel_id,json) VALUES(?,?,?)', 'g', 'logs', JSON.stringify({ title: 'Older alert' }));
    logs.push('g', { toJSON: () => ({ title: 'Incident' }) } as any, [{ toJSON: () => ({ type: 1, components: [{ type: 2, custom_id: 'incident:restore:1' }] }) } as any]);
    await logs.flush();
    assert.deepEqual(sent.map(m => m.embeds[0].title), ['Older alert', 'Incident']);
    assert.equal(sent[0].components, undefined);
    assert.equal(sent[1].components[0].components[0].custom_id, 'incident:restore:1');
    store.close();
});
