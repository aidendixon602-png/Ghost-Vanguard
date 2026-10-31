import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { Store } from '../src/database/db.js';
import { authorize } from './helpers.js';
import { getFeature, setFeature } from '../src/features/settings.js';
import { INVITE_PATTERN, processAutomod, spamVerdict, AUTOMOD_DEFAULTS, blockedLink, cleanDomain } from '../src/features/automod.js';
import { inWindow, activityReport } from '../src/features/schedules.js';
import { logRankChange } from '../src/features/hr.js';
import { appealBlock, registerAppealControls } from '../src/features/appeals.js';
import { checkAltAccount, historyOnJoin, renderWelcome } from '../src/features/joins.js';
import { Registry } from '../src/bot/registry.js';
import caseCommand from '../src/commands/moderation/case.js';

const G = '123456789012345678', U = '223456789012345678', M = '323456789012345678', BOT = '999999999999999999';
function setup() {
    const store = new Store(':memory:');
    authorize(store, G);
    const logs: any[] = [];
    return { store, logs, queue: { push: (_g: string, e: any, rows?: any[]) => logs.push({ e: e.toJSON(), rows }) } as any };
}

test('feature settings fall back to defaults and keep history', () => {
    const { store } = setup();
    try {
        assert.deepEqual(getFeature(store, G, 'automod', AUTOMOD_DEFAULTS), AUTOMOD_DEFAULTS);
        setFeature(store, G, 'automod', AUTOMOD_DEFAULTS, { invites: false }, U);
        assert.equal(getFeature(store, G, 'automod', AUTOMOD_DEFAULTS).invites, false);
        assert.equal(getFeature(store, G, 'automod', AUTOMOD_DEFAULTS).spam, true, 'untouched fields keep their default');
        assert.equal(store.all("SELECT 1 FROM configuration_history WHERE guild_id=? AND component='feature/automod'", G).length, 1);
    } finally { store.close(); }
});

test('spam verdicts: mass pings, bursts and repeats; normal chat passes', () => {
    const now = 100000, msg = (id: string, at: number, text = 'hello there') => ({ id, at, text, channel: 'c' });
    assert.match(spamVerdict([], msg('m', now), 5, 5)!.reason, /pinged 5/);
    assert.equal(spamVerdict([], msg('m', now), 4, 5), null);
    const burst = [1, 2, 3, 4, 5].map(n => msg(`b${n}`, now - n * 500, `message ${n}`));
    assert.deepEqual(spamVerdict(burst, msg('m', now, 'six'), 0, 5)!.delete.sort(), ['b1', 'b2', 'b3', 'b4', 'b5', 'm']);
    const repeats = [1, 2, 3].map(n => msg(`r${n}`, now - n * 8000, 'buy cheap robux'));
    assert.match(spamVerdict(repeats, msg('m', now, 'buy cheap robux'), 0, 5)!.reason, /repeated the same message 4 times/);
    assert.equal(spamVerdict(repeats.slice(0, 2), msg('m', now, 'buy cheap robux'), 0, 5), null, 'three repeats is still fine');
    assert.equal(spamVerdict([msg('a', now - 40000, 'ok'), msg('b', now - 35000, 'ok'), msg('c', now - 31000, 'ok')], msg('m', now, 'ok'), 0, 5), null, 'old messages do not count');
});

test('invite pattern finds common invite links', () => {
    const codes = (t: string) => [...t.matchAll(INVITE_PATTERN)].map(m => m[1]);
    assert.deepEqual(codes('join discord.gg/abc123 and https://discord.com/invite/XyZ-9 now'), ['abc123', 'XyZ-9']);
    assert.deepEqual(codes('https://discordapp.com/invite/test'), ['test']);
    assert.deepEqual(codes('no invites at discord.com/channels/1/2'), []);
});

test('automod deletes invites to other servers but not to this server, and never touches staff', async () => {
    const { store, queue, logs } = setup();
    try {
        const deleted: string[] = [];
        const make = (content: string, staff = false, author = U, id = String(Math.random())) => ({
            inGuild: () => true, author: { id: author, bot: false, tag: 'user#0001' }, content, id, channelId: 'c', webhookId: null, system: false,
            member: { id: author, moderatable: true, timeout: async () => { }, permissions: { has: () => staff } },
            mentions: { users: new Collection(), roles: new Collection() },
            guild: { id: G, ownerId: 'owner', channels: { cache: new Collection() }, members: { fetch: async () => null } },
            client: { user: { id: BOT }, fetchInvite: async (code: string) => ({ guild: { id: code === 'home' ? G : '888888888888888888' } }) },
            channel: { isSendable: () => true, send: async () => ({ delete: async () => { } }) },
            delete: async () => { deleted.push(content); },
        }) as any;
        await processAutomod(store, queue, make('come to discord.gg/home'), () => false);
        assert.deepEqual(deleted, [], 'own-server invite allowed');
        await processAutomod(store, queue, make('come to discord.gg/other'), () => false);
        assert.deepEqual(deleted, ['come to discord.gg/other']);
        await processAutomod(store, queue, make('staff link discord.gg/other', true, M), () => false);
        await processAutomod(store, queue, make('trusted discord.gg/other', false, '423456789012345678'), id => id === '423456789012345678');
        assert.equal(deleted.length, 1, 'staff and whitelisted users are skipped');
        assert.match(JSON.stringify(logs), /invite link removed/);
        setFeature(store, G, 'automod', AUTOMOD_DEFAULTS, { invites: false });
        await processAutomod(store, queue, make('again discord.gg/other', false, '523456789012345678'), () => false);
        assert.equal(deleted.length, 1, 'off means off');
    } finally { store.close(); }
});

test('quiet hours window handles midnight and time zones', () => {
    const at = (h: number, m = 0) => Date.UTC(2026, 0, 1, h, m);
    const night = { start: '23:00', end: '07:00', utcOffset: 0 };
    assert.equal(inWindow(night, at(23, 30)), true);
    assert.equal(inWindow(night, at(3)), true);
    assert.equal(inWindow(night, at(7)), false);
    assert.equal(inWindow(night, at(12)), false);
    assert.equal(inWindow({ ...night, utcOffset: -5 }, at(4)), true, '04:00 UTC is 23:00 in UTC-5');
    assert.equal(inWindow({ ...night, utcOffset: -5 }, at(13)), false);
    assert.equal(inWindow({ start: '09:00', end: '17:00', utcOffset: 0 }, at(10)), true);
    assert.equal(inWindow({ start: '09:00', end: '09:00', utcOffset: 0 }, at(9)), false);
});

test('activity report counts each staff member\'s actions and separates the bot', () => {
    const { store } = setup();
    try {
        const now = Date.now();
        store.recordCase(G, 'a', U, 'ban', 'x'); store.recordCase(G, 'b', U, 'warn', 'x'); store.recordCase(G, 'c', M, 'warn', 'x'); store.recordCase(G, 'd', BOT, 'automod timeout', 'x');
        const text = activityReport(store, G, BOT, 7, now + 1000);
        assert.match(text, new RegExp(`1\\.\\*\\* <@${U}> · \\*\\*2\\*\\* actions`));
        assert.match(text, new RegExp(`<@${M}> · \\*\\*1\\*\\* action \\(1 warn\\)`));
        assert.doesNotMatch(text, /on duty/);
        assert.match(text, /Vanguard took \*\*1\*\* automatic action/);
    } finally { store.close(); }
});

test('appeals: one pending at a time and a 7-day wait after a denial', () => {
    const { store } = setup();
    try {
        const now = Date.now();
        assert.equal(appealBlock(store, G, U, now), null);
        store.run('INSERT INTO appeals(guild_id,user_id,text,at) VALUES(?,?,?,?)', G, U, 'please', now);
        assert.match(appealBlock(store, G, U, now)!, /already have an appeal/);
        store.run("UPDATE appeals SET status='denied',decided_at=? WHERE guild_id=?", now, G);
        assert.match(appealBlock(store, G, U, now + 1000)!, /appeal again/);
        assert.equal(appealBlock(store, G, U, now + 8 * 86400000), null);
    } finally { store.close(); }
});

test('accepting an appeal unbans, records a case and tells the user; members without rank are refused', async () => {
    const { store, queue } = setup();
    try {
        store.run('INSERT INTO appeals(guild_id,user_id,text,at) VALUES(?,?,?,?)', G, U, 'sorry', Date.now());
        const registry = new Registry(); registerAppealControls(registry);
        const handler = registry.components.find(c => c.prefix === 'appeal:')!;
        let unbanned = '', dm = '', edited: any;
        const i = (actorPerms: boolean) => ({ customId: `appeal:accept:${G}:1`, guildId: G, guild: { name: 'Server', members: { unban: async (id: string) => { unbanned = id; } } },
            client: { users: { fetch: async () => ({ send: async (p: any) => { dm = JSON.stringify(p); } }) } }, message: { embeds: [{ title: 'Ban appeal #1', description: 'x' }], edit: async (p: any) => { edited = p; } } }) as any;
        const ctx = (perms: boolean) => ({ store, logs: queue, actor: { id: M, permissions: { has: () => perms }, roles: { cache: new Collection() } } }) as any;
        await assert.rejects(handler.execute(ctx(false), i(false)), /Moderator rank or Ban Members/);
        const result = await handler.execute(ctx(true), i(true));
        assert.match(String(result), /accepted/);
        assert.equal(unbanned, U);
        assert.match(dm, /accepted/);
        assert.equal(store.get('SELECT status FROM appeals WHERE guild_id=? AND id=1', G)?.status, 'accepted');
        assert.equal(store.get("SELECT action FROM cases WHERE guild_id=? AND user_id=?", G, U)?.action, 'unban (appeal)');
        assert.ok(edited.components[0].toJSON().components.every((b: any) => b.disabled), 'buttons are disabled after a decision');
        await assert.rejects(handler.execute(ctx(true), i(true)), /already accepted/);
    } finally { store.close(); }
});

test('alt check flags a banned member\'s Roblox account and a shared one; skips trusted and when off', async () => {
    const { store, queue, logs } = setup();
    try {
        const member = (id: string) => ({ id, user: { bot: false, tag: 'new#0001' }, guild: { id: G } }) as any;
        store.run('INSERT INTO blocked_accounts VALUES(?,?,?)', G, '555', 'Linked Discord account banned: 1');
        await checkAltAccount(store, queue, { identify: async () => '555' }, member(U), () => false);
        assert.match(logs[0].e.title, /banned member/);
        store.run('INSERT INTO links VALUES(?,?,?,?,?)', G, M, '777', 'MainAccount', Date.now());
        await checkAltAccount(store, queue, { identify: async () => '777' }, member(U), () => false);
        assert.match(logs[1].e.title, /shared Roblox/); assert.match(logs[1].e.description, /MainAccount/);
        await checkAltAccount(store, queue, { identify: async () => '777' }, member(U), () => true);
        setFeature(store, G, 'automod', AUTOMOD_DEFAULTS, { alts: false });
        await checkAltAccount(store, queue, { identify: async () => '555' }, member(U), () => false);
        await checkAltAccount(store, queue, { identify: async () => null }, member(U), () => false);
        assert.equal(logs.length, 2);
    } finally { store.close(); }
});

test('returning members with cases or notes are flagged to staff', () => {
    const { store, queue, logs } = setup();
    try {
        const member = { id: U, user: { bot: false, tag: 'back#0001' }, guild: { id: G } } as any;
        historyOnJoin(store, queue, member);
        assert.equal(logs.length, 0);
        store.recordCase(G, U, M, 'ban', 'raiding');
        historyOnJoin(store, queue, member);
        assert.match(logs[0].e.description, /Cases:\*\* 1/); assert.match(logs[0].e.description, /raiding/);
    } finally { store.close(); }
});

test('welcome text fills in the placeholders', () => {
    assert.equal(renderWelcome('Hi {user} ({name}), welcome to {server}! #{count}', { id: U, user: { username: 'sam' }, guild: { name: 'Midtown', memberCount: 42 } } as any), `Hi <@${U}> (sam), welcome to Midtown! #42`);
});

test('rank changes are logged as promotions and demotions', async () => {
    const { store, queue, logs } = setup();
    try {
        store.run('INSERT INTO staff_roles(guild_id,role_id,level) VALUES(?,?,?)', G, 'modrole', 'moderator');
        store.run('INSERT INTO staff_roles(guild_id,role_id,level) VALUES(?,?,?)', G, 'adminrole', 'admin');
        const guild = { id: G, fetchAuditLogs: async () => ({ entries: new Collection([['e', { targetId: U, executorId: M, createdTimestamp: Date.now() }]]) }) };
        const mem = (roles: string[]) => ({ partial: false, id: U, user: { bot: false, tag: 'staff#0001' }, guild, roles: { cache: new Collection(roles.map(r => [r, {}])) } }) as any;
        await logRankChange(store, queue, mem(['modrole']), mem(['modrole', 'adminrole']));
        assert.match(logs[0].e.title, /Promotion/); assert.match(logs[0].e.description, /Moderator → \*\*Admin/); assert.match(logs[0].e.description, new RegExp(`By:\\*\\* <@${M}>`));
        await logRankChange(store, queue, mem(['adminrole']), mem([]));
        assert.match(logs[1].e.title, /Removed from staff/);
        await logRankChange(store, queue, mem(['other']), mem(['other', 'another']));
        assert.equal(logs.length, 2, 'roles without a rank are ignored');
    } finally { store.close(); }
});

test('case search filters by member, action and reason words', async () => {
    const { store } = setup();
    try {
        store.recordCase(G, U, M, 'warn', 'spamming links'); store.recordCase(G, U, M, 'ban', 'raid'); store.recordCase(G, 'x', M, 'warn', 'rude 100% _test_');
        const run = (opts: Record<string, any>) => caseCommand.execute({ store } as any, { guildId: G, options: { getSubcommand: () => 'search', getUser: (n: string) => opts[n] ? { id: opts[n] } : null, getString: (n: string) => opts[n] ?? null, getInteger: (n: string) => opts[n] ?? null } } as any) as Promise<string>;
        assert.match(await run({ user: U }), /2 found/);
        assert.match(await run({ user: U, action: 'warn' }), /1 found/);
        assert.match(await run({ reason_contains: '100%' }), /1 found/);
        assert.match(await run({ reason_contains: '_test_' }), /1 found/);
        assert.match(await run({ reason_contains: 'nothing like this' }), /0 found/);
        await assert.rejects(run({}), /at least one filter/);
    } finally { store.close(); }
});

test('quiet hours never lift a manual lockdown, and keep trying while a restore is busy', async () => {
    const { store, queue } = setup();
    try {
        const { runSchedules, LOCK_SCHEDULE_DEFAULTS, SCHEDULE_REASON } = await import('../src/features/schedules.js');
        const outside = Date.UTC(2026, 0, 1, 12, 0);
        setFeature(store, G, 'lockschedule', LOCK_SCHEDULE_DEFAULTS, { enabled: true, start: '23:00', end: '07:00', utcOffset: 0, lockedBySchedule: true });
        store.run('INSERT INTO lockdowns(guild_id,started_by,started_at,reason,message) VALUES(?,?,?,?,?)', G, U, outside, 'raid', 'locked');
        const guild = { id: G };
        let busy = false;
        const deps: any = { store, logs: queue, client: { user: { id: BOT }, guilds: { cache: new Collection([[G, guild]]) } }, ready: () => true, locks: { busy: () => busy, run: async () => { throw new Error('must not unlock'); } } };
        await runSchedules(deps, outside);
        assert.ok(store.get('SELECT 1 FROM lockdowns WHERE guild_id=?', G), 'manual lockdown stays');
        assert.equal(getFeature(store, G, 'lockschedule', LOCK_SCHEDULE_DEFAULTS).lockedBySchedule, false);
        // Our own lockdown while a restore holds the lock: the flag is kept so the next minute retries.
        store.run('UPDATE lockdowns SET reason=? WHERE guild_id=?', SCHEDULE_REASON, G);
        setFeature(store, G, 'lockschedule', LOCK_SCHEDULE_DEFAULTS, { lockedBySchedule: true });
        busy = true;
        await runSchedules(deps, outside);
        assert.equal(getFeature(store, G, 'lockschedule', LOCK_SCHEDULE_DEFAULTS).lockedBySchedule, true);
    } finally { store.close(); }
});

test('a member returning after their own ban ended is not flagged as an alt', async () => {
    const { store, queue, logs } = setup();
    try {
        store.run('INSERT INTO blocked_accounts VALUES(?,?,?)', G, '555', `Linked Discord account banned: ${U}`);
        await checkAltAccount(store, queue, { identify: async () => '555' }, { id: U, user: { bot: false, tag: 'back#0001' }, guild: { id: G } } as any, () => false);
        assert.equal(logs.length, 0);
    } finally { store.close(); }
});

test('replying to someone does not count toward the mention limit, but 5 real pings do', async () => {
    const { store, queue } = setup();
    try {
        let timedOut = 0;
        const ids = ['a1', 'a2', 'a3', 'a4', 'replied'].map(x => [x, {}] as [string, object]);
        const make = (id: string, replied: string | null) => ({ inGuild: () => true, author: { id: U, bot: false, tag: 'u#1' }, content: 'hey all', id, channelId: 'c', webhookId: null, system: false,
            member: { id: U, moderatable: true, timeout: async () => { timedOut++; }, permissions: { has: () => false } },
            mentions: { users: new Collection(ids), roles: new Collection(), repliedUser: replied ? { id: replied } : null },
            guild: { id: G, ownerId: 'owner', channels: { cache: new Collection() }, members: { fetch: async () => null } }, client: { user: { id: BOT } },
            channel: { isSendable: () => true, send: async () => ({ delete: async () => { } }) }, delete: async () => { } }) as any;
        await processAutomod(store, queue, make('m1', 'replied'), () => false, 1_000_000);
        assert.equal(timedOut, 0, '4 pings + the reply ping is fine');
        await processAutomod(store, queue, make('m2', null), () => false, 2_000_000);
        assert.equal(timedOut, 1, '5 real pings is spam');
    } finally { store.close(); }
});

test('link rule: block list, strict allow list, sub-domains, and invites left to the invite blocker', () => {
    const c = (links: any, allowed: string[] = [], blocked: string[] = []) => ({ links, allowedDomains: allowed, blockedDomains: blocked });
    assert.equal(blockedLink('see https://evil.com/x', c('off')), null);
    assert.equal(blockedLink('see https://evil.com/x and https://ok.com', c('blocklist', [], ['evil.com'])), 'evil.com');
    assert.equal(blockedLink('https://cdn.evil.com/a.png', c('blocklist', [], ['evil.com'])), 'cdn.evil.com', 'sub-domains are covered');
    assert.equal(blockedLink('https://notevil.com', c('blocklist', [], ['evil.com'])), null, 'look-alike names are not matched');
    assert.equal(blockedLink('https://www.YouTube.com/watch?v=1', c('allowlist', ['youtube.com'])), null);
    assert.equal(blockedLink('https://random.site/page', c('allowlist', ['youtube.com'])), 'random.site');
    assert.equal(blockedLink('https://discord.gg/abc https://discord.com/invite/x', c('allowlist', [])), null, 'invites are the invite blocker\'s job');
    assert.equal(blockedLink('https://youtube.com', c('allowlist', ['youtube.com'], ['youtube.com'])), 'youtube.com', 'blocked wins');
    assert.equal(cleanDomain('https://www.Example.com/page?q=1'), 'example.com');
    assert.equal(cleanDomain('not a site'), null);
});

test('invites to whitelisted partner servers are allowed; others are removed', async () => {
    const { store, queue } = setup();
    try {
        const PARTNER = '888888888888888888', OTHER = '777777777777777777';
        setFeature(store, G, 'automod', AUTOMOD_DEFAULTS, { allowedServers: { [PARTNER]: 'Partner' } });
        const deleted: string[] = [];
        const make = (content: string, author: string) => ({ inGuild: () => true, author: { id: author, bot: false, tag: 'u#1' }, content, id: content, channelId: 'c', webhookId: null, system: false,
            member: { id: author, moderatable: true, timeout: async () => { }, permissions: { has: () => false } }, mentions: { users: new Collection(), roles: new Collection() },
            guild: { id: G, ownerId: 'owner', channels: { cache: new Collection() }, members: { fetch: async () => null } },
            client: { user: { id: BOT }, fetchInvite: async (code: string) => ({ guild: { id: code === 'partner' ? PARTNER : OTHER } }) },
            channel: { isSendable: () => true, send: async () => ({ delete: async () => { } }) }, delete: async () => { deleted.push(content); } }) as any;
        await processAutomod(store, queue, make('discord.gg/partner', '600000000000000001'), () => false);
        await processAutomod(store, queue, make('discord.gg/stranger', '600000000000000002'), () => false);
        assert.deepEqual(deleted, ['discord.gg/stranger']);
    } finally { store.close(); }
});

test('grouped command tree: fits Discord limits, routes back to the original modules and covers every command', async () => {
    const { Registry } = await import('../src/bot/registry.js');
    const { treeJson, routeInteraction, indexTree, displayPath, UMBRELLAS, RETIRED } = await import('../src/bot/command-tree.js');
    const r = new Registry(); await r.load(); indexTree(r);
    const tree = treeJson(r);
    const size = (o: any): number => (o.name?.length ?? 0) + (o.description?.length ?? 0) + (o.options ?? []).reduce((a: number, x: any) => a + size(x), 0) + (o.choices ?? []).reduce((a: number, c: any) => a + c.name.length + String(c.value).length, 0);
    // The standalone developer ban and exception commands keep their original names in the top-level menu.
    assert.ok(tree.length <= 20, `only ${tree.length} top-level commands`); // Discord supports up to 100 application commands
    for (const c of tree) {
        assert.ok(size(c) < 8000, `${c.name} is under Discord's 8000-character limit`);
        assert.ok((c.options ?? []).length <= 25);
        const names = (c.options ?? []).map((o: any) => o.name);
        assert.equal(new Set(names).size, names.length, `${c.name} has no duplicate subcommands`);
    }
    // Every command module is reachable from the tree.
    const reachable = new Set([...UMBRELLAS.flatMap(u => u.entries.map(e => e.child)), ...tree.map((c: any) => c.name), ...RETIRED]);
    for (const def of r.commands.values()) assert.ok(reachable.has(def.data.name), `${def.data.name} is in the tree`);
    // Real discord.js interactions (their option resolver has read-only fields, so plain fakes are not enough).
    const { Client, ChatInputCommandInteraction } = await import('discord.js');
    const client = new Client({ intents: [] });
    const real = (name: string, options: any[]) => new (ChatInputCommandInteraction as any)(client, { id: '1', application_id: '2', type: 2, token: 't', version: 1, locale: 'en-US', app_permissions: '0', channel_id: '3', authorizing_integration_owners: {}, entitlements: [], attachment_size_limit: 1,
        user: { id: '223456789012345678', username: 'u', discriminator: '0', avatar: null, global_name: null }, data: { id: '4', name, type: 1, options } });
    const flat = routeInteraction(real('mod', [{ type: 1, name: 'ban', options: [{ type: 3, name: 'reason', value: 'spam' }] }]));
    assert.ok(flat instanceof ChatInputCommandInteraction);
    assert.equal(flat.commandName, 'moderation'); assert.equal(flat.options.getSubcommand(), 'ban'); assert.equal(flat.options.getSubcommandGroup(false), null);
    assert.equal(flat.options.data[0].name, 'ban'); assert.equal(flat.options.getString('reason'), 'spam');
    // A single command placed inside a shared group: /dev server authorize → authserver.
    const nested = routeInteraction(real('dev', [{ type: 2, name: 'server', options: [{ type: 1, name: 'authorize', options: [{ type: 3, name: 'guild_id', value: '123456789012345678' }] }] }]));
    assert.equal(nested.commandName, 'authserver'); assert.equal(nested.options.getSubcommand(false), null); assert.equal(nested.options.getString('guild_id'), '123456789012345678');
    const hardban = routeInteraction(real('hardban', []));
    assert.equal(hardban.commandName, 'hardban');
    assert.equal(hardban.options.getSubcommand(false), null, 'standalone ban commands are not rewritten through a group');
    const group = routeInteraction(real('automod', [{ type: 1, name: 'links', options: [{ type: 3, name: 'mode', value: 'off' }] }]));
    assert.equal(group.commandName, 'automod'); assert.equal(group.options.getSubcommand(), 'links'); assert.equal(group.options.data[0].name, 'links'); assert.equal(group.options.getString('mode'), 'off');
    const scam = routeInteraction(real('automod', [{ type: 2, name: 'scam', options: [{ type: 1, name: 'status', options: [] }] }]));
    assert.equal(scam.commandName, 'scam'); assert.equal(scam.options.getSubcommand(), 'status');
    // One module split across two commands, and shown under another name.
    const quarantine = routeInteraction(real('antinuke', [{ type: 1, name: 'quarantine', options: [] }]));
    assert.equal(quarantine.commandName, 'security'); assert.equal(quarantine.options.getSubcommand(), 'quarantine');
    const secConfig = routeInteraction(real('setup', [{ type: 1, name: 'security', options: [] }]));
    assert.equal(secConfig.commandName, 'security'); assert.equal(secConfig.options.getSubcommand(), 'config', '/setup security runs security config');
    const admins = routeInteraction(real('setup', [{ type: 1, name: 'security-admins', options: [] }]));
    assert.equal(admins.options.getSubcommand(), 'admin');
    const raidMode = routeInteraction(real('raid', [{ type: 2, name: 'mode', options: [{ type: 1, name: 'on', options: [] }] }]));
    assert.equal(raidMode.commandName, 'raidmode'); assert.equal(raidMode.options.getSubcommand(), 'on');
    const single = routeInteraction(real('info', [{ type: 1, name: 'ping', options: [] }]));
    assert.equal(single.commandName, 'ping'); assert.equal(single.options.getSubcommand(false), null); assert.deepEqual(single.options.data, []);
    const renamed = routeInteraction(real('setup', [{ type: 2, name: 'config', options: [{ type: 1, name: 'feature', options: [] }] }]));
    assert.equal(renamed.commandName, 'guild-config');
    assert.equal(routeInteraction(real('help', [])).commandName, 'help', 'standalone commands are untouched');
    // And it survives the reply-panel wrapper the router adds.
    const { ReplyPanels } = await import('../src/bot/reply-panels.js');
    const wrapped = new ReplyPanels().wrap(flat);
    assert.equal(wrapped.options.getSubcommand(), 'ban'); assert.equal(wrapped.options.data[0].name, 'ban'); assert.equal(wrapped.isChatInputCommand(), true);
    client.destroy();
    assert.equal(displayPath('automod', 'links'), '/automod links');
    assert.equal(displayPath('security', 'quarantine'), '/antinuke quarantine');
    assert.equal(displayPath('security', 'config'), '/setup security');
    assert.equal(displayPath('security', 'admin'), '/setup security-admins');
    assert.equal(displayPath('raidmode', 'on'), '/raid mode on');
    assert.equal(displayPath('case', 'view'), '/mod cases view');
    assert.equal(displayPath('moderation', 'ban'), '/mod ban');
    assert.equal(displayPath('userinfo'), '/info user');
    // Each routed shape passes the original module's own argument check.
    const { validateArguments } = await import('../src/bot/registry.js');
    validateArguments(r.commands.get('1:moderation')!.data, [{ type: 1, name: 'ban', options: [{ type: 6, name: 'user', value: '223456789012345678' }, { type: 3, name: 'reason', value: 'x' }] }]);
});
