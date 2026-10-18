import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { Store } from '../src/database/db.js';
import { authorize } from './helpers.js';
import { catchUp } from '../src/audit/downtime.js';
import { shouldPost, QUIET_RESTART_MS } from '../src/audit/notices.js';

/**
 * Restart notices must not fill log channels: a quick restart with nothing changed posts
 * nothing; a first start, a real outage, or an actual change is still announced.
 */

const MIN = 60000;

function setup() {
    const store = new Store(':memory:'); authorize(store);
    const s = store.settings('g'); s.enabled = true; s.mode = 'enforce'; s.logChannelId = 'log'; store.save(s);
    const above: any[] = [];
    const guild: any = {
        id: 'g', ownerId: 'owner', client: { user: { id: 'bot' } },
        // No audit-log access, so only the startup notices themselves are exercised here.
        members: { me: { permissions: { has: (p: bigint) => p !== 128n }, roles: { highest: { id: 'botrole', position: 10 } } }, cache: new Collection() },
        roles: { get cache() { return new Collection(above.map(r => [r.id, r])); } },
        channels: { cache: new Collection([['log', { isTextBased: () => true, permissionsFor: () => ({ has: () => true }) }]]) },
    };
    const posted: string[] = [];
    const logs: any = { push: (_g: string, e: any) => void posted.push(String(e.toJSON().title)) };
    const restart = async (offlineMinutes: number | null) => {
        posted.length = 0;
        const now = Date.now();
        await store.withAuthorized('g', () => catchUp(guild, store, logs, () => false, offlineMinutes === null ? null : now - offlineMinutes * MIN, now));
        return [...posted];
    };
    return { store, guild, above, restart };
}

const BACK = '🟢 Ghost Vanguard is back online', SAVED = 'Saved protection loaded';

test('the first start with a database announces itself and the saved protection', async () => {
    const { store, restart } = setup();
    try {
        assert.deepEqual(await restart(null), [BACK, SAVED]);
    } finally { store.close(); }
});

test('quick restarts with nothing changed post nothing at all', async () => {
    const { store, restart } = setup();
    try {
        await restart(null);
        assert.deepEqual(await restart(1), [], 'a 1-minute restart is silent');
        assert.deepEqual(await restart(5), [], 'and so is the next one');
    } finally { store.close(); }
});

test('servers set up before this update stay quiet on the first quick restart after it', async () => {
    const { store, restart } = setup();
    try {
        assert.deepEqual(await restart(2), [], 'nothing remembered yet, but a quick restart only remembers');
        assert.deepEqual(await restart(2), []);
    } finally { store.close(); }
});

test('a real outage is announced, without repeating an unchanged protection summary', async () => {
    const { store, restart } = setup();
    try {
        await restart(null);
        assert.deepEqual(await restart(QUIET_RESTART_MS / MIN + 5), [BACK]);
    } finally { store.close(); }
});

test('a change is announced even on a quick restart', async () => {
    const { store, above, restart } = setup();
    try {
        await restart(null);
        above.push({ id: 'r1', name: 'daddy artis', position: 20, managed: false, permissions: { has: () => false } });
        const afterRoleMove = await restart(1);
        assert.ok(afterRoleMove.includes(SAVED), 'a new role above the bot is reported once');
        assert.deepEqual(await restart(1), [], 'and not again while it stays the same');
        store.grant('g', '900000000000000001', 'trust', 'owner');
        assert.deepEqual(await restart(1), [BACK], 'a trust-list change shows in the back-online summary');
        above.push({ id: 'r2', name: 'Trusted Upper', position: 21, managed: false, permissions: { has: () => false } });
        store.grant('g', 'r2', 'trust_role', 'owner');
        assert.deepEqual(await restart(1), [BACK, SAVED], 'a role exemption above Vanguard is included in the warning and change fingerprint');
        assert.deepEqual(await restart(1), [], 'the same hierarchy warning is not repeated on every restart');
    } finally { store.close(); }
});

test('scam readiness: "ready" is remembered silently, problems are posted once, recovery is posted', () => {
    const store = new Store(':memory:');
    try {
        const ready = JSON.stringify([true, 'ready']), broken = JSON.stringify([false, 'log channel missing']);
        assert.equal(shouldPost(store, 'g', 'scam', ready, { quietIfNew: true }), false, 'first "ready" is not posted');
        assert.equal(shouldPost(store, 'g', 'scam', ready, { quietIfNew: true }), false, 'nor on later restarts');
        assert.equal(shouldPost(store, 'g', 'scam', broken, { quietIfNew: false }), true, 'a problem is posted');
        assert.equal(shouldPost(store, 'g', 'scam', broken, { quietIfNew: false }), false, 'once');
        assert.equal(shouldPost(store, 'g', 'scam', ready, { quietIfNew: true }), true, 'recovery is posted');
        assert.equal(shouldPost(store, 'other', 'scam', broken, { quietIfNew: false }), true, 'each server is tracked separately');
    } finally { store.close(); }
});
