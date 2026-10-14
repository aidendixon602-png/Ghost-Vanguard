import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionFlagsBits } from 'discord.js';
import { authorize } from './helpers.js';
import { Store } from '../src/database/db.js';
import { config } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { Registry } from '../src/bot/registry.js';
import { Guard } from '../src/bot/guard.js';
import {
    activeBan, activeException, addException, assertTargetable, banEverywhere, banIn, createBan, enforceOnJoin, enforceOnUnban, parseUserId, resolveTarget, revokeBan,
    serverResults, sweepNetworkBans, TAG, unbanEverywhere, type NetworkDeps,
} from '../src/security/network-ban.js';
import { issueCommand, revokeCommand } from '../src/security/network-commands.js';
import { overall, summaryEmbed } from '../src/ui/network-ui.js';
import { classify } from '../src/ui/progress.js';
import { registerDangerConfirm } from '../src/ui/danger-ui.js';
import moderationCommand from '../src/commands/moderation/moderation.js';

const TARGET = '400000000000000001';
const DEV = '1277709272041394187';
config.developers.add(DEV);

/** A clicked button the permission guard can check, as Discord would send it. */
function clickFor(userId: string, guildId: string, replies: any[], who?: any) {
    const member: any = who ?? { id: userId, guild: { id: guildId, ownerId: 'owner' }, roles: { cache: new Map() }, permissions: { has: () => true } };
    return { inCachedGuild: () => true, member, user: { id: userId, tag: userId === DEV ? 'dev' : userId }, guildId, replies, customId: '',
        guild: { id: guildId, ownerId: 'owner', members: { me: { permissions: { has: () => true } }, fetch: async () => member } },
        editReply: async (p: any) => void replies.push(p) } as any;
}

// ---------------------------------------------------------------- fakes

/** Everything the fakes did, in order, so a test can check what happened first. */
const order: string[] = [];

interface FakeOptions {
    canBan?: boolean;
    botAbove?: boolean;
    owner?: string;
    member?: boolean;
    banError?: unknown;
    bans?: Record<string, string>;
    cached?: { id: string; username: string; globalName?: string }[];
}

function fakeGuild(id: string, name: string, o: FakeOptions = {}) {
    const bans = new Map<string, string>(Object.entries(o.bans ?? {}));
    const calls = { banned: [] as any[], unbanned: [] as string[] };
    const me = { permissions: { has: (p: bigint) => p === PermissionFlagsBits.BanMembers ? o.canBan !== false : true }, roles: { highest: { comparePositionTo: () => o.botAbove === false ? -1 : 1 } } };
    const cache = new Map((o.cached ?? []).map(u => [u.id, { id: u.id, nickname: null, user: { ...u, tag: u.username } }]));
    if (o.member)
        cache.set(TARGET, { id: TARGET, nickname: null, user: { id: TARGET, username: 'raider', tag: 'raider' } as any });
    const guild: any = {
        id, name, ownerId: o.owner ?? 'someone-else',
        members: {
            me,
            cache,
            fetchMe: async () => me,
            fetch: async ({ user }: { user: string }) => {
                if (cache.has(user))
                    return { id: user, roles: { highest: {} } };
                throw { code: 10007 };
            },
            search: async () => new Map(),
            ban: async (user: string, options: any) => {
                if (o.banError)
                    throw o.banError;
                order.push(`ban:${name}`);
                calls.banned.push({ user, ...options });
                bans.set(user, options.reason);
            },
            unban: async (user: string) => {
                calls.unbanned.push(user);
                bans.delete(user);
            },
        },
        bans: {
            fetch: async (q: any) => {
                if (q?.user) {
                    if (!bans.has(q.user))
                        throw { code: 10026 };
                    return { user: { id: q.user }, reason: bans.get(q.user) };
                }
                return new Map([...bans.keys()].map(k => [k, {}]));
            },
        },
    };
    return { guild, calls, bans };
}

function network(guilds: any[], store = new Store(':memory:')) {
    for (const g of guilds)
        authorize(store, g.id);
    const logged: string[] = [], dms: any[] = [];
    const users: Record<string, any> = { [TARGET]: { id: TARGET, username: 'raider', tag: 'raider', createdTimestamp: Date.now(), send: async (m: any) => { order.push('dm'); dms.push(m); } } };
    const deps: NetworkDeps = {
        client: {
            guilds: { cache: new Map(guilds.map(g => [g.id, g])) }, user: { id: 'bot' },
            users: { fetch: async (id: string) => { if (users[id]) return users[id]; throw { code: 10013 }; } },
        } as any,
        store,
        logs: { push: (guildId: string, e: any) => void logged.push(`${guildId}:${e.data.title}\n${e.data.description}`) } as any,
        isReady: () => true,
    };
    return { deps, store, logged, dms };
}

const newBan = (store: Store, kind: 'genreban' | 'hardban' = 'genreban') =>
    createBan(store, { kind, user: { id: TARGET, tag: 'raider' }, reason: 'raiding', evidence: 'https://example.com/clip', moderator: { id: DEV, tag: 'dev' } });

// ---------------------------------------------------------------- finding the target

test('user IDs are accepted as raw IDs or mentions, and bad IDs are explained', () => {
    assert.equal(parseUserId(TARGET), TARGET);
    assert.equal(parseUserId(`<@${TARGET}>`), TARGET);
    assert.equal(parseUserId(` <@!${TARGET}> `), TARGET);
    assert.throws(() => parseUserId('12345'), /not a valid Discord user ID.*17–20 digits/s);
});

test('a target is found by ID even outside every server, or by exact username among members', async () => {
    const g = fakeGuild('100000000000000001', 'Alpha', { cached: [{ id: '400000000000000002', username: 'someone', globalName: 'Some One' }] });
    const { deps, store } = network([g.guild]);
    assert.equal((await resolveTarget(deps, TARGET)).id, TARGET, 'an ID works for a user in no server');
    assert.equal((await resolveTarget(deps, '@someone')).id, '400000000000000002');
    assert.equal((await resolveTarget(deps, 'Some One')).id, '400000000000000002', 'an unambiguous display name works too');
    await assert.rejects(resolveTarget(deps, '499999999999999999'), /No Discord account has the user ID/);
    await assert.rejects(resolveTarget(deps, 'nobody_here'), /Could not find anyone called.*user ID instead/s);
    store.close();
});

test('an ambiguous display name lists the candidates instead of guessing', async () => {
    const g = fakeGuild('100000000000000001', 'Alpha', { cached: [
        { id: '400000000000000002', username: 'alpha1', globalName: 'Sam' },
        { id: '400000000000000003', username: 'alpha2', globalName: 'Sam' },
    ] });
    const { deps, store } = network([g.guild]);
    await assert.rejects(resolveTarget(deps, 'Sam'), /More than one person matches.*400000000000000002.*400000000000000003/s);
    store.close();
});

test('network bans refuse to target the actor, the bot, or a developer', () => {
    const previous = config.developers;
    config.developers = new Set([DEV]);
    try {
        const client: any = { user: { id: 'bot' } };
        assert.throws(() => assertTargetable(client, 'me', 'me'), /yourself/);
        assert.throws(() => assertTargetable(client, 'bot', 'me'), /itself/);
        assert.throws(() => assertTargetable(client, DEV, 'me'), /developer/);
        assert.doesNotThrow(() => assertTargetable(client, TARGET, 'me'));
    } finally {
        config.developers = previous;
    }
});

// ---------------------------------------------------------------- records

test('records keep who, why, evidence and when, refuse duplicates, and survive revocation', () => {
    const store = new Store(':memory:');
    const ban = newBan(store);
    assert.equal(ban.username, 'raider');
    assert.equal(ban.evidence, 'https://example.com/clip');
    assert.equal(ban.moderator_id, DEV);
    assert.ok(ban.created_at > 0);
    assert.throws(() => newBan(store), /already has an active genreban.*No duplicate/);
    assert.throws(() => store.run("INSERT INTO network_bans(kind,user_id,reason,moderator_id,created_at) VALUES('genreban',?,?,?,?)", TARGET, 'x', DEV, 1), /UNIQUE/, 'the database itself refuses a second active ban');
    assert.ok(newBan(store, 'hardban'), 'a different ban type is a separate record');
    assert.equal(revokeBan(store, ban, { id: DEV }, 'appeal'), true);
    assert.equal(revokeBan(store, ban, { id: DEV }, 'again'), false, 'revoking twice does nothing');
    const kept = store.get('SELECT * FROM network_bans WHERE id=?', ban.id)!;
    assert.equal(kept.status, 'revoked');
    assert.equal(kept.revoke_reason, 'appeal');
    assert.ok(newBan(store), 'after revocation a new genreban can be issued');
    store.close();
});

test('active bans persist through a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vanguard-netban-'));
    try {
        const path = join(dir, 'v.db');
        let store = new Store(path);
        newBan(store, 'hardban');
        store.close();
        store = new Store(path);
        assert.ok(activeBan(store, 'hardban', TARGET), 'the hardban is still active after reopening the database');
        store.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------- applying

test('a genreban reports each server clearly and records every outcome', async () => {
    const ok = fakeGuild('100000000000000001', 'Alpha');
    const member = fakeGuild('100000000000000002', 'Bravo', { member: true });
    const noPerm = fakeGuild('100000000000000003', 'Charlie', { canBan: false });
    const below = fakeGuild('100000000000000004', 'Delta', { member: true, botAbove: false });
    const owner = fakeGuild('100000000000000005', 'Echo', { owner: TARGET });
    const refused = fakeGuild('100000000000000006', 'Foxtrot', { banError: { code: 50013 } });
    const broken = fakeGuild('100000000000000007', 'Golf', { banError: new Error('boom') });
    const staff = fakeGuild('100000000000000008', 'Hotel', { bans: { [TARGET]: 'mod: spam' } });
    const { deps, store, logged } = network([ok, member, noPerm, below, owner, refused, broken, staff].map(g => g.guild));
    const ban = newBan(store);
    const progress: number[] = [];
    const results = await banEverywhere(deps, ban, 3600, done => void progress.push(done));
    assert.deepEqual(Object.fromEntries(results.map(r => [r.name, r.outcome])), {
        Alpha: 'success', Bravo: 'success', Charlie: 'missing-permissions', Delta: 'hierarchy',
        Echo: 'not-allowed', Foxtrot: 'missing-permissions', Golf: 'failed', Hotel: 'success',
    });
    assert.match(results.find(r => r.name === 'Hotel')!.reason, /Already banned here; the genreban now covers that ban too/);
    assert.match(results.find(r => r.name === 'Alpha')!.reason, /by user ID/);
    assert.ok(results.find(r => r.name === 'Golf')!.reference, 'unexpected errors carry a log reference');
    assert.deepEqual(progress, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(ok.calls.banned[0].deleteMessageSeconds, 3600);
    assert.ok(String(ok.calls.banned[0].reason).startsWith(TAG.genreban), 'the bot tags its own bans with the ban type');
    assert.equal(staff.calls.banned.length, 0, 'an existing staff ban is not replaced');
    const covered = store.readGuild(staff.guild.id, () => store.get('SELECT * FROM ban_records WHERE guild_id=? AND user_id=?', staff.guild.id, TARGET))!;
    assert.deepEqual([covered.kind, covered.network_record, covered.status], ['genreban', 'GB-00001', 'banned'], 'its ban record now shows the genreban');
    assert.equal(logged.length, 2, 'only servers that actually banned are told');
    assert.match(logged[0]!, /\*\*Server:\*\* Alpha \(`100000000000000001`\)/, 'each log names its server and server ID');
    assert.match(logged[1]!, /\*\*Server:\*\* Bravo \(`100000000000000002`\)/);
    assert.equal(serverResults(store, ban.id).length, 8, 'every server\'s outcome is saved with the record');
    const caseRow = store.readGuild(ok.guild.id, () => store.get('SELECT * FROM cases WHERE guild_id=? AND user_id=?', ok.guild.id, TARGET))!;
    assert.equal(caseRow.username, 'raider');
    assert.equal(caseRow.evidence, 'https://example.com/clip');
    const summary = summaryEmbed({ working: 'x', verb: 'Banned', action: 'Genreban GB-00001', header: 'h' }, results).toJSON();
    assert.match(String(summary.title), /^⚠ Genreban GB-00001 partially succeeded: 3 of 8 servers/);
    assert.match(String(summary.description), /Failed: \*\*5\*\*/);
    assert.match(String(summary.description), /Charlie\*\* · Missing permissions/);
    assert.match(String(summary.description), /Delta\*\* · Role hierarchy/);
    store.close();
});

test('the overall result is success, partial, failed or unchanged, never a false success', () => {
    const r = (outcome: any) => ({ guildId: 'g', name: 'A', outcome, reason: 'r' });
    assert.equal(overall([r('success'), r('already')]), 'succeeded');
    assert.equal(overall([r('success'), r('missing-permissions')]), 'partial');
    assert.equal(overall([r('hierarchy'), r('failed')]), 'failed');
    assert.equal(overall([r('skipped')]), 'unchanged');
    assert.equal(overall([]), 'none');
    const view = { working: 'x', verb: 'Banned', action: 'Hardban HB-00001', header: 'h' };
    assert.match(String(summaryEmbed(view, [r('success'), r('success')]).toJSON().title), /^✅ Hardban HB-00001 succeeded in all 2 servers/);
    assert.match(String(summaryEmbed(view, [r('missing-permissions')]).toJSON().title), /^✕ Hardban HB-00001 failed in all 1 server/);
});

test('a ban revoked while a run is in progress is not applied to the remaining servers', async () => {
    const g = fakeGuild('100000000000000001', 'Alpha');
    const { deps, store } = network([g.guild]);
    const ban = newBan(store, 'hardban');
    revokeBan(store, ban, { id: DEV }, 'mistake');
    const result = await banIn(deps, g.guild, ban, 'sweep');
    assert.equal(result.outcome, 'skipped');
    assert.equal(g.calls.banned.length, 0);
    store.close();
});

// ---------------------------------------------------------------- lifting

test('each unban only lifts its own ban type, never staff bans or the other type', async () => {
    const gen = fakeGuild('100000000000000011', 'Gen', { bans: { [TARGET]: `${TAG.genreban} GB-00001 ${DEV}: raiding` } });
    const hard = fakeGuild('100000000000000013', 'Hard', { bans: { [TARGET]: `${TAG.hardban} HB-00001 ${DEV}: raiding` } });
    const staff = fakeGuild('100000000000000014', 'Staff', { bans: { [TARGET]: 'mod: spamming' } });
    const none = fakeGuild('100000000000000015', 'None');
    const { deps, store } = network([gen, hard, staff, none].map(g => g.guild));
    const ban = newBan(store);
    revokeBan(store, ban, { id: DEV }, 'appeal');
    const results = await unbanEverywhere(deps, ban, 'appeal accepted', DEV);
    assert.deepEqual(Object.fromEntries(results.map(r => [r.name, r.outcome])), { Gen: 'success', Hard: 'skipped', None: 'skipped', Staff: 'skipped' });
    assert.deepEqual(hard.calls.unbanned, [], 'a genreban unban never lifts a hardban');
    assert.deepEqual(staff.calls.unbanned, [], 'a server\'s own ban is never lifted');
    store.close();
});

// ---------------------------------------------------------------- enforcement

test('active genrebans and hardbans are enforced when the user joins', async () => {
    const g = fakeGuild('100000000000000021', 'Alpha', { member: true });
    const { deps, store, logged } = network([g.guild]);
    assert.equal(await enforceOnJoin(deps, g.guild, TARGET), false, 'nothing happens without an active ban');
    const ban = newBan(store);
    assert.equal(await enforceOnJoin(deps, g.guild, TARGET), true);
    assert.ok(String(g.calls.banned[0].reason).startsWith(TAG.genreban));
    assert.match(logged[0]!, /Genreban re-applied/);
    revokeBan(store, ban, { id: DEV }, 'appeal');
    assert.equal(await enforceOnJoin(deps, g.guild, TARGET), false, 'a revoked genreban is not enforced');
    newBan(store, 'hardban');
    assert.equal(await enforceOnJoin(deps, g.guild, TARGET), true);
    assert.ok(String(g.calls.banned[1].reason).startsWith(TAG.hardban));
    store.close();
});

test('a hardban is re-applied on unban; a genreban is not, and nothing happens once revoked', async () => {
    const g = fakeGuild('100000000000000022', 'Alpha');
    const { deps, store } = network([g.guild]);
    newBan(store);
    assert.equal(await enforceOnUnban(deps, g.guild, TARGET), false, 'unban enforcement is for hardbans only');
    const hard = newBan(store, 'hardban');
    assert.equal(await enforceOnUnban(deps, g.guild, TARGET), true);
    revokeBan(store, hard, { id: DEV }, 'appeal');
    assert.equal(await enforceOnUnban(deps, g.guild, TARGET), false);
    store.close();
});

test('the sweep bans hardbanned users wherever they are missing, and removes genrebanned members', async () => {
    const missing = fakeGuild('100000000000000031', 'Missing');
    const present = fakeGuild('100000000000000032', 'Present', { bans: { [TARGET]: 'already' } });
    const refuses = fakeGuild('100000000000000033', 'Refuses', { canBan: false });
    const { deps, store } = network([missing, present, refuses].map(g => g.guild));
    assert.equal(await sweepNetworkBans(deps), 0, 'nothing to do with no bans');
    newBan(store, 'hardban');
    assert.equal(await sweepNetworkBans(deps), 1);
    assert.equal(missing.calls.banned.length, 1);
    assert.equal(present.calls.banned.length, 0);
    assert.equal(refuses.calls.banned.length, 0);
    assert.equal(await sweepNetworkBans(deps), 0, 'a second sweep finds nothing left to do');
    store.close();

    const member = fakeGuild('100000000000000034', 'Member', { member: true });
    const absent = fakeGuild('100000000000000035', 'Absent');
    const n = network([member, absent].map(g => g.guild));
    newBan(n.store);
    assert.equal(await sweepNetworkBans(n.deps), 1, 'a genrebanned member is removed');
    assert.equal(absent.calls.banned.length, 0, 'a genreban does not re-ban non-members on a sweep');
    n.store.close();
});

test('ban errors are sorted into permissions, hierarchy, invalid user, already done and other failures', () => {
    assert.equal(classify({ code: 50013 }).outcome, 'missing-permissions');
    assert.equal(classify({ code: 10013 }).outcome, 'invalid-target');
    assert.equal(classify(new AppError('VALIDATION_ERROR', 'Move the bot role above the target’s roles first.')).outcome, 'hierarchy');
    assert.equal(classify(new AppError('VALIDATION_ERROR', 'The target has an equal or higher role than you.')).outcome, 'hierarchy');
    assert.equal(classify(new AppError('VALIDATION_ERROR', '`12` is not a valid Discord user ID.')).outcome, 'invalid-target');
    assert.equal(classify(new AppError('VALIDATION_ERROR', 'That user is already banned here.')).outcome, 'already');
    assert.equal(classify({ status: 429 }).outcome, 'rate-limited');
    const other = classify(new Error('boom'), 'test');
    assert.equal(other.outcome, 'failed');
    assert.match(String(other.reference), /^MV-CMD-/);
});

// ---------------------------------------------------------------- commands

test('every genreban and hardban command is developer-only', () => {
    for (const def of [issueCommand('genreban'), issueCommand('hardban'), revokeCommand('genreban'), revokeCommand('hardban')])
        assert.equal(def.metadata.developerOnly, true, `${def.data.name} must be developer-only`);
    assert.deepEqual([issueCommand('genreban'), revokeCommand('genreban'), issueCommand('hardban'), revokeCommand('hardban')].map(d => d.data.name), ['genreban', 'ungenreban', 'hardban', 'unhardban']);
    const previous = config.developers;
    config.developers = new Set([DEV]);
    const store = new Store(':memory:');
    try {
        const guard = new Guard(store);
        // A server owner with every permission is still refused; a developer is allowed.
        const owner: any = { id: 'owner', guild: { id: 'g', ownerId: 'owner' }, roles: { cache: new Map() }, permissions: { has: () => true } };
        for (const def of [issueCommand('hardban'), revokeCommand('hardban'), issueCommand('genreban'), revokeCommand('genreban')]) {
            assert.equal(guard.allowed(def.metadata, 'g', 'owner', owner, def.data.name, def.data.name), false, `${def.data.name}: a server owner is refused`);
            assert.equal(guard.allowed(def.metadata, 'g', DEV, owner, def.data.name, def.data.name), true, `${def.data.name}: a developer is allowed`);
            store.grant('g', 'owner', 'admin', 'owner');
            assert.equal(guard.allowed(def.metadata, 'g', 'owner', owner, def.data.name, def.data.name), false, `${def.data.name}: a security administrator is refused too`);
        }
    } finally {
        config.developers = previous;
        store.close();
    }
});

function commandRun(guilds: any[], input: string, extra: Record<string, unknown> = {}) {
    const n = network(guilds);
    const replies: any[] = [];
    const options: Record<string, unknown> = { user: input, reason: 'raiding', ...extra };
    const i: any = {
        user: { id: DEV, tag: 'dev' }, guildId: guilds[0]?.id ?? 'g', replies,
        editReply: async (p: any) => void replies.push(p),
        options: {
            getString: (k: string) => options[k] ?? null, getInteger: (k: string) => options[k] ?? null,
            getBoolean: (k: string) => options[k] ?? null, getAttachment: (k: string) => options[k] ?? null,
        },
    };
    const ctx: any = { ...n.deps, lifecycle: { isReady: () => true } };
    const setPolicy = (name: string) => { const def = [issueCommand('genreban'), issueCommand('hardban')].find(d => d.data.name === name); ctx.policy = def?.metadata; ctx.actionKey = name; };
    const registry = new Registry();
    registerDangerConfirm(registry);
    const confirm = registry.components.find(c => c.prefix === 'dangerconfirm:')!;
    const clickReplies: any[] = [];
    const click: any = clickFor(DEV, i.guildId, clickReplies);
    const press = async () => {
        click.customId = String(replies.at(-1).components[0].components[0].data.custom_id);
        await confirm.execute(ctx, click);
    };
    return { ...n, ctx, i, replies, clickReplies, press, setPolicy };
}

const title = (p: any) => String(p.embeds[0].data.title);

test('/genreban shows loading, asks to confirm, then reports the result with the record ID', async () => {
    const a = fakeGuild('100000000000000041', 'Alpha'), b = fakeGuild('100000000000000042', 'Bravo', { canBan: false });
    const f = commandRun([a.guild, b.guild], TARGET, { evidence: 'clip link', evidence_file: { name: 'shot.png', url: 'https://cdn.example/shot.png' } });
    f.setPolicy('genreban');
    await issueCommand('genreban').execute(f.ctx, f.i);
    assert.match(title(f.replies[0]), /^⏳ Preparing genreban/);
    assert.match(title(f.replies[1]), /^⚠ Genreban a user/);
    assert.equal(activeBan(f.store, 'genreban', TARGET), undefined, 'nothing is recorded before confirming');
    await f.press();
    assert.match(title(f.clickReplies[0]), /^⏳ Applying genreban GB-00001/);
    const last = f.clickReplies.at(-1);
    assert.match(title(last), /^⚠ Genreban GB-00001 partially succeeded: 1 of 2 servers/);
    assert.match(String(last.embeds[0].data.description), /Bravo\*\* · Missing permissions/);
    assert.match(String(last.embeds[0].data.description), /Evidence:\*\* clip link/);
    assert.equal(f.dms.length, 1, 'the user gets one DM');
    const dm = String(f.dms[0].embeds[0].data.description);
    assert.match(String(f.dms[0].embeds[0].data.title), /genrebanned by Midtown Vanguard/);
    assert.match(dm, /\*\*Reason:\*\* raiding/);
    assert.match(dm, /\*\*Record:\*\* GB-00001/);
    assert.match(dm, /2\*\* servers/);
    assert.ok(order.lastIndexOf('dm') < order.lastIndexOf('ban:Alpha'), 'the DM is sent before any server bans them');
    assert.match(String(last.embeds[0].data.description), /DM to the user:\*\* delivered/);
    const ban = activeBan(f.store, 'genreban', TARGET)!;
    assert.equal(ban.evidence_file, '[shot.png](https://cdn.example/shot.png)');
    f.store.close();
});

test('/genreban refuses a duplicate, an invalid ID, and a user already hardbanned', async () => {
    const a = fakeGuild('100000000000000043', 'Alpha');
    let f = commandRun([a.guild], TARGET);
    newBan(f.store);
    await issueCommand('genreban').execute(f.ctx, f.i);
    assert.match(title(f.replies.at(-1)), /No change: already done/);
    assert.equal(f.store.get('SELECT COUNT(*) AS n FROM network_bans')!.n, 1, 'no duplicate record');
    f.store.close();

    f = commandRun([a.guild], '12345');
    await issueCommand('genreban').execute(f.ctx, f.i);
    assert.match(title(f.replies.at(-1)), /Failed: invalid user/);
    f.store.close();

    f = commandRun([a.guild], TARGET);
    newBan(f.store, 'hardban');
    await issueCommand('genreban').execute(f.ctx, f.i);
    assert.match(String(f.replies.at(-1).embeds[0].data.description), /active hardban.*No genreban was created/s);
    f.store.close();
});

test('/hardban replaces an active genreban instead of stacking two records', async () => {
    const a = fakeGuild('100000000000000044', 'Alpha');
    const f = commandRun([a.guild], TARGET);
    const gen = newBan(f.store);
    f.setPolicy('hardban');
    await issueCommand('hardban').execute(f.ctx, f.i);
    await f.press();
    assert.match(title(f.clickReplies.at(-1)), /^✅ Hardban HB-00002 succeeded in all 1 server/);
    assert.equal(activeBan(f.store, 'genreban', TARGET), undefined);
    assert.match(String(f.store.get('SELECT revoke_reason FROM network_bans WHERE id=?', gen.id)!.revoke_reason), /Replaced by hardban/);
    f.store.close();
});

test('/unhardban and /ungenreban only revoke their own type and keep the record', async () => {
    const a = fakeGuild('100000000000000045', 'Alpha', { bans: { [TARGET]: `${TAG.hardban} HB-00001 ${DEV}: raiding` } });
    let f = commandRun([a.guild], TARGET, { reason: 'appeal' });
    const hard = newBan(f.store, 'hardban');
    await revokeCommand('genreban').execute(f.ctx, f.i);
    assert.match(String(f.replies.at(-1).embeds[0].data.description), /active hardban.*\/network unhardban/s, '/ungenreban points to /unhardban');
    assert.ok(activeBan(f.store, 'hardban', TARGET), '/ungenreban did not touch the hardban');
    await revokeCommand('hardban').execute(f.ctx, f.i);
    assert.match(title(f.replies.at(-1)), /^✅ Unhardban HB-00001 succeeded/);
    assert.deepEqual(a.calls.unbanned, [TARGET]);
    assert.equal(f.store.get('SELECT status FROM network_bans WHERE id=?', hard.id)!.status, 'revoked', 'the record is kept, marked revoked');
    f.store.close();

    f = commandRun([a.guild], 'raider', { reason: 'appeal' });
    newBan(f.store);
    await revokeCommand('genreban').execute(f.ctx, f.i);
    assert.equal(activeBan(f.store, 'genreban', TARGET), undefined, 'a ban can be revoked by the username recorded with it');
    f.store.close();
});

// ---------------------------------------------------------------- /moderation ban and unban

function moderation(sub: 'ban' | 'unban', o: { banError?: unknown; bans?: Record<string, string>; checkTargetAbove?: boolean; userId?: string } = {}) {
    const store = new Store(':memory:');
    authorize(store);
    const above = { comparePositionTo: () => 1 };
    const me = { id: 'bot', roles: { highest: above } };
    const bans = new Map(Object.entries(o.bans ?? {}));
    const calls = { banned: [] as string[], unbanned: [] as string[] };
    const guild: any = {
        id: 'g', name: 'Test', ownerId: 'owner',
        members: {
            fetchMe: async () => me,
            fetch: async () => {
                if (o.checkTargetAbove)
                    return { id: TARGET, roles: { highest: {} } };
                throw { code: 10007 };
            },
            ban: async (id: string) => {
                if (o.banError)
                    throw o.banError;
                calls.banned.push(id);
            },
            unban: async (id: string) => void calls.unbanned.push(id),
        },
        bans: { fetch: async ({ user }: any) => { if (!bans.has(user)) throw { code: 10026 }; return { reason: bans.get(user) }; } },
    };
    const actor: any = { id: 'mod', guild, roles: { cache: new Map(), highest: o.checkTargetAbove ? { comparePositionTo: () => -1 } : above }, permissions: { has: () => true } };
    const replies: any[] = [];
    const target = { id: TARGET, tag: 'raider', username: 'raider' };
    const i: any = {
        guild, guildId: 'g', channelId: 'c', user: { id: 'mod' }, replies,
        editReply: async (p: any) => void replies.push(p),
        options: {
            getSubcommand: () => sub,
            getString: (n: string) => n === 'reason' ? 'spam' : n === 'user_id' ? (o.userId ?? TARGET) : null,
            getInteger: () => null,
            getUser: () => target,
        },
    };
    const def: any = moderationCommand;
    const ctx: any = { store, logs: { push: () => { } }, actor, policy: { ...def.metadata, ...def.subcommands?.[sub] }, actionKey: `moderation/${sub}` };
    const registry = new Registry();
    registerDangerConfirm(registry);
    const confirm = registry.components.find(c => c.prefix === 'dangerconfirm:')!;
    const clickReplies: any[] = [];
    const click: any = clickFor('mod', 'g', clickReplies, actor);
    const press = async () => {
        click.customId = String(replies.at(-1).components[0].components[0].data.custom_id);
        await confirm.execute(ctx, click);
    };
    return { store, ctx, i, calls, replies, clickReplies, press };
}

test('a moderator who is not a developer can confirm their own ban', () => {
    const registry = new Registry();
    registerDangerConfirm(registry);
    assert.equal(registry.components.find(c => c.prefix === 'dangerconfirm:')!.metadata.developerOnly, false);
});

test('/moderation ban shows loading, then success with the case, user ID and moderator', async () => {
    const f = moderation('ban');
    await moderationCommand.execute(f.ctx, f.i);
    await f.press();
    assert.deepEqual(f.calls.banned, [TARGET]);
    assert.match(title(f.clickReplies[0]), /^⏳ Banning raider/);
    assert.equal(f.clickReplies.length, 2, 'loading, then the result');
    assert.match(title(f.clickReplies[1]), /^✅ Ban succeeded: raider/);
    assert.match(String(f.clickReplies[1].embeds[0].data.description), /Recorded case #1.*User ID:\*\* `400000000000000001`.*Moderator/s);
    assert.equal(f.store.readGuild('g', () => f.store.get('SELECT username FROM cases WHERE guild_id=?', 'g'))!.username, 'raider');
    f.store.close();
});

test('/moderation ban explains missing permissions, role hierarchy and duplicates', async () => {
    let f = moderation('ban', { banError: { code: 50013 } });
    await moderationCommand.execute(f.ctx, f.i);
    await f.press();
    assert.match(title(f.clickReplies.at(-1)), /missing permissions/);
    f.store.close();

    f = moderation('ban', { checkTargetAbove: true });
    await moderationCommand.execute(f.ctx, f.i);
    await f.press();
    assert.match(title(f.clickReplies.at(-1)), /role hierarchy/);
    assert.equal(f.calls.banned.length, 0);
    f.store.close();

    // Already banned (by hand or another bot): Discord's ban is left alone, the reason goes on their record.
    f = moderation('ban', { bans: { [TARGET]: 'mod: earlier' } });
    await moderationCommand.execute(f.ctx, f.i);
    await f.press();
    assert.equal(f.calls.banned.length, 0, 'no second ban sent to Discord');
    assert.match(JSON.stringify(f.clickReplies.at(-1)), /already banned/);
    assert.match(JSON.stringify(f.clickReplies.at(-1)), /BAN-0001/);
    assert.equal(f.store.readGuild('g', () => f.store.get('SELECT COUNT(*) AS n FROM cases WHERE guild_id=?', 'g'))!.n, 1, 'one case with this reason');
    const record = f.store.readGuild('g', () => f.store.get('SELECT * FROM ban_records WHERE guild_id=?', 'g'))!;
    assert.equal(record.status, 'banned'); assert.ok(record.reason, 'the reason is on the ban record');
    f.store.close();

    // A genreban or hardban is the developers' to change.
    f = moderation('ban', { bans: { [TARGET]: '[Vanguard hardban] HB-00001 1277709272041394187: raid' } });
    await moderationCommand.execute(f.ctx, f.i);
    await f.press();
    assert.match(JSON.stringify(f.clickReplies.at(-1)), /only a developer can change/);
    assert.equal(f.calls.banned.length, 0);
    f.store.close();
});

test('/moderation unban lifts local bans only, and never a genreban or hardban', async () => {
    let f = moderation('unban', { bans: { [TARGET]: 'mod: spam' } });
    await moderationCommand.execute(f.ctx, f.i);
    assert.match(title(f.replies[0]), /^⏳ Unbanning/);
    assert.match(title(f.replies.at(-1)), /^✅ Unban succeeded/);
    assert.deepEqual(f.calls.unbanned, [TARGET]);
    f.store.close();

    f = moderation('unban', { bans: { [TARGET]: `${TAG.hardban} HB-00001 ${DEV}: raiding` } });
    await moderationCommand.execute(f.ctx, f.i);
    assert.match(title(f.replies.at(-1)), /not allowed/);
    assert.match(String(f.replies.at(-1).embeds[0].data.description), /\/network unhardban/);
    assert.deepEqual(f.calls.unbanned, []);
    f.store.close();

    f = moderation('unban', { bans: { [TARGET]: 'mod: spam' } });
    newBan(f.store, 'genreban');
    await assert.rejects(moderationCommand.execute(f.ctx, f.i), /only this server's \*\*owner or a Head Admin\*\*/i, 'a moderator cannot bypass an active genreban');
    assert.deepEqual(f.calls.unbanned, []);
    f.store.close();

    // A Head Admin (here: a security admin) may let them back into this server only, after confirming.
    f = moderation('unban', { bans: { [TARGET]: `${TAG.genreban} GB-00001 ${DEV}: raiding` } });
    const gb = newBan(f.store, 'genreban');
    f.store.grant('g', 'mod', 'admin', 'owner');
    await moderationCommand.execute(f.ctx, f.i);
    assert.match(JSON.stringify(f.replies.at(-1)), /Let a genrebanned user back into this server/);
    await f.press();
    assert.deepEqual(f.calls.unbanned, [TARGET], 'unbanned here');
    assert.ok(activeException(f.store, 'g', gb.id), 'the exception is recorded for this server');
    assert.equal(activeException(f.store, 'other', gb.id), undefined, 'and only this server');
    assert.ok(activeBan(f.store, 'genreban', TARGET), 'the genreban stays active everywhere else');
    f.store.close();

    // Hardbans never have exceptions, even for the owner's staff.
    f = moderation('unban', { bans: { [TARGET]: `${TAG.hardban} HB-00001 ${DEV}: raiding` } });
    newBan(f.store, 'genreban'); newBan(f.store, 'hardban');
    f.store.grant('g', 'mod', 'admin', 'owner');
    await moderationCommand.execute(f.ctx, f.i);
    assert.match(String(f.replies.at(-1).embeds[0].data.description), /\/network unhardban/);
    assert.deepEqual(f.calls.unbanned, []);
    f.store.close();

    f = moderation('unban', { userId: '123' });
    await moderationCommand.execute(f.ctx, f.i);
    assert.match(title(f.replies.at(-1)), /invalid user/);
    f.store.close();

    f = moderation('unban');
    await moderationCommand.execute(f.ctx, f.i);
    assert.match(String(f.replies.at(-1).embeds[0].data.description), /not banned here/);
    f.store.close();
});

test('a user with closed DMs is still banned, and the result says the DM was not delivered', async () => {
    const a = fakeGuild('100000000000000046', 'Alpha');
    const f = commandRun([a.guild], TARGET);
    (f.deps.client.users as any).fetch = async () => ({ id: TARGET, tag: 'raider', username: 'raider', send: async () => { throw { code: 50007 }; } });
    f.setPolicy('hardban');
    await issueCommand('hardban').execute(f.ctx, f.i);
    await f.press();
    const last = f.clickReplies.at(-1);
    assert.match(String(last.embeds[0].data.title), /^✅ Hardban HB-00001 succeeded/);
    assert.match(String(last.embeds[0].data.description), /DM to the user:\*\* not delivered/);
    assert.equal(a.calls.banned.length, 1);
    f.store.close();
});

test('a genreban exception keeps the bot from re-banning in that one server only; hardbans ignore it', async () => {
    const store = new Store(':memory:');
    try {
        for (const g of ['g1', 'g2']) store.run("INSERT OR REPLACE INTO guild_authorization(guild_id,name,state,joined_at,authorized_at,authorized_by) VALUES(?,?,'AUTHORIZED',?,?,?)", g, g, Date.now(), Date.now(), DEV);
        const gb = newBan(store, 'genreban');
        const banned: string[] = [];
        const guild = (id: string): any => ({ id, name: id, ownerId: 'owner', members: { me: { permissions: { has: () => true }, roles: { highest: { comparePositionTo: () => 1 } } }, fetch: async () => { throw { code: 10007 }; }, ban: async () => { banned.push(id); } },
            bans: { fetch: async () => { throw { code: 10026 }; } } });
        const deps: NetworkDeps = { client: {} as any, store, logs: { push: () => { } } as any, isReady: () => true };
        addException(store, gb, { id: 'g1', name: 'g1' }, 'owner', 'reformed');
        await enforceOnJoin(deps, guild('g1'), TARGET);
        await enforceOnJoin(deps, guild('g2'), TARGET);
        assert.deepEqual(banned, ['g2'], 'allowed back into g1 only');
        assert.throws(() => addException(store, newBan(store, 'hardban'), { id: 'g1' }, 'owner', 'x'), /Hardbans have no exceptions/);
        banned.length = 0;
        await enforceOnJoin(deps, guild('g1'), TARGET);
        assert.deepEqual(banned, ['g1'], 'once hardbanned, the exception no longer protects them');
    } finally { store.close(); }
});
