import { authorize } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import { config } from '../src/config.js';
import { Store } from '../src/database/db.js';
import { Roblox } from '../src/integrations/roblox.js';
import type { LogQueue } from '../src/logging.js';

function fixture() {
    const store = new Store(':memory:');
    authorize(store);
    const s = store.settings('g');
    s.authorized = true;
    s.verifiedRoleId = 'verified';
    s.nickname = false;
    store.save(s);
    const changes: string[] = [];
    const role = { id: 'verified', managed: false, editable: true, permissions: new PermissionsBitField(0n) };
    const member: any = { id: 'u', nickname: null, roles: { cache: new Map([['verified', role]]), add: async () => changes.push('add'), remove: async () => changes.push('remove') } };
    member.guild = { id: 'g', members: { fetch: async () => member }, roles: { fetch: async () => role } };
    const roblox = new Roblox(store, { push: () => { } } as unknown as LogQueue);
    return { store, member, changes, roblox };
}

async function withFetch(fn: typeof fetch, testFn: () => Promise<void>) {
    const original = globalThis.fetch, oldR = config.roverKey, oldB = config.bloxlinkKey;
    globalThis.fetch = fn;
    config.roverKey = 'mock-key';
    config.bloxlinkKey = '';
    try {
        await testFn();
    } finally {
        globalThis.fetch = original;
        config.roverKey = oldR;
        config.bloxlinkKey = oldB;
    }
}

test('provider outage preserves the verified role', async () => {
    const f = fixture();
    await withFetch(async () => new Response('{}', { status: 503 }), async () => {
        await assert.rejects(f.roblox.sync(f.member), /preserved/);
        assert.deepEqual(f.changes, []);
    });
    f.store.close();
});

test('a rejected API key gets a specific message and pauses that provider for the server', async () => {
    const f = fixture();
    let calls = 0;
    await withFetch(async () => {
        calls++;
        return new Response('{}', { status: 401 });
    }, async () => {
        await assert.rejects(f.roblox.sync(f.member), /RoVer rejected the bot's API key.*preserved/);
        await assert.rejects(f.roblox.sync(f.member), /RoVer rejected the bot's API key/);
        assert.equal(calls, 1, 'second attempt is paused instead of calling the provider again');
        assert.deepEqual(f.changes, []);
    });
    f.store.close();
});

test('an outage keeps the generic message instead of blaming the key', async () => {
    const f = fixture();
    await withFetch(async () => new Response('{}', { status: 503 }), async () => {
        await assert.rejects(f.roblox.sync(f.member), (error: Error) => /unavailable or misconfigured/.test(error.message) && !/rejected/.test(error.message));
    });
    f.store.close();
});

test('a rejected key pauses only the server it was rejected for', async () => {
    const f = fixture();
    authorize(f.store, 'g2');
    const s2 = f.store.settings('g2');
    s2.authorized = true;
    s2.verifiedRoleId = 'verified';
    s2.nickname = false;
    f.store.save(s2);
    const other: any = { ...f.member, guild: { ...f.member.guild, id: 'g2' } };
    const seen: string[] = [];
    await withFetch(async (url: any) => {
        const guild = String(url).includes('/guilds/g2/') ? 'g2' : 'g';
        seen.push(guild);
        return new Response('{}', { status: guild === 'g' ? 401 : 404 });
    }, async () => {
        await assert.rejects(f.roblox.sync(f.member), /rejected/);
        assert.match(await f.roblox.sync(other), /No linked/);
        assert.deepEqual(seen, ['g', 'g2']);
    });
    f.store.close();
});

test('confirmed unlink revokes role and removes stored link', async () => {
    const f = fixture();
    f.store.run('INSERT INTO links VALUES(?,?,?,?,?)', 'g', 'u', '123', 'old', 0);
    await withFetch(async () => new Response('{}', { status: 404 }), async () => {
        assert.match(await f.roblox.sync(f.member), /No linked/);
        assert.deepEqual(f.changes, ['remove']);
        assert.equal(f.store.all('SELECT * FROM links').length, 0);
    });
    f.store.close();
});

test('valid provider mapping grants only the configured role and persists the link', async () => {
    const f = fixture();
    await withFetch(async (url) => String(url).includes('users.roblox.com') ? Response.json({ name: 'VerifiedRoblox', created: '2020-01-01T00:00:00Z', isBanned: false }) : Response.json({ robloxId: '123' }), async () => {
        assert.match(await f.roblox.sync(f.member), /VerifiedRoblox/);
        assert.deepEqual(f.changes, ['add']);
        assert.equal(f.store.get('SELECT roblox_id FROM links')?.roblox_id, '123');
    });
    f.store.close();
});

test('new Roblox accounts lose verification without receiving a role', async () => {
    const f = fixture();
    await withFetch(async (url) => String(url).includes('users.roblox.com') ? Response.json({ name: 'Fresh', created: new Date().toISOString(), isBanned: false }) : Response.json({ robloxId: '123' }), async () => {
        await assert.rejects(f.roblox.sync(f.member), /at least 7 days/);
        assert.deepEqual(f.changes, ['remove']);
    });
    f.store.close();
});

test('recorded ban-linked Roblox account blocks another Discord account', async () => {
    const f = fixture();
    f.store.run('INSERT INTO links VALUES(?,?,?,?,?)', 'g', 'banned-discord', '123', 'old', 0);
    f.roblox.rememberBan('g', 'banned-discord');
    await withFetch(async (url) => String(url).includes('users.roblox.com') ? Response.json({ name: 'Old', created: '2020-01-01T00:00:00Z', isBanned: false }) : Response.json({ robloxId: '123' }), async () => {
        await assert.rejects(f.roblox.sync(f.member), /recorded Roblox blacklist/);
        assert.deepEqual(f.changes, ['remove']);
    });
    f.store.close();
});

test('quarantined users cannot start verification or call providers', async () => {
    const f = fixture();
    f.store.run('INSERT INTO backups VALUES(?,?,?,?,?)', 'g', 'u', '[]', 0, 1);
    await withFetch(async () => {
        throw new Error('Provider must not be called');
    }, async () => {
        await assert.rejects(f.roblox.sync(f.member), /quarantined/);
        assert.deepEqual(f.changes, []);
    });
    f.store.close();
});
