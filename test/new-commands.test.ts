import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, Collection, PermissionsBitField } from 'discord.js';
import { Store } from '../src/database/db.js';
import { authorize } from './helpers.js';
import { responsibleActor } from '../src/security/security.js';
import { handleRaidJoin, raidState, setRaidMode, sweepTempbans, DAY } from '../src/security/raidmode.js';
import { Registry } from '../src/bot/registry.js';
import { registerDangerConfirm } from '../src/ui/danger-ui.js';
import { config } from '../src/config.js';
import { HELP_SECTIONS } from '../src/ui/help-ui.js';
import caseCmd from '../src/commands/moderation/case.js';
import note from '../src/commands/moderation/note.js';
import massban, { parseIds } from '../src/commands/security/massban.js';

const MOD = '423456789012345678';

test('case numbers are per server and survive other servers adding cases', () => {
    const store = new Store(':memory:'); authorize(store); authorize(store, 'other');
    assert.equal(store.recordCase('g', 'u', MOD, 'warn', 'a'), 1);
    assert.equal(store.recordCase('other', 'u', MOD, 'warn', 'b'), 1);
    assert.equal(store.recordCase('g', 'u', MOD, 'ban', 'c'), 2);
    store.close();
});

test('/case view, reason and delete (delete needs a confirmation click)', async () => {
    const store = new Store(':memory:'); authorize(store);
    const DEV = '1277709272041394187'; config.developers.add(DEV);
    store.recordCase('g', 'target', MOD, 'warn', 'spam');
    const logs: any[] = [], ctx: any = { store, logs: { push: (_g: any, e: any) => logs.push(e.toJSON()) }, actor: { id: DEV } };
    const devMember: any = { id: DEV, guild: { id: 'g', ownerId: DEV }, roles: { cache: new Map() }, permissions: { has: () => true } };
    const i = (sub: string, extra: any = {}) => { const replies: any[] = []; return { replies, guildId: 'g', user: { id: DEV }, member: devMember, inCachedGuild: () => true, guild: { members: { me: { permissions: { has: () => true } }, fetch: async () => devMember } },
        options: { getSubcommand: () => sub, getInteger: (n: string) => n === 'number' ? extra.number ?? 1 : null, getString: () => extra.reason ?? null }, editReply: async (p: any) => void replies.push(p) } as any; };
    assert.match(await caseCmd.execute(ctx, i('view')) as string, /Case #1 · warn[\s\S]*spam/);
    await caseCmd.execute(ctx, i('reason', { reason: 'advertising' }));
    assert.equal(store.get('SELECT reason FROM cases WHERE guild_id=? AND number=1', 'g').reason, 'advertising');
    assert.match(logs[0].title, /reason changed/);
    await assert.rejects(caseCmd.execute(ctx, i('view', { number: 9 })), /#9 does not exist/);
    const prompt = i('delete'); await caseCmd.execute(ctx, prompt);
    assert.equal(store.all('SELECT * FROM cases WHERE guild_id=?', 'g').length, 1, 'not deleted before confirming');
    const registry = new Registry(); registerDangerConfirm(registry);
    const click = i('delete'); click.customId = String(prompt.replies[0].components[0].components[0].data.custom_id);
    await registry.components.find(c => c.prefix === 'dangerconfirm:')!.execute(ctx, click);
    assert.equal(store.all('SELECT * FROM cases WHERE guild_id=?', 'g').length, 0);
    assert.match(await caseCmd.execute(ctx, i('recent')) as string, /No cases yet/);
    store.close();
});

test('/note add, list and remove with per-server numbers', async () => {
    const store = new Store(':memory:'); authorize(store); store.save(store.settings('g'));
    const ctx: any = { store };
    const i = (sub: string, o: any = {}) => ({ guildId: 'g', user: { id: MOD }, options: { getSubcommand: () => sub, getUser: () => ({ id: 'target', tag: 'target#0' }), getString: () => o.text ?? null, getInteger: () => o.number ?? null } }) as any;
    assert.match(await note.execute(ctx, i('add', { text: 'first warning given verbally' })) as string, /Note \*\*#1\*\*/);
    assert.match(await note.execute(ctx, i('add', { text: 'second' })) as string, /#2/);
    assert.match(await note.execute(ctx, i('list')) as string, /#2[\s\S]*#1[\s\S]*verbally/);
    await note.execute(ctx, i('remove', { number: 1 }));
    assert.doesNotMatch(await note.execute(ctx, i('list')) as string, /verbally/);
    await assert.rejects(note.execute(ctx, i('remove', { number: 1 })), /does not exist/);
    store.close();
});

test('bot actions done for staff count against that staff member for every action type', () => {
    const guild: any = { client: { user: { id: 'bot' } } };
    for (const action of [AuditLogEvent.MemberBanAdd, AuditLogEvent.MemberKick, AuditLogEvent.MemberRoleUpdate, AuditLogEvent.ChannelUpdate, AuditLogEvent.MemberUpdate])
        assert.equal(responsibleActor({ executorId: 'bot', action, reason: `${MOD}: /role add Admin` } as any, guild), MOD, String(action));
    assert.equal(responsibleActor({ executorId: 'bot', action: AuditLogEvent.ChannelUpdate, reason: 'Ghost Vanguard lockdown by 423456789012345678: raid' } as any, guild), 'bot', 'lockdown stays the bot');
    assert.equal(responsibleActor({ executorId: 'bot', action: AuditLogEvent.MemberKick, reason: 'Ghost Vanguard raid mode: account 0 day(s) old' } as any, guild), 'bot');
    assert.equal(responsibleActor({ executorId: 'human', action: AuditLogEvent.MemberBanAdd, reason: `${MOD}: x` } as any, guild), 'human', 'only the bot\'s own entries are re-attributed');
});

test('raid mode handles young accounts only, skips bots and trusted users, and expires', async () => {
    const store = new Store(':memory:'); authorize(store); store.save(store.settings('g'));
    const logs: any = { push: () => {} };
    const member = (ageDays: number, extra: any = {}) => { const m: any = { id: extra.id ?? 'u', guild: { id: 'g' }, user: { bot: !!extra.bot, tag: 'u#0', createdTimestamp: Date.now() - ageDays * DAY }, kickable: true, moderatable: true, actions: [] as string[] };
        m.kick = async () => m.actions.push('kick'); m.timeout = async (ms: number) => m.actions.push(`timeout:${ms}`); return m; };
    assert.equal(await handleRaidJoin(store, logs, member(1), () => false), 'ignored', 'off by default');
    setRaidMode(store, 'g', true, MOD, { minAgeDays: 7, action: 'kick', hours: 6 });
    const young = member(2); assert.equal(await handleRaidJoin(store, logs, young, () => false), 'kicked'); assert.deepEqual(young.actions, ['kick']);
    assert.equal(await handleRaidJoin(store, logs, member(30), () => false), 'ignored');
    assert.equal(await handleRaidJoin(store, logs, member(1, { bot: true }), () => false), 'ignored');
    assert.equal(await handleRaidJoin(store, logs, member(1, { id: 'staff' }), id => id === 'staff'), 'ignored');
    setRaidMode(store, 'g', true, MOD, { minAgeDays: 3, action: 'timeout' });
    const t = member(1); assert.equal(await handleRaidJoin(store, logs, t, () => false), 'timed out'); assert.match(t.actions[0], /^timeout:/);
    assert.equal(raidState(store, 'g').handled, 1, 'counter resets when raid mode is turned on again');
    setRaidMode(store, 'g', true, MOD, { hours: 1 });
    assert.equal(raidState(store, 'g', Date.now() + 2 * 3600000).enabled, false, 'switches itself off');
    store.close();
});

test('expired temporary bans are lifted and recorded; future ones are kept', async () => {
    const store = new Store(':memory:'); authorize(store); store.save(store.settings('g'));
    store.run('INSERT INTO tempbans VALUES(?,?,?,?,?,?)', 'g', 'gone', Date.now() - 1000, MOD, 'spam', 1);
    store.run('INSERT INTO tempbans VALUES(?,?,?,?,?,?)', 'g', 'later', Date.now() + DAY, MOD, 'spam', 2);
    const removed: string[] = [], logs: any[] = [];
    const client: any = { user: { id: 'bot' }, guilds: { cache: new Map([['g', { id: 'g', bans: { remove: async (id: string) => void removed.push(id) } }]]) } };
    await sweepTempbans(store, { push: (_g: any, e: any) => logs.push(e.toJSON()) } as any, client, () => true);
    assert.deepEqual(removed, ['gone']);
    assert.deepEqual(store.all('SELECT user_id FROM tempbans WHERE guild_id=?', 'g').map(r => r.user_id), ['later']);
    assert.equal(store.get("SELECT action FROM cases WHERE guild_id='g' AND user_id='gone'").action, 'unban');
    assert.match(logs[0].title, /temporary ban expired/);
    store.close();
});

test('/massban is limited to whitelisted staff and never bans protected accounts', async () => {
    assert.deepEqual(parseIds('<@423456789012345678>, 523456789012345678 523456789012345678'), ['423456789012345678', '523456789012345678']);
    assert.throws(() => parseIds('hello'), /Not a Discord user ID/);
    assert.throws(() => parseIds(Array.from({ length: 201 }, (_, n) => String(100000000000000000n + BigInt(n))).join(' ')), /200/);
    const store = new Store(':memory:'); authorize(store);
    const guild: any = { id: 'g', ownerId: 'owner', members: { fetchMe: async () => ({ id: 'bot' }) } };
    const ctx: any = { store, actor: { id: MOD }, security: { trusted: () => false } };
    const i: any = { guildId: 'g', guild, user: { id: MOD }, options: { getString: (n: string) => n === 'user_ids' ? '523456789012345678' : 'raid', getInteger: () => null } };
    await assert.rejects(massban.execute(ctx, i), /whitelist/);
    ctx.security.trusted = (_g: any, id: string) => id === MOD || id === '523456789012345678';
    await assert.rejects(massban.execute(ctx, i), /Every ID was protected/);
    store.close();
});

test('/help sections are in a fixed order and every command belongs to exactly one section', async () => {
    const registry = new Registry(); await registry.load();
    // A module split across two top-level commands (security: /antinuke and /setup) is listed in both sections.
    const listed = [...new Set(HELP_SECTIONS.flatMap(s => s.commands))];
    assert.deepEqual(HELP_SECTIONS.flatMap(s => s.commands).filter((c, n, all) => all.indexOf(c) !== n), ['security'], 'only split modules are listed twice');
    const { RETIRED } = await import('../src/bot/command-tree.js');
    const names = [...registry.commands.values()].map(d => d.data.name).filter(n => !RETIRED.includes(n)).sort();
    assert.deepEqual([...listed].sort(), names, 'every command (except retired shortcuts) has a section');
    assert.deepEqual(HELP_SECTIONS.slice(0, 4).map(s => s.key), ['antinuke', 'automod', 'raid', 'moderation']);
    for (const d of registry.commands.values()) assert.ok((d.data as any).description.length <= 100, d.data.name);
});
