import { authorize } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/database/db.js';
import { broadcast, broadcastTargets, clearPresenceOverride, inspectGuild, presenceOverride, setPresenceOverride } from '../src/bot/dev-tools.js';

function setup() {
    const store = new Store(':memory:');
    for (const id of ['g', 'g2']) {
        authorize(store, id);
        const s = store.settings(id);
        s.authorized = true;
        s.logChannelId = id === 'g' ? 'logs' : null;
        store.save(s);
    }
    return store;
}

test('a custom status lasts until it expires or is reset, and survives being re-read', () => {
    const store = setup(), now = Date.now();
    assert.equal(presenceOverride(store, now), null);
    setPresenceOverride(store, '🔧 Maintenance', 'dnd', 30, now);
    assert.deepEqual(presenceOverride(store, now + 60000), { text: '🔧 Maintenance', mode: 'dnd', until: now + 30 * 60000 });
    assert.equal(presenceOverride(store, now + 31 * 60000), null, 'expired statuses return to the rotation');
    assert.equal(store.get("SELECT 1 FROM runtime_meta WHERE key='presence_override'"), undefined, 'and are cleared');
    setPresenceOverride(store, 'Until reset', 'online', null, now);
    assert.equal(presenceOverride(store, now + 365 * 86400000)?.text, 'Until reset');
    clearPresenceOverride(store);
    assert.equal(presenceOverride(store), null);
    store.run("INSERT INTO runtime_meta(key,value) VALUES('presence_override','not json')");
    assert.equal(presenceOverride(store), null, 'a corrupted value is ignored and cleared');
    store.close();
});

test('broadcasts reach authorized servers with a log channel only', async () => {
    const store = setup();
    assert.deepEqual(broadcastTargets(store, ['g', 'g2', 'unknown']), { deliver: ['g'], noChannel: ['g2'] });
    const pushed: string[] = [];
    const logs: any = { push: (id: string) => pushed.push(id) };
    assert.equal(await broadcast(store, logs, ['g', 'g2', 'unknown'], 'Maintenance', 'Back soon', 'dev'), 1);
    assert.deepEqual(pushed, ['g']);
    assert.equal(JSON.parse(store.get("SELECT value FROM runtime_meta WHERE key='last_broadcast'")!.value).servers, 1);
    store.close();
});

test('inspect gives a read-only overview, and only authorization details for unauthorized servers', () => {
    const store = setup();
    const s = store.settings('g');
    s.enabled = true;
    s.mode = 'enforce';
    store.save(s);
    store.incident('g', 'nuker', 'mass_ban', 'enforce', 'Contained');
    store.run('INSERT INTO lockdowns(guild_id,started_by,started_at,channel_count) VALUES(?,?,?,?)', 'g', 'mod', Date.now(), 12);
    const lines = inspectGuild(store, 'g', 'Midtown', 250).join('\n');
    assert.match(lines, /Midtown \(g\) · 250 members/);
    assert.match(lines, /AUTHORIZED/);
    assert.match(lines, /Anti-nuke:\*\* on · enforce/);
    assert.match(lines, /Lockdown:\*\* active since .* \(12 channels\)/);
    assert.match(lines, /Incidents \(7 days\):\*\* 1 · last: mass_ban/);
    const unknown = inspectGuild(store, '123456789012345678', null, null);
    assert.equal(unknown.length, 3);
    assert.match(unknown.join('\n'), /never seen[\s\S]*only shown for authorized servers/);
    store.close();
});
