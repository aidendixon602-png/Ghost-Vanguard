import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, Collection, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { Store } from '../src/database/db.js';
import { authorize } from './helpers.js';
import { setFeature } from '../src/features/settings.js';
import { autoRaid, canApproveBot, lockServerSettings, PLUS_DEFAULTS, quarantineNewBot, settingsRevert } from '../src/features/antinuke-plus.js';
import { aiAction, checkContent, readVerdict } from '../src/features/ai-moderation.js';
import { raidState, setRaidMode } from '../src/security/raidmode.js';

const G = '123456789012345678', U = '223456789012345678', BOT = '999999999999999999', NEWBOT = '888888888888888888';
const setup = () => { const store = new Store(':memory:'); authorize(store, G); const s = store.settings(G); s.enabled = true; s.mode = 'enforce'; store.save(s); const logs: any[] = []; return { store, logs, queue: { push: (_g: string, e: any, rows?: any[]) => logs.push({ e: e.toJSON(), rows }) } as any }; };

test('a join flood switches raid mode on by itself, for the configured hours, unless turned off', () => {
    const { store } = setup();
    try {
        assert.match(autoRaid(store, G), /switched on automatically for 1 hour/);
        assert.equal(raidState(store, G).enabled, true);
        assert.ok(raidState(store, G).until! > Date.now() + 3500000);
        assert.match(autoRaid(store, G), /already on/);
        const { store: s2 } = setup();
        setFeature(s2, G, 'antinukeplus', PLUS_DEFAULTS, { raidAuto: false });
        assert.match(autoRaid(s2, G), /auto-trigger is off/); assert.equal(raidState(s2, G).enabled, false); s2.close();
    } finally { store.close(); }
});

test('server settings changes map back to the right edit, including the old icon from the CDN', () => {
    const guild: any = { id: G };
    const r = settingsRevert({ changes: [{ key: 'name', old: 'Midtown', new: 'NUKED' }, { key: 'icon_hash', old: 'abc', new: 'def' }, { key: 'verification_level', old: 3, new: 0 }, { key: 'unknown', old: 1, new: 2 }] } as any, guild);
    assert.deepEqual(r.labels, ['name', 'icon', 'verification level']);
    assert.equal(r.edit.name, 'Midtown'); assert.equal(r.edit.verificationLevel, 3);
    assert.equal(r.edit.icon, `https://cdn.discordapp.com/icons/${G}/abc.png?size=1024`);
});

test('settings lock puts changes back for non-whitelisted people only', async () => {
    const { store, queue, logs } = setup();
    try {
        const edits: any[] = [];
        const guild: any = { id: G, client: { user: { id: BOT } }, members: { fetchMe: async () => ({ permissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild) }) }, edit: async (e: any) => { edits.push(e); } };
        const entry = (by: string) => ({ action: AuditLogEvent.GuildUpdate, executorId: by, changes: [{ key: 'name', old: 'Midtown', new: 'NUKED' }] }) as any;
        await lockServerSettings(store, queue, entry(U), guild, () => true);
        assert.equal(edits.length, 0, 'whitelisted');
        await lockServerSettings(store, queue, entry(BOT), guild, () => false);
        assert.equal(edits.length, 0, 'Vanguard itself');
        await lockServerSettings(store, queue, entry(U), guild, () => false);
        assert.equal(edits[0].name, 'Midtown'); assert.match(logs[0].e.title, /restored/);
        store.grant(G, U, 'trust:guild_update', 'owner');
        await lockServerSettings(store, queue, entry(U), guild, () => false);
        assert.equal(edits.length, 1, 'a "server settings" whitelist entry also allows it');
    } finally { store.close(); }
});

test('a powerful new bot added by an admin is held until approved; the owner\'s bots are not', async () => {
    const { store, queue, logs } = setup();
    try {
        let perms = BigInt(PermissionFlagsBits.Administrator) | BigInt(PermissionFlagsBits.SendMessages);
        const role: any = { get permissions() { return new PermissionsBitField(perms); }, editable: true, setPermissions: async (p: bigint) => { perms = p; } };
        const member = (adder: string): any => ({ id: NEWBOT, user: { bot: true }, roles: { botRole: role }, guild: { id: G, ownerId: 'owner', fetchAuditLogs: async () => ({ entries: new Collection([['e', { targetId: NEWBOT, executorId: adder }]]) }) } });
        await quarantineNewBot(store, queue, member('owner'));
        assert.equal(logs.length, 0, 'the server owner may add powerful bots');
        assert.ok(perms & BigInt(PermissionFlagsBits.Administrator), 'the owner\'s bot keeps Administrator');
        await quarantineNewBot(store, queue, member(U));
        assert.equal(perms & BigInt(PermissionFlagsBits.Administrator), 0n, 'Administrator removed');
        assert.equal(perms & BigInt(PermissionFlagsBits.SendMessages), BigInt(PermissionFlagsBits.SendMessages), 'harmless permissions kept');
        assert.match(logs[0].e.title, /held for approval/);
        assert.ok(store.get('SELECT value FROM runtime_meta WHERE key=?', `botq:${G}:${NEWBOT}`), 'original permissions saved for Approve');
    } finally { store.close(); }
});

test('AI sensitivity, ignored kinds (never minors) and what each mode does', () => {
    const result = { flagged: true, categories: { harassment: true, 'sexual/minors': true, violence: false }, category_scores: { harassment: 0.7, 'sexual/minors': 0.9, violence: 0.5 } };
    assert.deepEqual(readVerdict(result, 'normal').categories.sort(), ['harassment', 'sexual/minors']);
    assert.deepEqual(readVerdict(result, 'low').categories, ['sexual/minors'], 'low: only 85%+');
    assert.deepEqual(readVerdict(result, 'high').categories.sort(), ['harassment', 'sexual/minors', 'violence'], 'high: also 40%+');
    assert.deepEqual(readVerdict(result, 'normal', ['harassment', 'sexual']).categories, ['sexual/minors'], 'minors can never be ignored');
    const v = (top: number, selfHarm = false) => ({ flagged: true, categories: ['x'], top, selfHarm });
    assert.equal(aiAction('report', v(0.99)), 'report');
    assert.equal(aiAction('delete', v(0.85)), 'delete'); assert.equal(aiAction('delete', v(0.6)), 'report');
    assert.equal(aiAction('strict', v(0.95)), 'delete+timeout'); assert.equal(aiAction('strict', v(0.82)), 'delete');
    assert.equal(aiAction('strict', v(0.99, true)), 'report', 'self-harm is never punished');
});

test('batch 2 review: new layers do nothing in observe mode, and auto raid keeps the server\'s raid settings', async () => {
    const { store, queue, logs } = setup();
    try {
        setRaidMode(store, G, true, U, { minAgeDays: 30, action: 'timeout' }); setRaidMode(store, G, false, U);
        assert.equal(raidState(store, G).minAgeDays, 30, 'turning raid mode off keeps its settings');
        autoRaid(store, G);
        assert.equal(raidState(store, G).minAgeDays, 30); assert.equal(raidState(store, G).action, 'timeout');
        const s = store.settings(G); s.mode = 'observe'; store.save(s);
        setRaidMode(store, G, false, U);
        assert.match(autoRaid(store, G), /observe mode/); assert.equal(raidState(store, G).enabled, false);
        const edits: any[] = [];
        const guild: any = { id: G, client: { user: { id: BOT } }, members: { fetchMe: async () => ({ permissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild) }) }, edit: async (e: any) => { edits.push(e); } };
        await lockServerSettings(store, queue, { action: AuditLogEvent.GuildUpdate, executorId: U, changes: [{ key: 'name', old: 'Midtown', new: 'X' }] } as any, guild, () => false);
        assert.equal(edits.length, 0, 'observe mode only watches');
        let perms = BigInt(PermissionFlagsBits.Administrator);
        const role: any = { get permissions() { return new PermissionsBitField(perms); }, editable: true, setPermissions: async (p: bigint) => { perms = p; } };
        await quarantineNewBot(store, queue, { id: NEWBOT, user: { bot: true }, roles: { botRole: role }, guild: { id: G, ownerId: 'owner', fetchAuditLogs: async () => ({ entries: new Collection() }) } } as any);
        assert.ok(perms & BigInt(PermissionFlagsBits.Administrator), 'observe mode does not hold bots'); assert.equal(logs.length, 0);
    } finally { store.close(); }
});

test('batch 2 review: settings lock honours role whitelists and restores what it can when an old image is gone', async () => {
    const { store, queue, logs } = setup();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('', { status: 404 })) as any;
    try {
        const edits: any[] = [];
        const guild: any = { id: G, client: { user: { id: BOT } }, channels: { cache: new Collection(), fetch: async () => null }, members: { fetchMe: async () => ({ permissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild) }) }, edit: async (e: any) => { edits.push(e); } };
        const entry = { action: AuditLogEvent.GuildUpdate, executorId: U, changes: [{ key: 'name', old: 'Midtown', new: 'X' }, { key: 'icon_hash', old: 'gone', new: 'new' }, { key: 'rules_channel_id', old: '555', new: '666' }] } as any;
        await lockServerSettings(store, queue, entry, guild, () => false, (_id, rule) => rule === 'guild_update');
        assert.equal(edits.length, 0, 'a role-based "server settings" whitelist allows it');
        await lockServerSettings(store, queue, entry, guild, () => false, () => false);
        assert.equal(edits.length, 1); assert.equal(edits[0].name, 'Midtown');
        assert.equal('icon' in edits[0], false, 'the missing image is skipped'); assert.equal('rulesChannel' in edits[0], false, 'the deleted channel is skipped');
        assert.match(logs[0].e.description, /Could not put back: icon \(old image is gone\), rules channel/);
        assert.equal(settingsRevert({ changes: [{ key: 'banner_hash', old: 'a_xyz' }] } as any, { id: G } as any).edit.banner, `https://cdn.discordapp.com/banners/${G}/a_xyz.gif?size=2048`, 'animated banners stay animated');
    } finally { globalThis.fetch = realFetch; store.close(); }
});

test('batch 2 review: who may approve a held bot', () => {
    const ADMIN = BigInt(PermissionFlagsBits.Administrator), BAN = BigInt(PermissionFlagsBits.BanMembers);
    const base = { ownerId: 'owner', adder: 'adder', supreme: false, rank: 4, userPerms: BAN, held: BAN };
    assert.equal(canApproveBot({ ...base, user: 'owner', rank: 0, userPerms: 0n }), null, 'the owner');
    for (const opts of [{ ...base, user: 'x', supreme: true }, { ...base, user: 'adder' }, { ...base, user: 'mod', rank: 2 }, { ...base, user: 'ha', held: ADMIN }, { ...base, user: 'ha' }])
        assert.match(canApproveBot(opts)!, /Only the current server owner/, 'ranks and Discord permissions cannot approve a held bot');
});

test('batch 2 review: AI keeps flagged minors content at low sensitivity, and retries text-only when an image is refused', async () => {
    assert.deepEqual(readVerdict({ flagged: true, categories: { 'sexual/minors': true }, category_scores: { 'sexual/minors': 0.5 } }, 'low').categories, ['sexual/minors']);
    const bodies: any[] = [];
    const fake = (async (_u: string, init: any) => { const b = JSON.parse(init.body); bodies.push(b); return typeof b.input === 'string'
        ? new Response(JSON.stringify({ results: [{ flagged: true, categories: { harassment: true }, category_scores: { harassment: 0.9 } }] }), { status: 200 })
        : new Response('{}', { status: 400 }); }) as any;
    const v = await checkContent('you are trash', ['https://cdn.discordapp.com/x.svg'], 'normal', [], fake);
    assert.equal(bodies.length, 2); assert.equal(typeof bodies[1].input, 'string'); assert.deepEqual(v?.categories, ['harassment']);
});
