import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, GuildVerificationLevel, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { Store } from '../src/database/db.js';
import { authorize } from './helpers.js';
import { DAY, handleRaidJoin, raidState, setRaidMode } from '../src/security/raidmode.js';
import { forgetGuild, lookalikes, messageKey, nameKey, processMessageWave, raiseGate, recentJoiners, rememberJoin, restoreGates, switchOnRaid, WAVE_ACCOUNTS } from '../src/security/raid-waves.js';
import { Security } from '../src/security/security.js';
import { RULES } from '../src/core.js';

const G = 'g';
const logs = () => { const pushed: any[] = []; return { pushed, q: { push: (_g: string, e: any) => pushed.push(e?.toJSON?.() ?? e) } as any }; };

function store(mode: 'enforce' | 'observe' = 'enforce') {
    const s = new Store(':memory:'); authorize(s, G);
    const settings = s.settings(G); settings.enabled = true; settings.mode = mode; s.save(settings);
    return s;
}

function member(id: string, name: string, ageDays: number, o: any = {}) {
    const m: any = { id, guild: { id: G }, joinedTimestamp: o.joinedAt ?? Date.now(), user: { bot: false, tag: name, username: name, createdTimestamp: Date.now() - ageDays * DAY },
        kickable: true, moderatable: true, actions: [] as string[] };
    m.kick = async () => m.actions.push('kick');
    m.timeout = async (ms: number) => m.actions.push(`timeout:${ms}`);
    return m;
}

test('name patterns ignore numbers, separators and case', () => {
    assert.equal(nameKey('Raider_01'), nameKey('raider.02'));
    assert.equal(nameKey('xX_Raider_Xx'), 'xxraiderxx');
    assert.equal(nameKey('12'), null, 'too short to compare');
    assert.equal(messageKey('JOIN   https://evil.gg/abc <@123456789012345678>'), 'join link @x');
    assert.equal(messageKey('hi'), null);
});

test('raid mode catches a lookalike wave of old accounts, but not one person with an old account', async () => {
    const s = store(); const l = logs();
    forgetGuild(G);
    try {
        setRaidMode(s, G, true, 'mod', { minAgeDays: 7, action: 'kick' });
        const first = member('1', 'raider_01', 400), second = member('2', 'raider_02', 400), third = member('3', 'raider_03', 400);
        assert.equal(await handleRaidJoin(s, l.q, first, () => false), 'ignored', 'one old account is fine');
        assert.equal(await handleRaidJoin(s, l.q, second, () => false), 'ignored', 'two look alike: not yet a wave');
        assert.equal(await handleRaidJoin(s, l.q, third, () => false), 'kicked', 'the third matching name in 10 minutes is a wave');
        assert.equal(await handleRaidJoin(s, l.q, member('4', 'regular_member', 400), () => false), 'ignored');
        assert.equal(lookalikes(G, member('9', 'raider_09', 400)), 3);
    } finally { forgetGuild(G); s.close(); }
});

test('a member is handled once per join, but a rejoin is a new join', async () => {
    const s = store(); const l = logs();
    try {
        setRaidMode(s, G, true, 'mod', { minAgeDays: 7, action: 'kick' });
        const joinedAt = Date.now();
        assert.equal(await handleRaidJoin(s, l.q, member('5', 'fresh', 1, { joinedAt }), () => false), 'kicked');
        assert.equal(await handleRaidJoin(s, l.q, member('5', 'fresh', 1, { joinedAt }), () => false), 'ignored', 'the wave sweep and the join event: once');
        assert.equal(await handleRaidJoin(s, l.q, member('5', 'fresh', 1, { joinedAt: joinedAt + 5000 }), () => false), 'kicked', 'came straight back: handled again');
    } finally { forgetGuild(G); s.close(); }
});

function fakeGuild(o: { verification?: number; manageGuild?: boolean } = {}) {
    const g: any = {
        id: G, ownerId: 'owner', verificationLevel: o.verification ?? GuildVerificationLevel.Low,
        members: { me: { permissions: new PermissionsBitField(o.manageGuild === false ? 0n : PermissionFlagsBits.ManageGuild) }, cache: new Collection<string, any>() },
        setVerificationLevel: async (level: number) => { g.verificationLevel = level; g.levels.push(level); },
        levels: [] as number[],
    };
    return g;
}

test('a detected wave switches raid mode on and raises the join gate; it goes back when raid mode ends', async () => {
    const s = store(); const l = logs();
    const guild = fakeGuild({ verification: GuildVerificationLevel.Low });
    try {
        const line = await switchOnRaid(s, l.q, guild, Date.now(), 'join flood');
        assert.match(line, /Raid mode switched on automatically/);
        assert.match(line, /Join gate:.*Low to High/);
        assert.equal(guild.verificationLevel, GuildVerificationLevel.High);
        assert.ok(raidState(s, G).enabled);
        assert.match(await switchOnRaid(s, l.q, guild), /already on/);
        // Still on: nothing restored.
        await restoreGates(s, l.q, { guilds: { cache: new Map([[G, guild]]) } } as any, () => true);
        assert.equal(guild.verificationLevel, GuildVerificationLevel.High);
        setRaidMode(s, G, false, 'mod');
        await restoreGates(s, l.q, { guilds: { cache: new Map([[G, guild]]) } } as any, () => true);
        assert.equal(guild.verificationLevel, GuildVerificationLevel.Low, 'put back when raid mode ends');
        assert.ok(l.pushed.some(e => /Join gate lifted/.test(e.title)));
    } finally { s.close(); }
});

test('the join gate leaves a level staff changed during the raid, and needs Manage Server', async () => {
    const s = store(); const l = logs();
    try {
        const guild = fakeGuild({ verification: GuildVerificationLevel.None });
        await switchOnRaid(s, l.q, guild);
        guild.verificationLevel = GuildVerificationLevel.VeryHigh; // staff went further by hand
        setRaidMode(s, G, false, 'mod');
        await restoreGates(s, l.q, { guilds: { cache: new Map([[G, guild]]) } } as any, () => true);
        assert.equal(guild.verificationLevel, GuildVerificationLevel.VeryHigh);
        assert.match(await raiseGate(s, l.q, fakeGuild({ manageGuild: false })), /needs \*\*Manage Server\*\*/);
        assert.equal(await raiseGate(s, l.q, fakeGuild({ verification: GuildVerificationLevel.High })), '', 'already high enough');
    } finally { s.close(); }
});

test('observe mode never switches raid mode on', async () => {
    const s = store('observe'); const l = logs();
    try {
        assert.match(await switchOnRaid(s, l.q, fakeGuild()), /observe mode/);
        assert.ok(!raidState(s, G).enabled);
    } finally { s.close(); }
});

test('the accounts that made up the flood are found for the sweep', () => {
    const guild = fakeGuild();
    const now = Date.now();
    for (const [id, ago, bot] of [['a', 5000, false], ['b', 20000, false], ['c', 120000, false], ['d', 1000, true]] as const)
        guild.members.cache.set(id, { id, user: { bot }, joinedTimestamp: now - ago });
    assert.deepEqual(recentJoiners(guild, 30000, now).map((m: any) => m.id), ['a', 'b']);
});

function waveWorld(mode: 'enforce' | 'observe' = 'enforce') {
    const s = store(mode); const l = logs();
    const deleted: string[] = [], bulk: string[][] = [];
    const channel = { isTextBased: () => true, messages: { delete: async (id: string) => void deleted.push(id) }, bulkDelete: async (ids: string[]) => { bulk.push(ids); return { size: ids.length }; } };
    const members = new Map<string, any>();
    const guild: any = {
        id: G, ownerId: 'owner', verificationLevel: GuildVerificationLevel.High,
        channels: { cache: new Map([['c', channel]]) },
        members: { me: { permissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild) }, cache: new Collection(), fetch: async (id: string) => members.get(id) ?? null },
        setVerificationLevel: async () => undefined,
    };
    let n = 0;
    const send = (userId: string, content: string, o: { joinedAgo?: number; bot?: boolean } = {}) => {
        const m = members.get(userId) ?? member(userId, `user${userId}`, 1);
        m.joinedTimestamp = Date.now() - (o.joinedAgo ?? 60000);
        members.set(userId, m);
        const message: any = { id: `m${++n}`, guildId: G, guild, channelId: 'c', content, webhookId: null, member: m, author: { id: userId, bot: !!o.bot } };
        return processMessageWave({ store: s, logs: l.q, trusted: id => id === 'staff' }, message);
    };
    return { s, l, deleted, bulk, members, send };
}

test('the same message from several new accounts is a wave: deleted, senders timed out, raid mode on', async () => {
    const w = waveWorld();
    forgetGuild(G);
    try {
        setRaidMode(w.s, G, false, 'mod', { action: 'timeout' });
        for (let i = 1; i < WAVE_ACCOUNTS; i++) assert.deepEqual(await w.send(`u${i}`, 'FREE NITRO https://evil.gg/x'), [], 'not a wave yet');
        const handled = await w.send(`u${WAVE_ACCOUNTS}`, 'free nitro   https://evil.gg/y');
        assert.equal(handled.length, WAVE_ACCOUNTS, 'every account in the wave');
        assert.deepEqual(w.bulk, [['m1', 'm2', 'm3', 'm4']], 'their messages deleted together');
        assert.ok([...w.members.values()].every(m => /^timeout:/.test(m.actions[0])));
        assert.ok(raidState(w.s, G).enabled, 'raid mode switched on');
        assert.ok(w.l.pushed.some(e => /Message wave stopped/.test(e.title)));
        // A latecomer with the same message is handled straight away.
        assert.deepEqual(await w.send('u9', 'Free Nitro https://evil.gg/z'), ['u9']);
        assert.deepEqual(w.deleted, ['m5']);
    } finally { forgetGuild(G); w.s.close(); }
});

test('message waves ignore established members, trusted staff, bots and short messages; observe mode only reports', async () => {
    const w = waveWorld();
    forgetGuild(G);
    try {
        for (let i = 1; i <= WAVE_ACCOUNTS + 1; i++) assert.deepEqual(await w.send(`old${i}`, 'good morning everyone', { joinedAgo: 3 * 3600000 }), [], 'not new members');
        assert.deepEqual(await w.send('staff', 'good morning everyone'), []);
        for (let i = 1; i <= WAVE_ACCOUNTS; i++) assert.deepEqual(await w.send(`s${i}`, 'gm'), [], 'too short to judge');
        assert.equal(w.bulk.length + w.deleted.length, 0);
    } finally { forgetGuild(G); w.s.close(); }
    const o = waveWorld('observe');
    forgetGuild(G);
    try {
        for (let i = 1; i <= WAVE_ACCOUNTS; i++) await o.send(`u${i}`, 'join my server now');
        assert.equal(o.bulk.length, 0, 'observe mode removes nothing');
        assert.ok(o.l.pushed.some(e => /observe mode/.test(e.title)));
        assert.ok(!raidState(o.s, G).enabled);
    } finally { forgetGuild(G); o.s.close(); }
});

test('mass unbans are caught and banned again; emoji and sticker wipes are rules too', async () => {
    assert.ok(RULES.some(r => r.key === 'mass_unban' && r.revert));
    assert.ok(RULES.some(r => r.key === 'emoji_delete'));
    const s = store();
    const security = new Security(s, { push: () => undefined } as any);
    const banned: string[] = [];
    const guild: any = { id: G, ownerId: 'owner', client: { user: { id: 'bot' } }, members: { cache: new Collection() }, bans: { create: async (id: string) => void banned.push(id) } };
    try {
        assert.equal(await security.revert({ targetId: 'raider' } as any, guild, RULES.find(r => r.key === 'mass_unban')!), 'Banned raider again.');
        assert.match(await security.revert({ targetId: 'owner' } as any, guild, RULES.find(r => r.key === 'mass_unban')!), /trusted/);
        assert.deepEqual(banned, ['raider']);
    } finally { s.close(); }
});

test('remembered joins expire and are per server', () => {
    forgetGuild(G);
    const t = Date.now();
    rememberJoin(G, member('1', 'alpha_1', 1), t - 11 * 60 * 1000);
    rememberJoin(G, member('2', 'alpha_2', 1), t);
    assert.equal(lookalikes(G, member('3', 'alpha_3', 1), t), 1, 'the old one has expired');
    assert.equal(lookalikes('other', member('3', 'alpha_3', 1), t), 0);
    forgetGuild(G);
});

test('a join flood switches raid mode on and sweeps the accounts that made up the flood', async () => {
    const s = store(); const l = logs();
    forgetGuild(G);
    const security = new Security(s, l.q);
    const guild: any = fakeGuild({ verification: GuildVerificationLevel.High });
    guild.client = { user: { id: 'bot' } };
    const flood = RULES.find(r => r.key === 'join_flood')!;
    try {
        setRaidMode(s, G, false, 'mod', { minAgeDays: 7, action: 'kick' });
        const joiners: any[] = [];
        for (let i = 0; i < flood.count; i++) {
            const m = member(`j${i}`, `joiner${i}x`, 1, { joinedAt: Date.now() - 1000 });
            m.guild = guild;
            m.roles = { cache: new Collection() };
            guild.members.cache.set(m.id, m);
            joiners.push(m);
            await security.join(m);
        }
        assert.ok(raidState(s, G).enabled, 'raid mode switched on by the flood');
        assert.ok(joiners.every(m => m.actions.includes('kick')), 'every young account in the flood was removed');
        assert.ok(l.pushed.some(e => /Swept \*\*\d+\*\* account/.test(e.description ?? '')));
    } finally { forgetGuild(G); s.close(); }
});
