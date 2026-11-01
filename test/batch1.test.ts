import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { Store } from '../src/database/db.js';
import { authorize } from './helpers.js';
import { setFeature } from '../src/features/settings.js';
import { activeWarnings, escalateWarnings, warnStep, WARN_DEFAULTS } from '../src/features/warn-points.js';
import { readVerdict } from '../src/features/ai-moderation.js';
import { addToBlacklist, blacklistEntry, NETWORK_DEFAULTS, removeFromBlacklist, rolesForRank } from '../src/features/roblox-tools.js';
import { logDeletedMessage, logEditedMessage } from '../src/features/message-logs.js';
import { configureEventLog } from '../src/audit/event-log.js';
import { startEmergency, stopEmergency, emergencyOn, EMERGENCY_REASON } from '../src/features/emergency.js';
import { reportWebhook } from '../src/features/webhooks.js';
import { AuditLogEvent } from 'discord.js';

const G = '123456789012345678', G2 = '133456789012345678', U = '223456789012345678', M = '323456789012345678', BOT = '999999999999999999';
const setup = () => { const store = new Store(':memory:'); authorize(store, G); authorize(store, G2); const logs: any[] = []; return { store, logs, queue: { push: (_g: string, e: any, rows?: any[], ch?: string) => logs.push({ e: e.toJSON(), rows, ch }) } as any }; };

test('warning levels: timeout, then kick, then ban; 0 turns a level off', () => {
    const c = { ...WARN_DEFAULTS, banAt: 7 };
    assert.equal(warnStep(c, 2), null); assert.equal(warnStep(c, 3), 'timeout'); assert.equal(warnStep(c, 5), 'kick'); assert.equal(warnStep(c, 9), 'ban');
    assert.equal(warnStep({ ...c, kickAt: 0 }, 5), 'timeout');
    assert.equal(warnStep({ ...c, enabled: false }, 9), null);
});

test('warnings expire, a pardon wipes them, and the third warning times the member out', async () => {
    const { store, queue, logs } = setup();
    try {
        const now = Date.now();
        store.recordCase(G, U, M, 'warn', 'old'); store.run('UPDATE cases SET at=? WHERE guild_id=?', now - 40 * 86400000, G);
        store.recordCase(G, U, M, 'warn', 'a'); store.recordCase(G, U, M, 'warn', 'b');
        assert.equal(activeWarnings(store, G, U), 2, 'a 40-day-old warning no longer counts');
        let timedOut = 0;
        const guild: any = { id: G, client: { user: { id: BOT } }, members: { fetch: async () => ({ moderatable: true, kickable: true, timeout: async () => { timedOut++; } }), ban: async () => { } } };
        store.recordCase(G, U, M, 'warn', 'c');
        const msg = await escalateWarnings(store, queue, guild, U, M);
        assert.equal(timedOut, 1); assert.match(msg, /3\*\* warnings and were automatically \*\*timed out/);
        assert.match(JSON.stringify(logs), /automatic timeout/);
        store.recordCase(G, U, M, 'pardon', 'fresh start');
        assert.equal(activeWarnings(store, G, U), 0);
        setFeature(store, G, 'warnpoints', WARN_DEFAULTS, { enabled: false });
        assert.equal(await escalateWarnings(store, queue, guild, U, M), '');
    } finally { store.close(); }
});

test('AI verdicts: flagged categories, confidence, and self-harm is treated gently', () => {
    const v = readVerdict({ flagged: true, categories: { harassment: true, hate: false }, category_scores: { harassment: 0.91, hate: 0.2 } });
    assert.deepEqual(v.categories, ['harassment']); assert.equal(v.flagged, true); assert.equal(v.selfHarm, false); assert.equal(Math.round(v.top * 100), 91);
    assert.equal(readVerdict({ flagged: true, categories: { 'self-harm': true }, category_scores: { 'self-harm': 0.8 } }).selfHarm, true);
    assert.equal(readVerdict({ flagged: false, categories: {} }).flagged, false);
    assert.equal(readVerdict(undefined).flagged, false);
});

test('Roblox blacklist: local entries, opt-in network sharing between servers, and removal', () => {
    const { store } = setup();
    try {
        addToBlacklist(store, G, '555', 'raider');
        assert.equal(blacklistEntry(store, G, '555')?.reason, 'raider');
        assert.equal(blacklistEntry(store, G2, '555'), null, 'not shared by default');
        setFeature(store, G, 'network', NETWORK_DEFAULTS, { share: true });
        addToBlacklist(store, G, '666', 'nuker (by Mod#0001)');
        assert.equal(blacklistEntry(store, G2, '666'), null, 'the other server must opt in to use it');
        setFeature(store, G2, 'network', NETWORK_DEFAULTS, { use: true });
        assert.equal(blacklistEntry(store, G2, '666'), null, 'not partners yet');
        store.db.prepare('INSERT INTO network_partners(guild_id,partner_id) VALUES(?,?)').run(G2, G);
        assert.equal(blacklistEntry(store, G2, '666'), null, 'a one-sided partner request does nothing');
        store.db.prepare('INSERT INTO network_partners(guild_id,partner_id) VALUES(?,?)').run(G, G2);
        assert.match(blacklistEntry(store, G2, '666')!.reason, /^Blacklisted \(in a partner server\)$/, 'partners see a plain reason, not the moderator or IDs');
        assert.equal(blacklistEntry(store, G2, '666')!.network, true);
        assert.equal(removeFromBlacklist(store, G, '666'), true);
        assert.equal(blacklistEntry(store, G2, '666'), null, 'removal also leaves the network');
        assert.equal(removeFromBlacklist(store, G, '666'), false);
    } finally { store.close(); }
});

test('renamed Roblox sharing command retains blacklist sharing settings', async () => {
    const { default: command } = await import('../src/commands/roblox/roblox.js');
    const { store, queue } = setup();
    try {
        const options = (command.data as any).options;
        assert.ok(options.some((o: any) => o.name === 'sharing'));
        assert.ok(!options.some((o: any) => o.name === 'network'));
        addToBlacklist(store, G, '555', 'raider');
        const i: any = { guildId: G, user: { id: M }, client: { guilds: { cache: new Map() } },
            options: { getSubcommand: () => 'sharing', getBoolean: () => true } };
        const reply = await command.execute({ store, logs: queue } as any, i);
        assert.match(String(reply), /sharing.*on/);
        assert.equal(store.get('SELECT roblox_id FROM roblox_network WHERE guild_id=?', G)?.roblox_id, '555');
        assert.equal(store.get('SELECT COUNT(*) AS n FROM guild_features WHERE guild_id=? AND key=?', G, 'network')?.n, 1);
    } finally { store.close(); }
});

test('group rank binds: "and above" vs exact, and rank 0 (not in group) gets nothing', () => {
    const binds = [{ rank: 1, roleId: 'member', mode: 'min' as const }, { rank: 50, roleId: 'staff', mode: 'min' as const }, { rank: 255, roleId: 'owner', mode: 'exact' as const }];
    assert.deepEqual([...rolesForRank(binds, 0)], []);
    assert.deepEqual([...rolesForRank(binds, 10)].sort(), ['member']);
    assert.deepEqual([...rolesForRank(binds, 60)].sort(), ['member', 'staff']);
    assert.deepEqual([...rolesForRank(binds, 255)].sort(), ['member', 'owner', 'staff']);
});

test('deleted and edited messages are logged with their text when message logging is on', () => {
    const { store, queue, logs } = setup();
    try {
        const msg = (content: string | null, bot = false) => ({ guildId: G, channelId: 'c', partial: content === null, content, author: { id: U, bot, username: 'u' }, webhookId: null, attachments: new Collection(), url: 'https://discord.com/x' }) as any;
        logDeletedMessage(store, queue, msg('hello there'));
        assert.equal(logs.length, 0, 'event logging is off by default');
        store.withAuthorized(G, async () => configureEventLog(store, G, { enabled: true, channelId: '444444444444444444' }));
        logDeletedMessage(store, queue, msg('hello there'));
        assert.match(JSON.stringify(logs[0].e), /Message Deleted/); assert.match(JSON.stringify(logs[0].e), /hello there/);
        assert.equal(logs[0].e.author, undefined, 'message author is shown once in the field');
        assert.equal(logs[0].e.fields.find((field: any) => field.name === 'Author')?.value, `<@${U}>`);
        assert.equal(logs[0].e.footer.text, 'Ghost Vanguard');
        logDeletedMessage(store, queue, msg(null));
        assert.match(JSON.stringify(logs[1].e), /Unavailable \(message sent before Vanguard started\)/);
        logDeletedMessage(store, queue, msg('bot text', true));
        logEditedMessage(store, queue, msg('same'), msg('same'));
        assert.equal(logs.length, 2, 'bots and unchanged edits are skipped');
        logEditedMessage(store, queue, msg('before'), msg('after'));
        assert.match(JSON.stringify(logs[2].e), /"name":"Before","value":"before"/); assert.match(JSON.stringify(logs[2].e), /"name":"After","value":"after"/);
    } finally { store.close(); }
});

test('emergency mode locks, pauses invites, turns on raid mode and pings admins; all clear undoes only its own changes', async () => {
    const { store, queue, logs } = setup();
    try {
        store.run('INSERT INTO staff_roles(guild_id,role_id,level) VALUES(?,?,?)', G, '777777777777777777', 'admin');
        store.save({ ...store.settings(G), logChannelId: '444444444444444444' });
        const sent: any[] = []; const invites: boolean[] = []; const ran: string[] = [];
        const guild: any = { id: G, features: [], roles: { cache: new Collection([['777777777777777777', {}]]) }, channels: { cache: new Collection(), fetch: async () => ({ isSendable: () => true, send: async (p: any) => sent.push(p) }) },
            disableInvites: async (v: boolean) => { invites.push(v); }, client: { user: { id: BOT } } };
        const locks = { run: async (_ids: string[], fn: () => Promise<any>) => { ran.push('lock'); store.run('INSERT INTO lockdowns(guild_id,started_by,started_at,reason,message) VALUES(?,?,?,?,?)', G, U, Date.now(), EMERGENCY_REASON, 'x'); return { locked: 3, total: 3 }; } };
        const msg = await startEmergency({ store, logs: queue, locks }, guild, U);
        assert.match(msg, /Emergency mode is ON/); assert.deepEqual(invites, [true]); assert.equal(emergencyOn(store, G), true);
        assert.equal(store.get('SELECT enabled FROM raidmode WHERE guild_id=?', G)?.enabled, 1);
        assert.deepEqual(sent[0].allowedMentions.roles, ['777777777777777777'], 'admin roles are pinged');
        // All clear: our lockdown is lifted (unlock is routed through locks.run).
        const unlocks: string[] = [];
        const stopLocks = { run: async () => { unlocks.push('unlock'); store.run('DELETE FROM lockdowns WHERE guild_id=?', G); return { restored: 3, total: 3 }; } };
        const done = await stopEmergency({ store, logs: queue, locks: stopLocks }, guild, U);
        assert.match(done, /All clear/); assert.deepEqual(unlocks, ['unlock']); assert.deepEqual(invites, [true, false]);
        assert.equal(store.get('SELECT enabled FROM raidmode WHERE guild_id=?', G)?.enabled, 0);
        await assert.rejects(stopEmergency({ store, logs: queue, locks: stopLocks }, guild, U), /not on/);
        assert.ok(logs.some(l => /Emergency mode OFF/.test(l.e.title)));
    } finally { store.close(); }
});

test('new webhooks made by people (not Vanguard) are reported with a Delete button', () => {
    const { store, queue, logs } = setup();
    try {
        const guild: any = { id: G, client: { user: { id: BOT } } };
        reportWebhook(store, queue, { action: AuditLogEvent.WebhookCreate, targetId: '888888888888888888', executorId: U, target: { name: 'Hook', channelId: '1' } } as any, guild);
        reportWebhook(store, queue, { action: AuditLogEvent.WebhookCreate, targetId: '888888888888888889', executorId: BOT } as any, guild);
        reportWebhook(store, queue, { action: AuditLogEvent.ChannelCreate, targetId: '1', executorId: U } as any, guild);
        assert.equal(logs.length, 1); assert.match(logs[0].e.title, /New webhook/);
        assert.equal(logs[0].rows[0].toJSON().components[0].custom_id, 'webhook:delete:888888888888888888');
    } finally { store.close(); }
});

test('a second emergency press changes nothing, and all clear leaves raid mode on if it was already on', async () => {
    const { store, queue } = setup();
    try {
        const { setRaidMode } = await import('../src/security/raidmode.js');
        setRaidMode(store, G, true, M);
        const guild: any = { id: G, features: [], roles: { cache: new Collection() }, channels: { fetch: async () => null }, disableInvites: async () => { }, client: { user: { id: BOT } } };
        const locks = { run: async () => ({ locked: 1, total: 1, restored: 1 }) };
        await startEmergency({ store, logs: queue, locks }, guild, U);
        assert.match(await startEmergency({ store, logs: queue, locks }, guild, U), /already on/);
        const done = await stopEmergency({ store, logs: queue, locks }, guild, U);
        assert.match(done, /Raid mode left on/);
        assert.equal(store.get('SELECT enabled FROM raidmode WHERE guild_id=?', G)?.enabled, 1);
    } finally { store.close(); }
});

test('warn escalation: a ban level needs someone who may ban', async () => {
    const { store, queue } = setup();
    try {
        setFeature(store, G, 'warnpoints', WARN_DEFAULTS, { banAt: 2 });
        store.recordCase(G, U, M, 'warn', 'a'); store.recordCase(G, U, M, 'warn', 'b');
        let banned = 0;
        const guild: any = { id: G, client: { user: { id: BOT }, users: { fetch: async () => ({ bot: false, send: async () => { } }) } }, name: 'S', members: { fetch: async () => ({}), ban: async () => { banned++; } } };
        assert.match(await escalateWarnings(store, queue, guild, U, M, false), /Ask a Moderator/);
        assert.equal(banned, 0);
        assert.match(await escalateWarnings(store, queue, guild, U, M, true), /automatically \*\*banned/);
        assert.equal(banned, 1);
    } finally { store.close(); }
});
