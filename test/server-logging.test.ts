import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, ChannelType, Collection, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { authorize } from './helpers.js';
import { Store } from '../src/database/db.js';
import { FAST_ATTEMPTS, LogQueue, SLOW_RETRY_MS } from '../src/logging.js';
import { redact } from '../src/audit/redact.js';
import { configureEventLog, describeAudit, eventLogConfig, recordEvent } from '../src/audit/event-log.js';
import { checkChannel, logChannels, setLogChannels, setupLogChannels } from '../src/audit/log-setup.js';
import { reportBotError } from '../src/audit/bot-errors.js';

const G = '500000000000000001', BOT = '600000000000000001';

// ------------------------------------------------------------ delivery

function queueWith(send: (p: any) => Promise<any>) {
    const store = new Store(':memory:');
    authorize(store, G);
    const client: any = { isReady: () => true, channels: { fetch: async () => ({ id: 'c', isSendable: () => true, send }) } };
    const logs = new LogQueue(store, client);
    logs.canDeliver = () => true;
    return { store, logs };
}

test('a log entry that cannot be delivered is kept and retried, then sent exactly once', async () => {
    let fail = true; const sent: any[] = [];
    const { store, logs } = queueWith(async p => { if (fail) throw new Error('Missing Access'); sent.push(p); return { id: 'm' }; });
    try {
        logs.push(G, new EmbedBuilder().setTitle('Incident'), [], 'c');
        await logs.flush();
        assert.equal(sent.length, 0);
        const row = store.get('SELECT * FROM outbox WHERE guild_id=?', G)!;
        assert.equal(row.attempts, 1, 'the failed entry is saved for retry');
        fail = false;
        store.run('UPDATE outbox SET next_at=0 WHERE guild_id=?', G);
        await logs.flush();
        await logs.flush();
        assert.equal(sent.length, 1, 'delivered once, never twice');
        assert.equal(sent[0].nonce, `mv${row.id}`);
        assert.equal(sent[0].enforceNonce, true, 'Discord rejects a second post with the same nonce');
        assert.equal(store.get('SELECT COUNT(*) AS n FROM outbox WHERE guild_id=?', G)!.n, 0);
    } finally { store.close(); }
});

test('after repeated failures an entry keeps retrying every 30 minutes instead of being dropped', async () => {
    const { store, logs } = queueWith(async () => { throw new Error('channel gone'); });
    const error = console.error; console.error = () => {};
    try {
        logs.push(G, new EmbedBuilder().setTitle('x'), [], 'c');
        for (let n = 0; n < FAST_ATTEMPTS + 2; n++) { store.run('UPDATE outbox SET next_at=0 WHERE guild_id=?', G); await logs.flush(); }
        const row = store.get('SELECT * FROM outbox WHERE guild_id=?', G)!;
        assert.equal(row.attempts, FAST_ATTEMPTS + 2, 'still queued');
        assert.ok(row.next_at - Date.now() > SLOW_RETRY_MS - 5000);
    } finally { console.error = error; store.close(); }
});

// ------------------------------------------------------------ credentials

test('credentials are never logged', () => {
    const token = ['MTExMTExMTExMTExMTExMTExMQ', 'AbCdEf', 'FAKEfakeFAKEfakeFAKEfakeFAKEfakeFAKEfa'].join('.');
    assert.equal(redact(`here ${token} oops`), 'here [token hidden] oops');
    assert.match(redact('OPENAI_API_KEY=sk-proj-FAKEkeyFAKEkeyFAKEkeyFAKEkey00'), /^OPENAI_API_KEY=\[(key )?hidden\]$/);
    assert.equal(redact('key sk-proj-FAKEkeyFAKEkeyFAKEkeyFAKEkey00'), 'key [key hidden]');
    assert.equal(redact('https://discord.com/api/webhooks/123/abcDEF-xyz'), '[webhook URL hidden]');
    assert.equal(redact('password: hunter2'), 'password: [hidden]');
    assert.equal(redact('a normal message about tokens'), 'a normal message about tokens');
});

test('deleted message text containing a token is stored and posted with it hidden', () => {
    const store = new Store(':memory:'); authorize(store, G);
    const posted: any[] = [];
    const logs: any = { push: (_g: string, e: any) => posted.push(e.toJSON()) };
    try {
        configureEventLog(store, G, { enabled: true, channelId: 'log' });
        const token = ['MTExMTExMTExMTExMTExMTExMQ', 'AbCdEf', 'FAKEfakeFAKEfakeFAKEfakeFAKEfakeFAKEfa'].join('.');
        recordEvent(store, logs, G, { category: 'messages', action: 'Message Deleted', details: [`**Content:** my token is ${token}`] });
        assert.doesNotMatch(JSON.stringify(posted), /FAKEfake/);
        assert.doesNotMatch(String(store.get('SELECT summary FROM event_log WHERE guild_id=?', G)!.summary), /FAKEfake/);
    } finally { store.close(); }
});

// ------------------------------------------------------------ layout, exclusions, routine bot changes

test('events render as compact embeds: fields, avatar, IDs and an "unavailable" actor when not verified', () => {
    const store = new Store(':memory:'); authorize(store, G);
    const posted: any[] = [];
    const logs: any = { push: (_g: string, e: any) => posted.push(e.toJSON()) };
    try {
        configureEventLog(store, G, { enabled: true, channelId: 'log' });
        recordEvent(store, logs, G, { category: 'messages', action: '🗑️ Message Deleted', targetId: 'u1', author: { name: 'urloffy', iconURL: 'https://a/b.png' }, actorUnverified: true, actorLabel: 'Deleted by',
            details: ['**Channel:** <#c1>', '**Message ID:** `m1`', '**Content:** hi'] });
        const e = posted[0];
        assert.equal(e.author.name, 'urloffy');
        assert.equal(e.author.icon_url, 'https://a/b.png');
        assert.deepEqual(e.fields.map((f: any) => f.name), ['Deleted by', 'Channel', 'Message ID', 'Content']);
        assert.equal(e.fields[0].value, 'Unavailable (could not be verified)');
        assert.match(e.footer.text, /ID: u1/);
        assert.ok(e.timestamp);
    } finally { store.close(); }
});

test('excluded channels are not logged; routine bot channel renames are skipped unless turned back on', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    const posted: any[] = [];
    const logs: any = { push: (_g: string, e: any) => posted.push(e.toJSON()) };
    try {
        configureEventLog(store, G, { enabled: true, channelId: 'log' });
        await store.withAuthorized(G, async () => setLogChannels(store, G, { excludedChannels: ['staff-chat'] }));
        assert.equal(recordEvent(store, logs, G, { category: 'messages', action: 'Message Deleted', channelId: 'staff-chat' }), false);
        assert.equal(recordEvent(store, logs, G, { category: 'messages', action: 'Message Deleted', channelId: 'general' }), true);
        const counterBot = { id: '700000000000000001', bot: true };
        const guild: any = { id: G, client: { user: { id: BOT }, users: { cache: new Collection([[counterBot.id, counterBot]]) } } };
        const rename = { id: '1', action: AuditLogEvent.ChannelUpdate, executorId: counterBot.id, executor: counterBot, targetId: 'vc', createdTimestamp: Date.now(), changes: [{ key: 'name', old: 'Members: 10', new: 'Members: 11' }] } as any;
        assert.equal(describeAudit(rename, guild), null, 'member-count renames are skipped by default');
        assert.equal(describeAudit(rename, guild, { ignoreBotRoutine: false })!.action, 'Channel Updated');
        const perms = { ...rename, changes: [{ key: 'nsfw', old: false, new: true }] };
        assert.ok(describeAudit(perms, guild), 'other bot changes are still logged');
        assert.equal(logChannels(store, G).ignoreBotRoutine, true);
    } finally { store.close(); }
});

test('nickname changes, roles and kicks have clear titles and verified actors', () => {
    const guild: any = { id: G, client: { user: { id: BOT }, users: { cache: new Collection() } } };
    const user = { tag: 'urloffy', username: 'urloffy', displayAvatarURL: () => 'https://a/b.png' };
    const base = { id: '1', executorId: '323456789012345678', targetId: '400000000000000001', target: user, createdTimestamp: Date.now() };
    const nick = describeAudit({ ...base, action: AuditLogEvent.MemberUpdate, changes: [{ key: 'nick', old: 'old', new: 'new' }] } as any, guild)!;
    assert.equal(nick.action, 'Nickname Changed');
    assert.deepEqual(nick.details, ['**Old nickname:** old', '**New nickname:** new']);
    assert.equal(nick.author!.iconURL, 'https://a/b.png');
    const roles = describeAudit({ ...base, action: AuditLogEvent.MemberRoleUpdate, changes: [{ key: '$add', new: [{ id: 'r1' }] }, { key: '$remove', new: [{ id: 'r2' }] }] } as any, guild)!;
    assert.equal(roles.action, 'Roles Updated');
    assert.deepEqual(roles.details, ['**Roles added:** <@&r1>', '**Roles removed:** <@&r2>']);
    assert.equal(roles.actorId, '323456789012345678');
    const kick = describeAudit({ ...base, action: AuditLogEvent.MemberKick, changes: [], reason: 'spam' } as any, guild)!;
    assert.equal(kick.action, 'Member Kicked');
    assert.equal(kick.actorLabel, 'Moderator');
});

// ------------------------------------------------------------ setup

function fakeGuild(existing: string[] = [], o: { everyoneCanView?: boolean; botPerms?: bigint[] } = {}) {
    const channels = new Collection<string, any>();
    const created: any[] = [];
    const sentTo: string[] = [];
    const make = (id: string, name: string) => ({
        id, name, type: ChannelType.GuildText, isTextBased: () => true,
        permissionsFor: (who: any) => ({ has: (bit: bigint) => who === 'everyone' ? !!o.everyoneCanView : (o.botPerms ?? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory]).includes(bit) }),
        send: async () => { sentTo.push(id); },
    });
    existing.forEach((name, n) => channels.set(`90000000000000000${n}`, make(`90000000000000000${n}`, name)));
    const guild: any = {
        id: G, client: { user: { id: BOT } },
        roles: { everyone: 'everyone', cache: new Collection([['800000000000000001', {}]]) },
        members: { me: { permissions: { has: () => true } }, fetchMe: async () => guild.members.me },
        channels: {
            cache: channels,
            fetch: async (id: string) => channels.get(id) ?? null,
            create: async (opts: any) => { const c = make(`95000000000000000${created.length}`, opts.name); channels.set(c.id, c); created.push(opts); return c; },
        },
    };
    (guild.roles.everyone as any) = 'everyone';
    return { guild, created, sentTo };
}

test('setup creates private #bans and #midtown-vanguard-logging once, then reuses them', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        await store.withAuthorized(G, async () => store.run("INSERT INTO staff_roles(guild_id,role_id,level) VALUES(?,?,'admin')", G, '800000000000000001'));
        const { guild, created } = fakeGuild();
        const first = await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        assert.deepEqual(created.map(c => c.name), ['bans', 'midtown-vanguard-logging']);
        const overwrites = created[0].permissionOverwrites;
        assert.deepEqual(overwrites[0].deny, [PermissionFlagsBits.ViewChannel], '@everyone cannot see the log channels');
        assert.ok(overwrites.some((o: any) => o.id === '800000000000000001' && o.allow.includes(PermissionFlagsBits.ViewChannel)), 'staff can read them');
        assert.equal(logChannels(store, G).bansChannelId, first.bans.channel.id);
        assert.equal(eventLogConfig(store, G).channelId, first.logging.channel.id);
        assert.equal(store.settings(G).logChannelId, first.logging.channel.id, 'bot actions go to the logging channel');
        await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        assert.equal(created.length, 2, 'running setup again creates nothing new');
    } finally { store.close(); }
});

test('setup reuses channels that already exist by name', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild, created } = fakeGuild(['bans', 'midtown-vanguard-logging']);
        const result = await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        assert.equal(created.length, 0);
        assert.equal(result.bans.how, 'existing channel reused');
    } finally { store.close(); }
});

test('the setup check reports missing permissions and public channels, and sends a test embed when it can', async () => {
    const ok = fakeGuild(['bans']);
    const good = await checkChannel(ok.guild, '900000000000000000', 'ban logs');
    assert.deepEqual([good.ok, good.test, ok.sentTo.length], [true, 'sent', 1]);
    const broken = fakeGuild(['bans'], { everyoneCanView: true, botPerms: [PermissionFlagsBits.ViewChannel] });
    const bad = await checkChannel(broken.guild, '900000000000000000', 'ban logs');
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.missing, ['Send Messages', 'Embed Links', 'Read Message History']);
    assert.equal(bad.publiclyVisible, true);
    assert.equal(bad.test, 'skipped');
    assert.equal(broken.sentTo.length, 0);
});

test('background errors are reported to staff once per 10 minutes, without secrets', () => {
    const store = new Store(':memory:'); authorize(store, G);
    const posted: any[] = [];
    const logs: any = { push: (_g: string, e: any) => posted.push(e.toJSON()) };
    try {
        const now = Date.now();
        assert.equal(reportBotError(store, logs, G, 'ban log', new Error('boom sk-proj-FAKEkeyFAKEkeyFAKEkeyFAKEkey00'), now), true);
        assert.equal(reportBotError(store, logs, G, 'ban log', new Error('boom'), now + 1000), false);
        assert.equal(reportBotError(store, logs, G, 'ban log', new Error('boom'), now + 11 * 60000), true);
        assert.equal(reportBotError(store, logs, G, 'audit', new Error('AUTHORIZATION_ERROR'), now), false, 'expected errors are not reported');
        assert.doesNotMatch(JSON.stringify(posted), /FAKEkey/);
        assert.doesNotMatch(JSON.stringify(posted), /at .*\.ts/, 'no stack traces');
    } finally { store.close(); }
});
