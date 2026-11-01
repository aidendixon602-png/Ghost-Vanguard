import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, ChannelType, Collection, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { authorize } from './helpers.js';
import { Store } from '../src/database/db.js';
import { FAST_ATTEMPTS, LogQueue, SLOW_RETRY_MS } from '../src/logging.js';
import { redact } from '../src/audit/redact.js';
import { configureEventLog, describeAudit, eventLogConfig, recordEvent, recordMemberEvent, recordVoiceEvent } from '../src/audit/event-log.js';
import { checkChannel, LEGACY_LOG_ROUTES, logChannels, setLogChannels, setupLogChannels } from '../src/audit/log-setup.js';
import { reportBotError } from '../src/audit/bot-errors.js';
import { Security } from '../src/security/security.js';

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

test('compact log cards show mentions once while stored history keeps full target details', () => {
    const store = new Store(':memory:'); authorize(store, G);
    const posted: any[] = [];
    const logs: any = { push: (_g: string, e: any) => posted.push(e.toJSON()) };
    try {
        configureEventLog(store, G, { enabled: true, channelId: 'log' });
        recordEvent(store, logs, G, { category: 'members', action: 'Roles Updated', actorId: 'mod1', targetId: '12345678901234567',
            target: '<@12345678901234567> (andrey)', author: { name: 'andrey' }, details: ['**Roles added:** <@&r1>'] }, { compact: true });
        const card = posted[0]!;
        assert.equal(card.author, undefined);
        assert.deepEqual(card.fields.map((f: any) => f.name), ['Target', 'By', 'Roles added']);
        assert.equal(card.fields[0].value, '<@12345678901234567>');
        assert.equal(card.fields[1].value, '<@mod1>');
        assert.equal(card.footer.text, 'Ghost Vanguard');
        const stored = store.get('SELECT target,summary FROM event_log WHERE guild_id=?', G)!;
        assert.equal(stored.target, '<@12345678901234567> (andrey)');
        assert.match(stored.summary, /andrey/);
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

function fakeGuild(existing: string[] = [], o: { everyoneCanView?: boolean; botPerms?: bigint[]; categories?: string[]; legacyChildren?: string[] } = {}) {
    const channels = new Collection<string, any>();
    const created: any[] = [];
    const sentTo: string[] = [];
    const makeText = (id: string, name: string, parentId: string | null = null) => {
        const channel: any = {
            id, name, type: ChannelType.GuildText, parentId, isTextBased: () => true,
            permissionsFor: (who: any) => ({ has: (bit: bigint) => who === 'everyone' ? !!o.everyoneCanView : (o.botPerms ?? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory]).includes(bit) }),
            send: async () => { sentTo.push(id); },
            setParent: async (parent: string) => { channel.parentId = parent; return channel; },
        };
        channels.set(id, channel);
        return channel;
    };
    const makeCategory = (id: string, name: string) => {
        const category: any = {
            id, name, type: ChannelType.GuildCategory, position: 10,
            setPosition: async (position: number) => { category.position = position; return category; },
            edit: async (change: any) => { Object.assign(category, change); return category; },
        };
        channels.set(id, category);
        return category;
    };
    let next = 0;
    const categoryIds = (o.categories ?? []).map((name, n) => makeCategory(`91000000000000000${n}`, name).id);
    existing.forEach(name => makeText(`90000000000000000${next++}`, name));
    (o.legacyChildren ?? []).forEach(name => makeText(`92000000000000000${next++}`, name, categoryIds[0] ?? null));
    const guild: any = {
        id: G, client: { user: { id: BOT } },
        roles: { everyone: 'everyone', cache: new Collection([['800000000000000001', {}]]) },
        members: { me: { permissions: { has: () => true } }, fetchMe: async () => guild.members.me },
        channels: {
            cache: channels,
            fetch: async (id: string) => channels.get(id) ?? null,
            create: async (opts: any) => {
                const id = `9500000000000000${created.length}`;
                const c = opts.type === ChannelType.GuildCategory ? makeCategory(id, opts.name) : makeText(id, opts.name);
                created.push(opts);
                return c;
            },
        },
    };
    (guild.roles.everyone as any) = 'everyone';
    return { guild, created, sentTo };
}

test('setup creates private #bans and #ghost-vanguard-logging once, then reuses them', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        await store.withAuthorized(G, async () => store.run("INSERT INTO staff_roles(guild_id,role_id,level) VALUES(?,?,'admin')", G, '800000000000000001'));
        const { guild, created } = fakeGuild();
        const first = await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        assert.deepEqual(created.map(c => c.name), ['bans', 'ghost-vanguard-logging', 'Ghost Vanguard Logs']);
        assert.equal(first.category.name, 'Ghost Vanguard Logs');
        assert.equal(first.category.position, 0);
        assert.equal(first.bans.channel.parentId, first.category.id);
        assert.equal(first.logging.channel.parentId, first.category.id);
        const overwrites = created[0].permissionOverwrites;
        assert.deepEqual(overwrites[0].deny, [PermissionFlagsBits.ViewChannel], '@everyone cannot see the log channels');
        assert.ok(overwrites.some((o: any) => o.id === '800000000000000001' && o.allow.includes(PermissionFlagsBits.ViewChannel)), 'staff can read them');
        assert.equal(logChannels(store, G).bansChannelId, first.bans.channel.id);
        assert.equal(eventLogConfig(store, G).channelId, first.logging.channel.id);
        assert.equal(store.settings(G).logChannelId, first.logging.channel.id, 'bot actions go to the logging channel');
        await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        assert.equal(created.length, 3, 'running setup again creates nothing new');
    } finally { store.close(); }
});

test('setup reuses channels that already exist by name', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild, created } = fakeGuild(['bans', 'ghost-vanguard-logging']);
        const result = await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        assert.equal(created.length, 1, 'only the category is created for existing channels');
        assert.equal(result.categoryCreated, true);
        assert.equal(result.category.position, 0);
        assert.equal(result.bans.how, 'existing channel reused');
        assert.equal(result.logging.how, 'existing channel reused');
    } finally { store.close(); }
});

test('setup reuses recognized Veil channels and preserves unrelated archived channels', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild } = fakeGuild(['bans', 'ghost-vanguard-logging'], { categories: ['VEIL LOGS'], legacyChildren: ['veil-errors', 'join-logs'] });
        const oldCategory = guild.channels.cache.find((c: any) => c.type === ChannelType.GuildCategory && c.name === 'VEIL LOGS');
        const oldChannels = ['veil-errors', 'join-logs'].map(name => guild.channels.cache.find((c: any) => c.name === name));
        const result = await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        assert.equal(oldCategory.name, 'Archive - Veil Logs');
        assert.equal(result.archivedCategories[0], oldCategory.id);
        assert.equal(oldChannels[0].parentId, oldCategory.id, 'unrecognized legacy channels remain archived');
        assert.equal(oldChannels[1].parentId, result.category.id, 'join logs become active without replacing the channel');
        assert.equal(logChannels(store, G).routes.joins, oldChannels[1].id);
        assert.equal(result.bans.channel.parentId, result.category.id);
        assert.equal(result.logging.channel.parentId, result.category.id);
        assert.equal(guild.channels.cache.size, 6, 'no old category or log channels are deleted');
    } finally { store.close(); }
});

test('setup activates each existing legacy channel and is repeatable without duplicates', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild, created } = fakeGuild(['bans', 'ghost-vanguard-logging'], { categories: ['Archive - Veil Logs'], legacyChildren: Object.values(LEGACY_LOG_ROUTES) });
        const original = new Map([...guild.channels.cache.values()].filter((c: any) => Object.values(LEGACY_LOG_ROUTES).includes(c.name)).map((c: any) => [c.name, c.id]));
        const result = await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        for (const [key, name] of Object.entries(LEGACY_LOG_ROUTES)) {
            assert.equal((result.routes as any)[key], original.get(name));
            assert.equal(guild.channels.cache.get(original.get(name)).parentId, result.category.id);
        }
        await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        assert.equal(created.length, 1);
        assert.deepEqual(logChannels(store, G).routes, result.routes);
    } finally { store.close(); }
});

test('unsafe legacy channels are not activated or moved', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild } = fakeGuild(['bans', 'ghost-vanguard-logging'], { categories: ['Archive - Veil Logs'], legacyChildren: ['message-logs'], everyoneCanView: true });
        const channel = guild.channels.cache.find((c: any) => c.name === 'message-logs');
        const parent = channel.parentId;
        const result = await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        assert.equal(channel.parentId, parent);
        assert.equal(result.routes.messages, undefined);
        assert.equal(result.skipped[0]?.route, 'messages');
        assert.equal(result.skipped[0]?.check.publiclyVisible, true);
    } finally { store.close(); }
});

test('setup rechecks renamed or moved saved destinations before keeping routes', async () => {
    for (const state of ['safe', 'public', 'missing-permission', 'missing']) {
        const store = new Store(':memory:'); authorize(store, G);
        try {
            const { guild } = fakeGuild(['bans', 'ghost-vanguard-logging'], { categories: ['Archive - Veil Logs'], legacyChildren: ['message-logs'] });
            const channel = guild.channels.cache.find((c: any) => c.name === 'message-logs');
            setLogChannels(store, G, { routes: { messages: channel.id } });
            channel.name = 'old-records'; channel.parentId = 'elsewhere';
            if (state === 'public') channel.permissionsFor = () => ({ has: () => true });
            if (state === 'missing-permission') channel.permissionsFor = () => ({ has: () => false });
            if (state === 'missing') guild.channels.cache.delete(channel.id);
            const result = await setupLogChannels(store, guild, 'owner');
            assert.equal(logChannels(store, G).routes?.messages, state === 'safe' ? channel.id : undefined, state);
            assert.equal(result.skipped.some(s => s.route === 'messages'), state !== 'safe', state);
        } finally { store.close(); }
    }
});

test('setup recovers routes moved by an interrupted earlier setup', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild } = fakeGuild(['bans', 'ghost-vanguard-logging'], { categories: ['Ghost Vanguard Logs'], legacyChildren: ['role-logs'] });
        const roleLog = guild.channels.cache.find((c: any) => c.name === 'role-logs');
        const result = await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        assert.equal(result.routes.roles, roleLog.id);
    } finally { store.close(); }
});

test('event categories, joins and voice route to existing channels with fallback and exclusions', () => {
    const store = new Store(':memory:'); authorize(store, G);
    const sends: any[] = [], logs: any = { push: (_g: string, e: any, _rows: any, channel: string) => sends.push({ channel, card: e.toJSON() }) };
    try {
        configureEventLog(store, G, { enabled: true, channelId: 'general-log' });
        setLogChannels(store, G, { routes: { joins: 'join-log', voice: 'voice-log', messages: 'message-log' }, excludedChannels: ['private'] });
        recordMemberEvent(store, logs, { id: 'u', user: null, guild: { id: G } } as any, true);
        recordEvent(store, logs, G, { category: 'messages', action: 'Deleted' });
        recordEvent(store, logs, G, { category: 'roles', action: 'Role created' });
        recordVoiceEvent(store, logs, { channelId: null } as any, { id: 'u', guild: { id: G }, channelId: 'voice' } as any);
        recordVoiceEvent(store, logs, { channelId: 'voice' } as any, { id: 'u', guild: { id: G }, channelId: 'voice' } as any);
        recordVoiceEvent(store, logs, { channelId: null } as any, { id: 'u', guild: { id: G }, channelId: 'private' } as any);
        recordVoiceEvent(store, logs, { channelId: 'private' } as any, { id: 'u', guild: { id: G }, channelId: 'voice' } as any);
        assert.deepEqual(sends.map(s => s.channel), ['join-log', 'message-log', 'general-log', 'voice-log']);
        configureEventLog(store, G, { category: ['members', false] });
        recordMemberEvent(store, logs, { id: 'u', user: null, guild: { id: G } } as any, true);
        assert.equal(sends.length, 4);
    } finally { store.close(); }
});

test('anti-nuke alerts keep their original delivery and also reach the dedicated channel', () => {
    const store = new Store(':memory:'); authorize(store, G);
    const sends: any[] = [], logs: any = { push: (_g: string, _e: any, _rows: any, channel: string | undefined) => sends.push(channel) };
    try {
        const settings = store.settings(G); settings.logChannelId = 'security'; store.save(settings);
        setLogChannels(store, G, { routes: { antinuke: 'anti' } });
        (new Security(store, logs) as any).incidentLog(G, new EmbedBuilder().setTitle('Incident'));
        assert.deepEqual(sends, [undefined, 'anti']);
        sends.length = 0;
        setLogChannels(store, G, { routes: { antinuke: 'security' } });
        (new Security(store, logs) as any).incidentLog(G, new EmbedBuilder().setTitle('Incident'));
        assert.deepEqual(sends, [undefined]);
    } finally { store.close(); }
});

test('a server still using the old #midtown-vanguard-logging name keeps it instead of getting a second channel', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild, created } = fakeGuild(['bans', 'midtown-vanguard-logging']);
        const result = await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        assert.equal(created.length, 1, 'only the active log category is created; no duplicate log channel is created');
        assert.equal(result.logging.channel.name, 'midtown-vanguard-logging', 'the saved channel is reused as it is');
        assert.equal(result.logging.how, 'existing channel reused (still named #midtown-vanguard-logging)');
        assert.equal(eventLogConfig(store, G).channelId, result.logging.channel.id);
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

test('manual routes validate privacy, persist without moving channels, and reset', async () => {
    const { default: command } = await import('../src/commands/configuration/logs.js');
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild } = fakeGuild(['bans', 'ghost-vanguard-logging', 'chosen']);
        const channel = guild.channels.cache.find((c: any) => c.name === 'chosen');
        let chosen: any = channel;
        const ctx: any = { store };
        const i: any = { guildId: G, guild, user: { id: 'owner' }, options: { getSubcommand: () => 'route', getString: () => 'messages', getChannel: () => chosen } };
        await command.execute(ctx, i);
        assert.equal(logChannels(store, G).routes?.messages, channel.id);
        assert.equal(channel.parentId, null);
        await setupLogChannels(store, guild, 'owner');
        assert.equal(logChannels(store, G).routes?.messages, channel.id, 'automatic setup retains manual routes');
        channel.permissionsFor = () => ({ has: () => true });
        await assert.rejects(command.execute(ctx, i), /private text channel/);
        chosen = null; await command.execute(ctx, i);
        assert.equal(logChannels(store, G).routes?.messages, undefined);
        assert.equal(command.subcommands?.['cleanup-archive']?.access, 'owner');
    } finally { store.close(); }
});

test('archive cleanup deletes only previewed inactive children and retains new or moved channels', async () => {
    const { archivePlan, deleteArchive } = await import('../src/audit/archive-cleanup.js');
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild } = fakeGuild([], { categories: ['Archive - Veil Logs'], legacyChildren: ['old', 'active', 'moved'] });
        const cache = guild.channels.cache;
        const old = cache.find((c: any) => c.name === 'old');
        const active = cache.find((c: any) => c.name === 'active');
        const moved = cache.find((c: any) => c.name === 'moved');
        const parent = old.parentId;
        const deleted: string[] = [];
        for (const c of cache.values()) c.delete = async () => { deleted.push(c.id); cache.delete(c.id); };
        const plan = archivePlan(guild, store);
        setLogChannels(store, G, { routes: { messages: active.id } });
        moved.parentId = 'elsewhere';
        cache.set('new', { id: 'new', parentId: parent });
        await deleteArchive(guild, store, plan, 'owner');
        assert.deepEqual(deleted, [old.id]);
        assert.ok(cache.has(active.id) && cache.has(moved.id) && cache.has('new') && cache.has(parent));
    } finally { store.close(); }
});

test('voice logs include mute and streaming changes without attributing an unknown moderator', () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        configureEventLog(store, G, { enabled: true, channelId: 'log' });
        setLogChannels(store, G, { routes: { voice: 'voice-log' } });
        const cards: any[] = [];
        const logs: any = { push: (_g: string, card: any) => cards.push(card.toJSON()) };
        const old: any = { guild: { id: G }, id: 'member', channelId: 'voice', serverMute: false, streaming: false };
        recordVoiceEvent(store, logs, old, { ...old, serverMute: true, streaming: true });
        assert.equal(cards.length, 1);
        assert.match(JSON.stringify(cards), /serverMute|streaming/);
        assert.doesNotMatch(JSON.stringify(cards), /"name":"By"/);
        setLogChannels(store, G, { routes: {} });
        recordVoiceEvent(store, logs, old, { ...old, channelId: 'other' });
        assert.equal(cards.length, 2, 'voice events fall back to combined logging without a route');
        recordVoiceEvent(store, logs, { ...old, selfMute: null }, { ...old, selfMute: false });
        assert.equal(cards.length, 2, 'unknown previous values do not create synthetic toggles');
    } finally { store.close(); }
});
