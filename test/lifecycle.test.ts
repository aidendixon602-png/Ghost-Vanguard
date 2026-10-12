import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { Store } from '../src/database/db.js';
import { GuildLifecycle } from '../src/bot/lifecycle.js';
import { config } from '../src/config.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const developer = '1277709272041394187';

config.developers.add(developer);

function fixture(path = ':memory:', id = '123456789012345678') {
    const store = new Store(path);
    let leaves = 0, init = 0, clean = 0;
    const guild: any = { id, name: 'Test Guild', members: { me: { joinedTimestamp: Date.now() } }, channels: { cache: new Collection() }, systemChannel: null, leave: async () => {
            leaves++;
        } };
    const client: any = { guilds: { cache: new Collection([[id, guild]]) } };
    const lifecycle = new GuildLifecycle(store, client, () => {
        clean++;
    }, async () => {
        init++;
    });
    return { store, guild, client, lifecycle, counts: () => ({ leaves, init, clean }), close: () => {
            lifecycle.close();
            store.close();
        } };
}

test('invites persist a deadline without initializing protected systems', async () => {
    const f = fixture();
    await f.lifecycle.joined(f.guild, true);
    const row = f.store.authorization(f.guild.id)!;
    assert.equal(row.state, 'PENDING_AUTHORIZATION');
    assert.equal(row.deadline - row.joined_at, 120000);
    assert.equal(f.counts().init, 0);
    f.close();
});

test('restart retains pending deadline; offline-expired guild leaves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-auth-'));
    const path = join(dir, 'db');
    try {
        let f = fixture(path);
        await f.lifecycle.joined(f.guild, true);
        const joined = f.store.authorization(f.guild.id)!.joined_at;
        f.close();
        f = fixture(path);
        await f.lifecycle.joined(f.guild);
        assert.equal(f.store.authorization(f.guild.id)!.joined_at, joined);
        assert.equal(f.store.authorization(f.guild.id)!.deadline, joined + 120000);
        f.store.run('UPDATE guild_authorization SET deadline=? WHERE guild_id=?', Date.now() - 1, f.guild.id);
        f.close();
        f = fixture(path);
        await f.lifecycle.joined(f.guild);
        assert.equal(f.store.authorization(f.guild.id)!.state, 'EXPIRED');
        assert.equal(f.counts().leaves, 1);
        assert.equal(f.counts().init, 0);
        f.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('authorization survives restart and independently authorizes current guild only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-auth-'));
    const path = join(dir, 'db');
    try {
        let f = fixture(path);
        await f.lifecycle.joined(f.guild, true);
        await f.lifecycle.authorize(f.guild, developer);
        assert.equal(f.store.isAuthorized(f.guild.id), true);
        assert.equal(f.store.isAuthorized('other'), false);
        assert.equal(f.counts().init, 1);
        f.close();
        f = fixture(path);
        await f.lifecycle.joined(f.guild);
        assert.equal(f.store.authorization(f.guild.id)!.authorized_by, developer);
        assert.equal(f.counts().init, 1);
        f.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('owner/admin who is not configured developer cannot authorize', async () => {
    const f = fixture();
    await f.lifecycle.joined(f.guild, true);
    await assert.rejects(f.lifecycle.authorize(f.guild, 'owner'), /approved/);
    assert.equal(f.store.isAuthorized(f.guild.id), false);
    f.close();
});

test('final timeout check preserves an authorization at the deadline', async () => {
    const f = fixture();
    await f.lifecycle.joined(f.guild, true);
    f.store.run('UPDATE guild_authorization SET deadline=?', Date.now());
    await Promise.all([f.lifecycle.authorize(f.guild, developer), f.lifecycle.expire(f.guild)]);
    assert.equal(f.store.authorization(f.guild.id)!.state, 'AUTHORIZED');
    assert.equal(f.counts().leaves, 0);
    f.close();
});

test('expiry claimed first rejects authorization and never kicks an authorized guild', async () => {
    const f = fixture();
    await f.lifecycle.joined(f.guild, true);
    f.store.run('UPDATE guild_authorization SET deadline=?', Date.now() - 1);
    const result = await Promise.allSettled([f.lifecycle.expire(f.guild), f.lifecycle.authorize(f.guild, developer)]);
    assert.equal(result[1]!.status, 'rejected');
    assert.equal(f.store.authorization(f.guild.id)!.state, 'EXPIRED');
    assert.equal(f.counts().leaves, 1);
    f.close();
});

test('server ban blocks authorization, leaves on invite and survives unban as deauthorized', async () => {
    const f = fixture();
    await f.lifecycle.ban(f.guild.id, f.guild.name, 'Raid', developer);
    await f.lifecycle.joined(f.guild, true);
    assert.equal(f.store.isAuthorized(f.guild.id), false);
    await assert.rejects(f.lifecycle.authorize(f.guild, developer), /banned|leaving/);
    assert.equal(f.counts().init, 0);
    assert.ok(f.counts().leaves >= 1);
    f.lifecycle.unban(f.guild.id, developer);
    assert.equal(f.store.authorization(f.guild.id)!.state, 'DEAUTHORIZED');
    assert.equal(f.store.isAuthorized(f.guild.id), false);
    f.close();
});

test('deauthorization disables anti-nuke and invalidates in-flight work before leave', async () => {
    const f = fixture();
    await f.lifecycle.joined(f.guild, true);
    await f.lifecycle.authorize(f.guild, developer);
    const s = f.store.settings(f.guild.id);
    s.enabled = true;
    f.store.save(s);
    let resume!: () => void;
    const running = f.store.withAuthorized(f.guild.id, async () => {
        await new Promise<void>(r => {
            resume = r;
        });
        f.store.assertAuthorized(f.guild.id);
    });
    await f.lifecycle.deauthorize(f.guild, developer);
    assert.equal(f.store.settings(f.guild.id).enabled, false);
    assert.equal(f.store.authorization(f.guild.id)!.removed_by, developer);
    resume();
    await assert.rejects(running, /authorization/);
    await f.lifecycle.queue.run(f.guild.id, async () => { });
    f.close();
});

test('generation prevents old work resuming after a new authorization', async () => {
    const f = fixture();
    await f.lifecycle.joined(f.guild, true);
    await f.lifecycle.authorize(f.guild, developer);
    let resume!: () => void;
    const running = f.store.withAuthorized(f.guild.id, async () => {
        await new Promise<void>(r => resume = r);
        f.store.assertAuthorized(f.guild.id);
    });
    f.store.run('UPDATE guild_authorization SET generation=generation+1 WHERE guild_id=?', f.guild.id);
    resume();
    await assert.rejects(running, /authorization/);
    f.close();
});

test('legacy boolean authorization never bypasses explicit state authorization', () => {
    const f = fixture();
    const s = f.store.settings(f.guild.id);
    s.authorized = true;
    f.store.save(s);
    assert.equal(f.store.isAuthorized(f.guild.id), false);
    assert.equal(f.store.settings(f.guild.id).authorized, false);
    f.close();
});

test('replayed join events do not restart the pending deadline', async () => {
    const f = fixture();
    await f.lifecycle.joined(f.guild, true);
    const deadline = f.store.authorization(f.guild.id)!.deadline;
    await f.lifecycle.joined(f.guild, true);
    assert.equal(f.store.authorization(f.guild.id)!.deadline, deadline);
    f.close();
});

test('an authorized guild cannot run protected work while initialization failed; auth retries it', async () => {
    const f = fixture();
    let attempts = 0;
    f.lifecycle.close();
    const lifecycle = new GuildLifecycle(f.store, f.client, () => { }, async () => {
        if (++attempts === 1)
            throw new Error('initialization failed');
    });
    await lifecycle.joined(f.guild, true);
    await assert.rejects(lifecycle.authorize(f.guild, developer), /initialization failed/);
    assert.equal(f.store.isAuthorized(f.guild.id), true);
    assert.equal(lifecycle.isReady(f.guild.id), false);
    await lifecycle.authorize(f.guild, developer);
    assert.equal(lifecycle.isReady(f.guild.id), true);
    lifecycle.close();
    f.close();
});

function inviterFixture(executor: string | null = developer, offset = 0, path = ':memory:') {
    const f = fixture(path);
    const bot = '999999999999999999';
    let reads = 0;
    f.client.user = { id: bot };
    f.guild.members.me.id = bot;
    f.guild.members.me.permissions = { has: () => true };
    f.guild.fetchAuditLogs = async () => {
        reads++;
        return { entries: new Collection([['entry', {
                        action: 28, targetId: bot, executorId: executor, createdTimestamp: f.guild.members.me.joinedTimestamp + offset,
                    }]]) };
    };
    return { ...f, reads: () => reads, bot };
}

test('developer inviter automatically authorizes without a leave timer and survives reconnect', async () => {
    const f = inviterFixture();
    try {
        await f.lifecycle.joined(f.guild, true);
        assert.equal(f.store.isAuthorized(f.guild.id), true);
        assert.equal(f.store.authorization(f.guild.id)!.authorized_by, developer);
        assert.equal(f.lifecycle.isReady(f.guild.id), true);
        f.store.run('UPDATE guild_authorization SET deadline=?', Date.now() - 1);
        await f.lifecycle.expire(f.guild);
        await f.lifecycle.joined(f.guild);
        assert.equal(f.counts().leaves, 0);
        assert.equal(f.counts().init, 1);
        assert.equal(f.reads(), 1);
    } finally {
        f.close();
    }
});

test('non-developer inviter retains pending state and expires normally', async () => {
    const f = inviterFixture('223456789012345678');
    try {
        await f.lifecycle.joined(f.guild, true);
        assert.equal(f.store.isAuthorized(f.guild.id), false);
        assert.equal(f.counts().init, 0);
        assert.equal(f.reads(), 1);
        f.store.run('UPDATE guild_authorization SET deadline=?', Date.now() - 1);
        await f.lifecycle.expire(f.guild);
        assert.equal(f.counts().leaves, 1);
    } finally {
        f.close();
    }
});

test('missing audit permission requires manual authorization without audit requests', async () => {
    const f = inviterFixture();
    f.guild.members.me.permissions.has = () => false;
    try {
        await f.lifecycle.joined(f.guild, true);
        assert.equal(f.reads(), 0);
        assert.equal(f.store.isAuthorized(f.guild.id), false);
        await f.lifecycle.authorize(f.guild, developer);
        assert.equal(f.store.isAuthorized(f.guild.id), true);
    } finally {
        f.close();
    }
});

test('audit lookup failure keeps the original deadline and pending authorization', async () => {
    const f = inviterFixture();
    f.guild.fetchAuditLogs = async () => {
        throw new Error('API unavailable');
    };
    try {
        await f.lifecycle.joined(f.guild, true);
        const row = f.store.authorization(f.guild.id)!;
        assert.equal(row.state, 'PENDING_AUTHORIZATION');
        assert.equal(row.deadline, row.joined_at + 120000);
    } finally {
        f.close();
    }
});

test('old developer bot-add entry cannot authorize a new installation', async () => {
    const f = inviterFixture(developer, -60000);
    f.guild.members.me.joinedTimestamp -= 180000;
    try {
        await f.lifecycle.joined(f.guild, true);
        assert.equal(f.store.isAuthorized(f.guild.id), false);
        assert.equal(f.reads(), 1);
        assert.equal(f.counts().leaves, 1);
    } finally {
        f.close();
    }
});

test('entries for another bot cannot authorize this bot', async () => {
    const f = inviterFixture();
    f.guild.members.me.joinedTimestamp -= 180000;
    f.guild.fetchAuditLogs = async () => ({ entries: new Collection([['other', { action: 28, targetId: 'other', executorId: developer, createdTimestamp: f.guild.members.me.joinedTimestamp }]]) });
    try {
        await f.lifecycle.joined(f.guild, true);
        assert.equal(f.store.isAuthorized(f.guild.id), false);
    } finally {
        f.close();
    }
});

test('latest matching inviter is checked instead of an earlier developer entry', async () => {
    const f = inviterFixture();
    const joined = f.guild.members.me.joinedTimestamp;
    f.guild.fetchAuditLogs = async () => ({ entries: new Collection([
            ['old', { action: 28, targetId: f.bot, executorId: developer, createdTimestamp: joined - 500 }],
            ['current', { action: 28, targetId: f.bot, executorId: '223456789012345678', createdTimestamp: joined }],
        ]) });
    try {
        await f.lifecycle.joined(f.guild, true);
        assert.equal(f.store.isAuthorized(f.guild.id), false);
    } finally {
        f.close();
    }
});

test('delayed audit entry receives bounded retries before developer authorization', async () => {
    const f = inviterFixture();
    const fetch = f.guild.fetchAuditLogs;
    let calls = 0;
    f.guild.fetchAuditLogs = async () => ++calls === 1 ? { entries: new Collection() } : fetch();
    try {
        await f.lifecycle.joined(f.guild, true);
        assert.equal(calls, 2);
        assert.equal(f.store.isAuthorized(f.guild.id), true);
    } finally {
        f.close();
    }
});

test('developer inviter does not override a server ban', async () => {
    const f = inviterFixture();
    try {
        f.store.run('INSERT INTO server_bans VALUES(?,?,?,?,?)', f.guild.id, f.guild.name, 'test', developer, Date.now());
        await f.lifecycle.joined(f.guild, true);
        assert.equal(f.reads(), 0);
        assert.equal(f.store.authorization(f.guild.id)!.state, 'BANNED');
        assert.equal(f.counts().leaves, 1);
    } finally {
        f.close();
    }
});

test('startup verifies the original developer invite before expiring an offline pending server', async () => {
    const f = inviterFixture();
    try {
        // Previously persisted pending installation; original join is still audited.
        f.guild.members.me.joinedTimestamp -= 180000;
        const joined = f.guild.members.me.joinedTimestamp;
        f.store.run("INSERT INTO guild_authorization(guild_id,name,state,joined_at,deadline) VALUES(?,?,'PENDING_AUTHORIZATION',?,?)", f.guild.id, f.guild.name, joined, joined + 120000);
        await f.lifecycle.joined(f.guild);
        assert.equal(f.store.isAuthorized(f.guild.id), true);
        assert.equal(f.lifecycle.isReady(f.guild.id), true);
    } finally {
        f.close();
    }
});

test('automatic developer authorization persists across real database reopening', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-dev-invite-'));
    const path = join(dir, 'db');
    try {
        let f = inviterFixture(developer, 0, path);
        await f.lifecycle.joined(f.guild, true);
        f.close();
        f = inviterFixture('223456789012345678', 0, path);
        try {
            await f.lifecycle.joined(f.guild);
            assert.equal(f.store.authorization(f.guild.id)!.authorized_by, developer);
            assert.equal(f.lifecycle.isReady(f.guild.id), true);
            assert.equal(f.reads(), 0);
            assert.equal(f.counts().leaves, 0);
        } finally {
            f.close();
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('revocation during inviter lookup cannot be overridden by automatic authorization', async () => {
    const f = inviterFixture();
    const fetch = f.guild.fetchAuditLogs;
    f.guild.fetchAuditLogs = async () => {
        await f.lifecycle.deauthorize(f.guild, developer);
        return fetch();
    };
    try {
        await f.lifecycle.joined(f.guild, true);
        await f.lifecycle.queue.run(f.guild.id, async () => { });
        assert.equal(f.store.authorization(f.guild.id)!.state, 'DEAUTHORIZED');
        assert.equal(f.counts().init, 0);
    } finally {
        f.close();
    }
});
