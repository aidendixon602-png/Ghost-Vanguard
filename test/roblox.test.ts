import { authorize } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import { Store } from '../src/database/db.js';
import { Roblox } from '../src/integrations/roblox.js';
import { lookupCard } from '../src/features/roblox-tools.js';
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
    const original = globalThis.fetch;
    globalThis.fetch = fn;
    try {
        await testFn();
    } finally {
        globalThis.fetch = original;
    }
}

test('Roblox profile cards merge local and Bloxlink linked Discord accounts without duplicates', async () => {
    const f = fixture();
    f.store.run('INSERT INTO links VALUES(?,?,?,?,?)', 'g', 'local-user', '123', 'RobloxName', 0);
    const original = globalThis.fetch;
    globalThis.fetch = async (input: any) => {
        const url = String(input);
        if (url.endsWith('/v1/users/123')) return Response.json({ id: 123, name: 'RobloxName', displayName: 'RobloxName', created: '2020-01-01T00:00:00Z', isBanned: false, description: '' });
        if (url.includes('username-history')) return Response.json({ data: [] });
        if (url.includes('/groups/roles')) return Response.json({ data: [] });
        if (url.includes('thumbnails')) return Response.json({ data: [] });
        throw new Error(`Unexpected Roblox URL: ${url}`);
    };
    try {
        const card = await lookupCard(f.store, 'g', '123', ['local-user', '214858075650260992']);
        assert.match(card!.toJSON().description!, /<@local-user>/);
        assert.match(card!.toJSON().description!, /<@214858075650260992>/);
        assert.equal((card!.toJSON().description!.match(/<@local-user>/g) ?? []).length, 1);
    } finally {
        globalThis.fetch = original;
        f.store.close();
    }
});

test('Bloxlink reverse lookup returns null when custom verification is active', async () => {
    const f = fixture();
    assert.equal(await f.roblox.discordIdsForRoblox('g', '146941966'), null);
    f.store.close();
});

test('Bloxlink update-user throws disabled error', async () => {
    const f = fixture();
    await assert.rejects(f.roblox.updateBloxlinkUser(f.member), /Bloxlink sync is disabled/);
    f.store.close();
});

test('sync without linked account throws friendly error', async () => {
    const f = fixture();
    await assert.rejects(f.roblox.sync(f.member), /No linked Roblox account/);
    f.store.close();
});

test('sync with pending code prompts user to add code to profile', async () => {
    const f = fixture();
    f.store.run('INSERT INTO verification_pending(guild_id,user_id,roblox_id,roblox_name,code,created_at) VALUES(?,?,?,?,?,?)', 'g', 'u', '123', 'RobloxUser', 'VG-123456', Date.now());
    await assert.rejects(f.roblox.sync(f.member), /pending verification/);
    f.store.close();
});

test('join sync skips unlinked members and synchronizes linked members', async () => {
    const f = fixture();
    let calls = 0;
    f.roblox.sync = async (_member, opts) => { calls++; assert.equal(opts?.isInitial, true); return 'ok'; };
    try {
        await f.roblox.syncOnJoin(f.member);
        assert.equal(calls, 0);
        f.store.run('INSERT INTO links VALUES(?,?,?,?,?)', 'g', 'u', '123', 'RobloxName', 0);
        await f.roblox.syncOnJoin(f.member);
        assert.equal(calls, 1);
    } finally { f.store.close(); }
});

test('unsafe verified roles are rejected with actionable reasons', async () => {
    const f = fixture();
    f.store.run('INSERT INTO links VALUES(?,?,?,?,?)', 'g', 'u', '123', 'RobloxName', 0);
    const role = { id: 'verified', managed: false, editable: true, permissions: new PermissionsBitField(0n) };
    try {
        for (const [candidate, reason] of [
            [null, /no longer exists/],
            [{ ...role, managed: true }, /managed by an integration/],
            [{ ...role, editable: false }, /role hierarchy/],
            [{ ...role, permissions: new PermissionsBitField(8n) }, /administrative permissions/],
        ] as const) {
            f.member.guild.roles.fetch = async () => candidate;
            await assert.rejects(f.roblox.sync(f.member), reason);
        }
        assert.deepEqual(f.changes, []);
    } finally { f.store.close(); }
});

test('a role that becomes managed during verification is not granted', async () => {
    const f = fixture();
    f.store.run('INSERT INTO links VALUES(?,?,?,?,?)', 'g', 'u', '123', 'RobloxName', 0);
    let reads = 0;
    f.member.guild.roles.fetch = async () => ({ id: 'verified', managed: ++reads > 1, editable: true, permissions: new PermissionsBitField(0n) });
    try {
        await withFetch(async () => Response.json({ name: 'RobloxName', created: '2020-01-01T00:00:00Z', isBanned: false }), async () => {
            await assert.rejects(f.roblox.sync(f.member), /unsafe or unavailable/);
            assert.deepEqual(f.changes, []);
        });
    } finally { f.store.close(); }
});

test('Roblox API outage preserves the verified role', async () => {
    const f = fixture();
    f.store.run('INSERT INTO links VALUES(?,?,?,?,?)', 'g', 'u', '123', 'RobloxName', 0);
    await withFetch(async () => new Response('{}', { status: 503 }), async () => {
        await assert.rejects(f.roblox.sync(f.member), /Roblox profile lookup failed/);
        assert.deepEqual(f.changes, []);
    });
    f.store.close();
});

test('valid linked account grants role and persists link', async () => {
    const f = fixture();
    f.member.roles.cache.clear();
    f.store.run('INSERT INTO links VALUES(?,?,?,?,?)', 'g', 'u', '123', 'VerifiedRoblox', 0);
    await withFetch(async (url) => String(url).includes('users.roblox.com') ? Response.json({ name: 'VerifiedRoblox', displayName: 'VerifiedRoblox', created: '2020-01-01T00:00:00Z', isBanned: false }) : new Response('{}', { status: 404 }), async () => {
        assert.match(await f.roblox.sync(f.member), /VerifiedRoblox/);
        assert.deepEqual(f.changes, ['add']);
        assert.equal(f.store.get('SELECT roblox_id FROM links WHERE guild_id=? AND user_id=?', 'g', 'u')?.roblox_id, '123');
    });
    f.store.close();
});

test('silent background sync does not re-add role if already present', async () => {
    const f = fixture();
    f.store.run('INSERT INTO links VALUES(?,?,?,?,?)', 'g', 'u', '123', 'VerifiedRoblox', 0);
    await withFetch(async () => Response.json({ name: 'VerifiedRoblox', displayName: 'VerifiedRoblox', created: '2020-01-01T00:00:00Z', isBanned: false }), async () => {
        await f.roblox.sync(f.member, { silent: true });
        assert.deepEqual(f.changes, [], 'no roles added or removed');
    });
    f.store.close();
});

test('new Roblox accounts lose verification without receiving a role', async () => {
    const f = fixture();
    f.store.run('INSERT INTO links VALUES(?,?,?,?,?)', 'g', 'u', '123', 'Fresh', 0);
    await withFetch(async (url) => String(url).includes('users.roblox.com') ? Response.json({ name: 'Fresh', displayName: 'Fresh', created: new Date().toISOString(), isBanned: false }) : new Response('{}', { status: 404 }), async () => {
        await assert.rejects(f.roblox.sync(f.member), /at least 7 days/);
        assert.deepEqual(f.changes, ['remove']);
    });
    f.store.close();
});

test('recorded ban-linked Roblox account blocks member and removes role', async () => {
    const f = fixture();
    f.store.run('INSERT INTO links VALUES(?,?,?,?,?)', 'g', 'u', '123', 'Old', 0);
    f.roblox.rememberBan('g', 'u');
    await withFetch(async (url) => String(url).includes('users.roblox.com') ? Response.json({ name: 'Old', displayName: 'Old', created: '2020-01-01T00:00:00Z', isBanned: false }) : new Response('{}', { status: 404 }), async () => {
        await assert.rejects(f.roblox.sync(f.member), /Roblox blacklist/);
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

test('custom verification code creation and confirmation', async () => {
    const { createPending, confirmPending, linkAccount, getLink } = await import('../src/integrations/custom-verification.js');
    const store = new Store(':memory:');
    const original = globalThis.fetch;
    let mockDesc = 'Hello world VG-TEST12';
    globalThis.fetch = async (input: any) => {
        const url = String(input);
        if (url.includes('/usernames/users')) return Response.json({ data: [{ id: 999, name: 'Robloxian' }] });
        if (url.includes('/v1/users/999')) return Response.json({ id: 999, name: 'Robloxian', description: mockDesc });
        throw new Error(`Unexpected URL: ${url}`);
    };
    try {
        const pending = await createPending(store, 'g', 'user1', 'Robloxian');
        assert.equal(pending.roblox_id, '999');
        assert.ok(pending.code.startsWith('VG-'));
        mockDesc = `About me: ${pending.code}`;
        const confirmed = await confirmPending(store, 'g', 'user1');
        assert.equal(confirmed.verified, true);
        linkAccount(store, 'g', 'user1', confirmed.roblox_id, confirmed.roblox_name);
        const link = getLink(store, 'g', 'user1');
        assert.equal(link?.roblox_id, '999');
        assert.equal(link?.username, 'Robloxian');
    } finally {
        globalThis.fetch = original;
        store.close();
    }
});
