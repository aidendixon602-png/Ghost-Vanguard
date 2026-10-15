import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import { Store } from '../src/database/db.js';
import { authorize } from './helpers.js';
import { DAY } from '../src/security/raidmode.js';
import { handleNewAccountJoin, newAccountConfig, setNewAccountConfig, similarName, registerNewAccountControls } from '../src/security/new-accounts.js';
import { Registry } from '../src/bot/registry.js';
import { Guard } from '../src/bot/guard.js';

const G = '123456789012345678';
function setup() { const store = new Store(':memory:'); authorize(store, G); store.save(store.settings(G)); return store; }
function member(ageDays: number, o: any = {}) {
    const m: any = { id: o.id ?? '223456789012345678', nickname: null, guild: { id: o.guild ?? G }, client: { user: { id: 'bot' } },
        user: { bot: !!o.bot, tag: `${o.name ?? 'newbie'}#0`, username: o.name ?? 'newbie', globalName: o.display ?? null, createdTimestamp: Date.now() - ageDays * DAY },
        moderatable: o.moderatable ?? true, kickable: true, actions: [] as string[] };
    m.timeout = async (ms: number) => m.actions.push(['timeout', ms]); m.kick = async () => m.actions.push(['kick']);
    return m;
}
const logsSink = () => { const out: any[] = []; return { out, logs: { push: (_g: any, e: any, rows: any[] = []) => out.push({ e: e.toJSON(), rows: rows.map((r: any) => r.toJSON()) }) } as any }; };

test('names that differ only by punctuation, case, fancy letters or a digit or two are similar; unrelated names are not', () => {
    for (const [a, b] of [['Gamer_123', 'gamer.1234'], ['xXSlayerXx', 'xxslayerxx2'], ['𝓖𝓪𝓶𝓮𝓻123', 'gamer123'], ['ToxicKid', 'toxickid_alt'], ['banneduser', 'bannedusr']])
        assert.equal(similarName(a, b), true, `${a} ~ ${b}`);
    for (const [a, b] of [['alex', 'alexander'], ['john', 'joan'], ['mike12', 'mike'], ['Midtown', 'Downtown'], ['abc', 'abd'], ['', 'anything']])
        assert.equal(similarName(a, b), false, `${a} !~ ${b}`);
});

test('on by default: a 2-day-old account is held until it turns 7 days old, with a case and a staff alert', async () => {
    const store = setup(), { out, logs } = logsSink();
    assert.deepEqual(newAccountConfig(store, G), { enabled: true, minAgeDays: 7, action: 'hold' });
    const m = member(2);
    assert.equal(await handleNewAccountJoin(store, logs, m, () => false, Date.now(), []), 'held');
    const ms = m.actions[0][1]; assert.ok(ms > 4.9 * DAY && ms < 5.1 * DAY, 'held for the remaining ~5 days');
    assert.equal(store.get('SELECT action FROM cases WHERE guild_id=?', G).action, 'new-account hold');
    assert.match(out[0].e.description, /2 day\(s\) old/);
    assert.deepEqual(out[0].rows[0].components.map((c: any) => c.label), ['Let in', 'Kick', 'Ban']);
    store.close();
});

test('old accounts, bots, whitelisted users and a switched-off rule are left alone', async () => {
    const store = setup(), { out, logs } = logsSink();
    assert.equal(await handleNewAccountJoin(store, logs, member(30), () => false, Date.now(), []), 'ignored');
    assert.equal(await handleNewAccountJoin(store, logs, member(1, { bot: true }), () => false, Date.now(), []), 'ignored');
    assert.equal(await handleNewAccountJoin(store, logs, member(1, { id: '323456789012345678' }), id => id === '323456789012345678', Date.now(), []), 'ignored');
    setNewAccountConfig(store, G, 'staff', { enabled: false });
    assert.equal(await handleNewAccountJoin(store, logs, member(1), () => false, Date.now(), []), 'ignored');
    assert.equal(out.length, 0); store.close();
});

test('kick and alert-only modes, custom age, and a clear message when Vanguard cannot act', async () => {
    const store = setup(), { out, logs } = logsSink();
    setNewAccountConfig(store, G, 'staff', { minAgeDays: 30, action: 'kick' });
    const k = member(20); assert.equal(await handleNewAccountJoin(store, logs, k, () => false, Date.now(), []), 'kicked'); assert.deepEqual(k.actions, [['kick']]);
    assert.equal(out[0].rows.length, 0, 'no buttons once kicked');
    setNewAccountConfig(store, G, 'staff', { action: 'alert' });
    const a = member(1); assert.equal(await handleNewAccountJoin(store, logs, a, () => false, Date.now(), []), 'alerted'); assert.deepEqual(a.actions, []);
    setNewAccountConfig(store, G, 'staff', { action: 'hold' });
    assert.equal(await handleNewAccountJoin(store, logs, member(1, { moderatable: false }), () => false, Date.now(), []), 'failed');
    assert.match(out.at(-1).e.description, /Timeout Members/); store.close();
});

test('a new account whose name resembles a banned account is flagged as possible ban evasion', async () => {
    const store = setup(), { out, logs } = logsSink();
    const banned = [{ id: '923456789012345678', tag: 'ToxicKid#0', reason: 'harassment', names: ['ToxicKid'] }];
    await handleNewAccountJoin(store, logs, member(0, { name: 'toxic_kid2', guild: '777777777777777777' }), () => false, Date.now(), banned);
    assert.equal(out[0].e.title, 'New account · possible ban evasion');
    assert.match(out[0].e.description, /ToxicKid#0[\s\S]*harassment/);
    assert.equal(out[0].rows[0].components.at(-1).label, 'Ban (evasion)');
    await handleNewAccountJoin(store, logs, member(0, { id: '423456789012345679', name: 'friendlyperson', guild: '777777777777777777' }), () => false, Date.now(), banned);
    assert.equal(out[1].e.title, 'New account joined'); store.close();
});

test('only five individual alerts per minute; the rest are summarized', async () => {
    const store = setup(), { out, logs } = logsSink();
    for (let n = 0; n < 8; n++) await handleNewAccountJoin(store, logs, member(1, { id: String(500000000000000000n + BigInt(n)), guild: '999999999999999999' }), () => false, Date.now(), []);
    assert.equal(out.length, 5); store.close();
});

test('alert buttons: Let in lifts the hold; Ban needs Ban Members and records a case', async () => {
    const store = setup();
    const registry = new Registry(); registerNewAccountControls(registry);
    const control = registry.components.find(c => c.prefix === 'newacct:')!;
    const target = member(1); target.bannable = true;
    const bans: string[] = []; let replied = '';
    const highest = { comparePositionTo: () => 1 };
    const guild = { id: G, ownerId: 'owner', members: { fetch: async () => target, fetchMe: async () => ({ id: 'bot', roles: { highest } }), ban: async (id: string) => void bans.push(id) } };
    target.roles = { highest: {} };
    const i = (customId: string, perms: bigint) => ({ customId, guildId: G, guild, message: { embeds: [{ title: 'New account joined', description: 'x' }], edit: async () => {} }, editReply: async (p: any) => { replied = p.content; } }) as any;
    const ctx = (perms: bigint): any => ({ store, actor: { id: 'mod', guild, roles: { highest }, permissions: new PermissionsBitField(perms) } });
    await control.execute(ctx(PermissionsBitField.Flags.ModerateMembers), i(`newacct:release:${target.id}`, 0n));
    assert.deepEqual(target.actions[0], ['timeout', null]); assert.match(replied, /let in/);
    await assert.rejects(control.execute(ctx(PermissionsBitField.Flags.ModerateMembers), i(`newacct:ban:${target.id}`, 0n)), /Ban Members/);
    await control.execute(ctx(PermissionsBitField.Flags.ModerateMembers | PermissionsBitField.Flags.BanMembers), i(`newacct:ban:${target.id}`, 0n));
    assert.deepEqual(bans, [target.id]); assert.equal(store.get('SELECT action FROM cases WHERE guild_id=?', G).action, 'ban');
    store.close();
});

for (const action of ['release', 'kick', 'ban'])
for (const failure of ['higher target', 'unavailable membership'])
test(`new-account ${action} refuses ${failure} without Discord mutations`, async () => {
    const store = setup();
    const registry = new Registry(); registerNewAccountControls(registry);
    const control = registry.components.find(c => c.prefix === 'newacct:')!;
    const target = member(1); target.bannable = true; target.roles = { highest: { position: 20 } };
    let bans = 0;
    const guild: any = { id: G, ownerId: 'owner', members: {
        fetch: async () => { if (failure === 'unavailable membership') throw { code: 50013 }; return target; },
        fetchMe: async () => ({ id: 'bot', roles: { highest: { comparePositionTo: () => 1 } } }),
        ban: async () => { bans++; },
    } };
    const actor = { id: 'mod', guild, roles: { highest: { comparePositionTo: () => -1 } }, permissions: new PermissionsBitField(PermissionsBitField.All) };
    try {
        await assert.rejects(control.execute({ store, actor } as any, { guild, guildId: G, customId: `newacct:${action}:${target.id}`, editReply: async () => {} }), /higher role|Could not confirm target membership/);
        assert.equal(bans, 0);
        assert.deepEqual(target.actions, []);
    } finally { store.close(); }
});

test('new-account ban controls do not require the unrelated Timeout Members permission', () => {
    const store = setup();
    const registry = new Registry(); registerNewAccountControls(registry);
    const control = registry.components.find(c => c.prefix === 'newacct:')!;
    const actor: any = { id: 'mod', guild: { id: G, ownerId: 'owner' }, roles: { cache: new Map() }, permissions: new PermissionsBitField(PermissionsBitField.Flags.BanMembers) };
    try { assert.equal(new Guard(store).allowed(control.metadata, G, actor.id, actor, 'newacct'), true); }
    finally { store.close(); }
});
