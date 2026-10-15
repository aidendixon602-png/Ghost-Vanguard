import test from 'node:test';
import assert from 'node:assert/strict';
import { authorize } from './helpers.js';
import { Store } from '../src/database/db.js';
import { Registry } from '../src/bot/registry.js';
import { registerDangerConfirm } from '../src/ui/danger-ui.js';
import { createBan, TAG } from '../src/security/network-ban.js';
import { appealBlock, registerAppealControls } from '../src/features/appeals.js';
import { sweepTempbans } from '../src/security/raidmode.js';
import tempbanCommand from '../src/commands/moderation/tempban.js';
import softbanCommand from '../src/commands/moderation/softban.js';
import massbanCommand from '../src/commands/security/massban.js';

/**
 * The 2.21 ban commands (tempban, softban, massban) and the other paths that can lift a
 * ban (appeals, tempban expiry): every one shows loading and a clear result, and none
 * may lift a genreban or hardban.
 */

const TARGET = '400000000000000001';
const DEV = '1277709272041394187';
const G = '500000000000000001';

function world(o: { bans?: Record<string, string>; unbanFails?: boolean; banError?: unknown } = {}) {
    const store = new Store(':memory:');
    authorize(store, G);
    const bans = new Map(Object.entries(o.bans ?? {}));
    const calls = { banned: [] as string[], unbanned: [] as string[] };
    const above = { comparePositionTo: () => 1 };
    const actor: any = { id: 'mod', roles: { cache: new Map(), highest: above }, permissions: { has: () => true } };
    const me: any = { id: 'bot', roles: { highest: above }, permissions: { has: () => true } };
    const guild: any = {
        id: G, name: 'Test', ownerId: 'owner',
        members: {
            me, cache: new Map(),
            fetchMe: async () => me,
            fetch: async ({ user }: any) => { if (user === 'mod') return actor; throw { code: 10007 }; },
            ban: async (id: string, opts: any) => { if (o.banError) throw o.banError; calls.banned.push(id); bans.set(id, opts.reason); },
            unban: async (id: string) => { if (o.unbanFails) throw { code: 50013 }; calls.unbanned.push(id); bans.delete(id); },
        },
        bans: {
            fetch: async (q: any) => {
                if (q?.user) { if (!bans.has(q.user)) throw { code: 10026 }; return { reason: bans.get(q.user) }; }
                return new Map([...bans.keys()].map(k => [k, { reason: bans.get(k) }]));
            },
            remove: async (id: string) => { calls.unbanned.push(id); bans.delete(id); },
        },
    };
    actor.guild = guild;
    const replies: any[] = [], clickReplies: any[] = [];
    const user = { id: TARGET, tag: 'raider', username: 'raider', send: async () => { throw new Error('closed'); } };
    const interaction = (options: Record<string, unknown>) => ({
        guild, guildId: G, channelId: 'c', user: { id: 'mod' }, replies, inCachedGuild: () => true, member: actor,
        editReply: async (p: any) => void replies.push(p),
        options: {
            getUser: () => user, getString: (k: string) => options[k] ?? null, getInteger: (k: string) => options[k] ?? null,
        },
    }) as any;
    const click: any = { guild, guildId: G, user: { id: 'mod' }, inCachedGuild: () => true, member: actor, replies: clickReplies, editReply: async (p: any) => void clickReplies.push(p) };
    const logged: string[] = [];
    const ctx: any = { store, actor, logs: { push: (_g: string, e: any) => void logged.push(String(e.data.title)) }, security: { trusted: () => false } };
    const registry = new Registry();
    registerDangerConfirm(registry);
    const confirm = registry.components.find(c => c.prefix === 'dangerconfirm:')!;
    const run = async (def: any, options: Record<string, unknown>, beforeConfirm?: () => void) => {
        ctx.policy = def.metadata; ctx.actionKey = def.data.name;
        await def.execute(ctx, interaction(options));
        beforeConfirm?.();
        click.customId = String(replies.at(-1).components[0].components[0].data.custom_id);
        await confirm.execute(ctx, click);
    };
    return { store, guild, calls, bans, replies, clickReplies, logged, ctx, run, actor };
}

const title = (p: any) => String(p.embeds[0].data.title);

for (const command of [tempbanCommand, softbanCommand]) {
    for (const change of ['target promoted', 'moderator demoted', 'bot lowered', 'owner changed', 'membership unavailable'] as const) {
        test(`/mod ${command.data.name} rechecks target safety on confirmation: ${change}`, async () => {
            const w = world();
            const positions = { actor: 10, bot: 20 };
            const target = { id: TARGET, roles: { highest: { position: 1 } } };
            w.actor.roles.highest = { comparePositionTo: (role: any) => positions.actor - role.position };
            w.guild.members.me.roles.highest = { comparePositionTo: (role: any) => positions.bot - role.position };
            let unavailable = false;
            w.guild.members.fetch = async ({ user, force }: any) => {
                assert.equal(force, true);
                if (user === 'mod') return w.actor;
                if (unavailable) throw { code: 50013 };
                return target;
            };
            try {
                await w.run(command, { duration: 24, reason: 'test' }, () => {
                    if (change === 'target promoted') target.roles.highest.position = 10;
                    if (change === 'moderator demoted') positions.actor = 1;
                    if (change === 'bot lowered') positions.bot = 1;
                    if (change === 'owner changed') w.guild.ownerId = TARGET;
                    if (change === 'membership unavailable') unavailable = true;
                });
                assert.deepEqual(w.calls.banned, [], 'no ban after the target safety check becomes invalid');
                assert.deepEqual(w.calls.unbanned, []);
                assert.equal(w.store.readGuild(G, () => w.store.get('SELECT COUNT(*) AS n FROM cases WHERE guild_id=?', G))!.n, 0);
                assert.equal(w.store.readGuild(G, () => w.store.get('SELECT COUNT(*) AS n FROM tempbans WHERE guild_id=?', G))!.n, 0);
                const text = JSON.stringify(w.clickReplies.at(-1));
                assert.match(text, /equal or higher role|role hierarchy|server owner|Could not confirm target membership/);
            } finally { w.store.close(); }
        });
    }
    test(`/mod ${command.data.name} still accepts a safe target after confirmation`, async () => {
        const w = world();
        const target = { id: TARGET, roles: { highest: {} } };
        w.guild.members.fetch = async ({ user }: any) => user === 'mod' ? w.actor : target;
        try {
            await w.run(command, { duration: 24, reason: 'test' });
            assert.deepEqual(w.calls.banned, [TARGET]);
            assert.equal(w.store.readGuild(G, () => w.store.get('SELECT COUNT(*) AS n FROM cases WHERE guild_id=?', G))!.n, 1);
        } finally { w.store.close(); }
    });
}

test('/mod massban refuses confirmation after the moderator loses whitelist access', async () => {
    const w = world();
    let trusted = true;
    w.store.grant(G, 'mod', 'admin', 'owner');
    w.ctx.security.trusted = (_guild: any, id: string) => id === 'mod' && trusted;
    try {
        await assert.rejects(w.run(massbanCommand, { user_ids: TARGET }, () => { trusted = false; }), /Mass bans are limited/);
        assert.deepEqual(w.calls.banned, []);
        assert.equal(w.store.readGuild(G, () => w.store.get('SELECT COUNT(*) AS n FROM cases WHERE guild_id=?', G))!.n, 0);
    } finally { w.store.close(); }
});

for (const change of ['whitelisted', 'server owner'] as const)
test(`/mod massban protects a target who becomes ${change} before confirmation`, async () => {
    const w = world();
    let protectedTarget = false;
    w.store.grant(G, 'mod', 'admin', 'owner');
    w.ctx.security.trusted = (_guild: any, id: string) => id === 'mod' || id === TARGET && protectedTarget;
    try {
        await w.run(massbanCommand, { user_ids: TARGET }, () => {
            if (change === 'whitelisted') protectedTarget = true;
            else w.guild.ownerId = TARGET;
        });
        assert.deepEqual(w.calls.banned, []);
        assert.equal(w.store.readGuild(G, () => w.store.get('SELECT COUNT(*) AS n FROM cases WHERE guild_id=?', G))!.n, 0);
        assert.match(JSON.stringify(w.clickReplies.at(-1)), /protected/i);
    } finally { w.store.close(); }
});

test('/mod massban rechecks protection for each account while the batch is running', async () => {
    const w = world();
    const first = '400000000000000002';
    let protectedTarget = false;
    w.store.grant(G, 'mod', 'admin', 'owner');
    w.ctx.security.trusted = (_guild: any, id: string) => id === 'mod' || id === TARGET && protectedTarget;
    const ban = w.guild.members.ban;
    w.guild.members.ban = async (id: string, options: any) => {
        await ban(id, options);
        protectedTarget = true;
    };
    try {
        await w.run(massbanCommand, { user_ids: `${first} ${TARGET}` });
        assert.deepEqual(w.calls.banned, [first]);
        assert.equal(w.store.readGuild(G, () => w.store.get('SELECT COUNT(*) AS n FROM cases WHERE guild_id=?', G))!.n, 1);
        assert.match(JSON.stringify(w.clickReplies.at(-1)), /protected/i);
    } finally { w.store.close(); }
});

test('/mod tempban shows loading, then success; a user already banned is reported, not re-banned', async () => {
    let w = world();
    await w.run(tempbanCommand, { duration: 24, reason: 'spam' });
    assert.match(title(w.clickReplies[0]), /^⏳ Banning raider for 1 day/);
    assert.match(title(w.clickReplies.at(-1)), /^✅ Tempban succeeded: raider/);
    assert.deepEqual(w.calls.banned, [TARGET]);
    w.store.close();

    w = world({ bans: { [TARGET]: `${TAG.hardban} HB-00001 ${DEV}: raiding` } });
    await w.run(tempbanCommand, { duration: 24, reason: 'spam' });
    assert.match(title(w.clickReplies.at(-1)), /already done/);
    assert.match(String(w.clickReplies.at(-1).embeds[0].data.description), /by a Midtown Vanguard hardban/);
    assert.equal(w.store.get('SELECT COUNT(*) AS n FROM tempbans')!.n, 0, 'no tempban or case was recorded');
    w.store.close();
});

test('/mod softban never runs on someone already banned, so it cannot lift their ban', async () => {
    const w = world({ bans: { [TARGET]: `${TAG.genreban} GB-00001 ${DEV}: raiding` } });
    await w.run(softbanCommand, { reason: 'spam' });
    assert.match(String(w.clickReplies.at(-1).embeds[0].data.description), /already banned. A softban ends by unbanning/);
    assert.deepEqual(w.calls.unbanned, [], 'the existing ban was not lifted');
    w.store.close();
});

test('/mod softban says plainly when the second half failed and they are still banned', async () => {
    const w = world({ unbanFails: true });
    await w.run(softbanCommand, { reason: 'spam' });
    assert.match(title(w.clickReplies[0]), /^⏳ Softbanning raider/);
    assert.match(title(w.clickReplies.at(-1)), /^✕ Failed/);
    assert.match(String(w.clickReplies.at(-1).embeds[0].data.description), /they are still banned/);
    w.store.close();
});

test('/mod massban shows progress and a partial result with each failed account', async () => {
    const ok = '400000000000000011', already = '400000000000000012';
    const w = world({ bans: { [already]: 'mod: earlier' } });
    w.guild.members.ban = async (id: string) => { if (id === '400000000000000013') throw { code: 50013 }; w.calls.banned.push(id); };
    w.ctx.security.trusted = () => false;
    w.actor.id = 'owner';
    w.guild.members.fetch = async () => w.actor;
    await w.run(massbanCommand, { user_ids: `${ok} ${already} 400000000000000013`, reason: 'raid' });
    const last = w.clickReplies.at(-1);
    assert.match(title(w.clickReplies[0]), /^⏳ Mass-banning 3 account/);
    assert.match(title(last), /^⚠ Mass ban partially succeeded: 2 of 3 accounts/);
    assert.match(String(last.embeds[0].data.description), /400000000000000013`\*\* · Missing permissions/);
    assert.deepEqual(w.calls.banned, [ok], 'the already-banned account was not banned again');
    assert.equal(w.store.readGuild(G, () => w.store.get('SELECT reason FROM ban_records WHERE guild_id=? AND user_id=?', G, already))!.reason, 'raid', 'their ban record now has the reason');
    assert.equal(w.store.readGuild(G, () => w.store.get('SELECT COUNT(*) AS n FROM cases WHERE guild_id=? AND user_id=?', G, already))!.n, 1, 'the reason is recorded for the already-banned account');
    w.store.close();
});

test('/mod tempban on someone already banned puts an end date on their ban instead of refusing', async () => {
    const w = world({ bans: { [TARGET]: 'Banned by hand' } });
    await w.run(tempbanCommand, { duration: 24, reason: 'cooling off' });
    const text = JSON.stringify(w.clickReplies.at(-1));
    assert.match(text, /already banned/); assert.match(text, /ends automatically/);
    assert.deepEqual(w.calls.banned, [], 'no second ban');
    const row = w.store.readGuild(G, () => w.store.get('SELECT until FROM tempbans WHERE guild_id=? AND user_id=?', G, TARGET))!;
    assert.ok(Number(row.until) > Date.now() + 23 * 3600000, 'the unban is scheduled');
    const record = w.store.readGuild(G, () => w.store.get('SELECT kind,expires_at FROM ban_records WHERE guild_id=? AND user_id=?', G, TARGET))!;
    assert.equal(record.kind, 'tempban'); assert.ok(record.expires_at);
    w.store.close();

    const n = world({ bans: { [TARGET]: `${TAG.hardban} HB-00001 ${DEV}: raiding` } });
    await n.run(tempbanCommand, { duration: 24, reason: 'cooling off' });
    assert.match(JSON.stringify(n.clickReplies.at(-1)), /only a developer can change/);
    assert.equal(n.store.readGuild(G, () => n.store.get('SELECT COUNT(*) AS n FROM tempbans WHERE guild_id=?', G))!.n, 0, 'a hardban never gets a timer');
    n.store.close();
});

test('appeals cannot reach a genreban or hardban', async () => {
    const w = world({ bans: { [TARGET]: `${TAG.hardban} HB-00001 ${DEV}: raiding` } });
    const ban = createBan(w.store, { kind: 'hardban', user: { id: TARGET, tag: 'raider' }, reason: 'raiding', moderator: { id: DEV } });
    assert.match(String(w.store.readGuild(G, () => appealBlock(w.store, G, TARGET))), /cannot be appealed here/);
    // A pending appeal from before the hardban cannot be accepted either.
    const id = Number(w.store.run("INSERT INTO appeals(guild_id,user_id,text,status,at) VALUES(?,?,?,'pending',?)", G, TARGET, 'please', Date.now()).lastInsertRowid);
    const registry = new Registry();
    registerAppealControls(registry);
    const accept = registry.components.find(c => c.prefix === 'appeal:')!;
    const button: any = { customId: `appeal:accept:${G}:${id}`, guild: w.guild, guildId: G, client: { users: { fetch: async () => null } } };
    await assert.rejects(w.store.withAuthorized(G, () => accept.execute(w.ctx, button)), /active hardban.*HB-0000/s);
    assert.deepEqual(w.calls.unbanned, []);
    assert.ok(ban);
    w.store.close();
});

test('an expiring tempban does not lift a genreban or hardban placed since', async () => {
    const w = world({ bans: { [TARGET]: 'mod: tempban 1 day: spam' } });
    w.store.run('INSERT OR IGNORE INTO guild_data(guild_id) VALUES(?)', G);
    w.store.run('INSERT INTO tempbans VALUES(?,?,?,?,?,?)', G, TARGET, Date.now() - 1000, 'mod', 'spam', 1);
    createBan(w.store, { kind: 'genreban', user: { id: TARGET, tag: 'raider' }, reason: 'raiding', moderator: { id: DEV } });
    const client: any = { guilds: { cache: new Map([[G, w.guild]]) }, user: { id: 'bot' } };
    await sweepTempbans(w.store, w.ctx.logs, client, () => true);
    assert.deepEqual(w.calls.unbanned, [], 'still banned');
    assert.equal(w.store.get('SELECT COUNT(*) AS n FROM tempbans')!.n, 0, 'the finished tempban is cleared');
    assert.match(w.logged.at(-1)!, /still banned/);
    w.store.close();
});

test('ban reasons are optional: an empty reason is recorded as "No reason given"', async () => {
    const w = world();
    await w.run(tempbanCommand, { duration: 24 });
    assert.match(title(w.clickReplies.at(-1)), /^✅ Tempban succeeded/);
    assert.equal(w.store.readGuild(G, () => w.store.get('SELECT reason FROM cases WHERE guild_id=?', G))!.reason, 'No reason given');
    w.store.close();
});
