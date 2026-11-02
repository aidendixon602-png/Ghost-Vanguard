import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, ChannelType, Collection, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { authorize } from './helpers.js';
import { Store } from '../src/database/db.js';
import { FAST_ATTEMPTS, LogQueue, SLOW_RETRY_MS } from '../src/logging.js';
import { redact } from '../src/audit/redact.js';
import { configureEventLog, describeAudit, eventLogConfig, LOG_CATEGORIES, recordEvent, recordMemberEvent, recordVoiceEvent } from '../src/audit/event-log.js';
import { applyLogMerge, checkChannel, describeRouteSetup, LEGACY_LOG_ROUTES, logChannels, pacing, planLogMerge, routesWithoutChannel, setLogChannels, setupLogChannels } from '../src/audit/log-setup.js';
import { reportBotError } from '../src/audit/bot-errors.js';
import { Security } from '../src/security/security.js';

const G = '500000000000000001', BOT = '600000000000000001';

// Setup waits half a second between its changes to the server. The tests do not sit through that:
// the wait is skipped here, and the tests that check it record the pauses (see recordingPauses).
const realSleep = pacing.sleep;
pacing.sleep = async () => { };

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

function fakeGuild(existing: string[] = [], o: { everyoneCanView?: boolean; botPerms?: bigint[]; categories?: string[]; legacyChildren?: string[]; failCreate?: (name: string) => string | undefined; slowCreate?: boolean; timeline?: string[] } = {}) {
    const channels = new Collection<string, any>();
    const created: any[] = [];
    const sentTo: string[] = [];
    const makeText = (id: string, name: string, parentId: string | null = null) => {
        const channel: any = {
            id, name, type: ChannelType.GuildText, parentId, isTextBased: () => true,
            permissionsFor: (who: any) => ({ has: (bit: bigint) => who === 'everyone' ? !!o.everyoneCanView : (o.botPerms ?? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory]).includes(bit) }),
            send: async () => { sentTo.push(id); },
            setParent: async (parent: string) => { o.timeline?.push(`move ${channel.name}`); channel.parentId = parent; return channel; },
            edit: async (change: any) => { o.timeline?.push(`rename ${channel.name}`); Object.assign(channel, change); return channel; },
        };
        channels.set(id, channel);
        return channel;
    };
    const makeCategory = (id: string, name: string) => {
        const category: any = {
            id, name, type: ChannelType.GuildCategory, position: 10,
            setPosition: async (position: number) => { o.timeline?.push(`position ${category.name}`); category.position = position; return category; },
            edit: async (change: any) => { o.timeline?.push(`rename ${category.name}`); Object.assign(category, change); return category; },
        };
        channels.set(id, category);
        return category;
    };
    let next = 0;
    const categoryIds = (o.categories ?? []).map((name, n) => makeCategory(`91000000000000000${n}`, name).id);
    existing.forEach(name => makeText(`90000000000000000${next++}`, name));
    (o.legacyChildren ?? []).forEach(name => makeText(`92000000000000000${next++}`, name, categoryIds[0] ?? null));
    const guild: any = {
        id: G, name: 'Test Server', client: { user: { id: BOT } },
        roles: { everyone: 'everyone', cache: new Collection([['800000000000000001', { id: '800000000000000001', position: 1 }]]) },
        members: { me: { permissions: { has: () => true }, roles: { highest: { id: '800000000000000009', position: 50 } } }, fetchMe: async () => guild.members.me },
        channels: {
            cache: channels,
            fetch: async (id: string) => channels.get(id) ?? null,
            create: async (opts: any) => {
                o.timeline?.push(`create ${opts.name}`);
                const failure = o.failCreate?.(opts.name);
                if (failure) throw new Error(failure);
                if (o.slowCreate) await new Promise(resolve => setTimeout(resolve, 2));
                const id = `9500000000000000${created.length}`;
                const c = opts.type === ChannelType.GuildCategory ? makeCategory(id, opts.name) : makeText(id, opts.name, opts.parent ?? null);
                created.push(opts);
                return c;
            },
        },
    };
    (guild.roles.everyone as any) = 'everyone';
    return { guild, created, sentTo };
}

const channelNamed = (guild: any, name: string) => guild.channels.cache.find((c: any) => c.name === name);
const TYPE_CHANNELS: string[] = Object.values(LEGACY_LOG_ROUTES);

test('setup creates private #bans, #ghost-vanguard-logging and a channel for every log type, once', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        await store.withAuthorized(G, async () => store.run("INSERT INTO staff_roles(guild_id,role_id,level) VALUES(?,?,'admin')", G, '800000000000000001'));
        const { guild, created } = fakeGuild();
        const first = await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        assert.deepEqual(created.map(c => c.name), ['bans', 'ghost-vanguard-logging', 'Ghost Vanguard Logs', ...TYPE_CHANNELS]);
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
        for (const [route, name] of Object.entries(LEGACY_LOG_ROUTES)) {
            const options = created.find(c => c.name === name), channel = channelNamed(guild, name);
            assert.equal(channel.parentId, first.category.id, `#${name} is inside Ghost Vanguard Logs`);
            assert.equal(options.parent, first.category.id, `#${name} is created in the category, so an interrupted setup can be resumed`);
            assert.equal(logChannels(store, G).routes?.[route as keyof typeof LEGACY_LOG_ROUTES], channel.id, `${route} events are sent to #${name}`);
            assert.deepEqual(options.permissionOverwrites[0].deny, [PermissionFlagsBits.ViewChannel], `#${name} is hidden from @everyone`);
            assert.ok(options.permissionOverwrites.some((o: any) => o.id === '800000000000000001' && o.allow.includes(PermissionFlagsBits.ViewChannel)), `staff can read #${name}`);
        }
        assert.deepEqual(first.created, Object.keys(LEGACY_LOG_ROUTES));
        assert.equal(first.failed, null);
        await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        assert.equal(created.length, 3 + TYPE_CHANNELS.length, 'running setup again creates nothing new');
    } finally { store.close(); }
});

test('setup reuses channels that already exist by name', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild, created } = fakeGuild(['bans', 'ghost-vanguard-logging']);
        const result = await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        assert.deepEqual(created.map(c => c.name), ['Ghost Vanguard Logs', ...TYPE_CHANNELS], 'bans and the server log are reused; only the category and the log type channels are new');
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
        const before = [...guild.channels.cache.keys()];
        const result = await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        assert.equal(oldCategory.name, 'Archive - Veil Logs');
        assert.equal(result.archivedCategories[0], oldCategory.id);
        assert.equal(oldChannels[0].parentId, oldCategory.id, 'unrecognized legacy channels remain archived');
        assert.equal(oldChannels[1].parentId, result.category.id, 'join logs become active without replacing the channel');
        assert.equal(logChannels(store, G).routes.joins, oldChannels[1].id);
        assert.equal(result.bans.channel.parentId, result.category.id);
        assert.equal(result.logging.channel.parentId, result.category.id);
        assert.ok(before.every(id => guild.channels.cache.has(id)), 'no old category or log channels are deleted');
        assert.deepEqual(result.created, Object.keys(LEGACY_LOG_ROUTES).filter(route => route !== 'joins'), 'every other log type gets a channel, but #join-logs is not duplicated');
        assert.equal(guild.channels.cache.filter((c: any) => c.name === 'join-logs').size, 1);
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

test('unsafe legacy channels are not activated or moved, and a private channel is created in their place', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild, created } = fakeGuild(['bans', 'ghost-vanguard-logging'], { categories: ['Archive - Veil Logs'], legacyChildren: ['message-logs'] });
        const channel = channelNamed(guild, 'message-logs');
        channel.permissionsFor = () => ({ has: () => true });
        const parent = channel.parentId;
        const result = await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        assert.equal(channel.parentId, parent, 'the public channel stays in the archive');
        assert.equal(result.skipped[0]?.route, 'messages');
        assert.equal(result.skipped[0]?.check.publiclyVisible, true);
        const replacement = created.find(c => c.name === 'message-logs');
        assert.ok(replacement, 'a new private #message-logs is created');
        assert.notEqual(result.routes.messages, channel.id);
        assert.equal(guild.channels.cache.get(result.routes.messages!).parentId, result.category.id);
        const summary = describeRouteSetup(result);
        assert.equal(summary.attention, false, 'the replacement works, so nothing is left to fix');
        assert.match(summary.lines.join('\n'), /Not reused \(a new private #message-logs was created instead\)/);

        // With per-type channels turned off, the unsafe channel is simply not activated.
        const off = fakeGuild(['bans', 'ghost-vanguard-logging'], { categories: ['Archive - Veil Logs'], legacyChildren: ['message-logs'] });
        const publicChannel = channelNamed(off.guild, 'message-logs');
        publicChannel.permissionsFor = () => ({ has: () => true });
        const skippedOnly = await store.withAuthorized(G, () => setupLogChannels(store, off.guild, 'admin', {}, { separate: false }));
        assert.equal(skippedOnly.routes.messages, undefined);
        assert.equal(describeRouteSetup(skippedOnly).attention, true);
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
            const result = await setupLogChannels(store, guild, 'owner', {}, { separate: false });
            assert.equal(logChannels(store, G).routes?.messages, state === 'safe' ? channel.id : undefined, state);
            assert.equal(result.skipped.some(s => s.route === 'messages'), state !== 'safe', state);
        } finally { store.close(); }
    }
});

test('an unsafe or deleted saved destination is replaced by a new private channel, and a safe one is kept', async () => {
    for (const state of ['safe', 'public', 'missing-permission', 'missing']) {
        const store = new Store(':memory:'); authorize(store, G);
        try {
            const { guild, created } = fakeGuild(['bans', 'ghost-vanguard-logging'], { categories: ['Archive - Veil Logs'], legacyChildren: ['message-logs'] });
            const channel = channelNamed(guild, 'message-logs');
            setLogChannels(store, G, { routes: { messages: channel.id } });
            channel.name = 'old-records'; channel.parentId = 'elsewhere';
            if (state === 'public') channel.permissionsFor = () => ({ has: () => true });
            if (state === 'missing-permission') channel.permissionsFor = () => ({ has: () => false });
            if (state === 'missing') guild.channels.cache.delete(channel.id);
            const result = await setupLogChannels(store, guild, 'owner');
            const routed = logChannels(store, G).routes?.messages;
            if (state === 'safe') {
                assert.equal(routed, channel.id, 'a working destination chosen earlier is never replaced');
                assert.ok(!created.some(c => c.name === 'message-logs'));
            } else {
                assert.notEqual(routed, channel.id, state);
                assert.equal(guild.channels.cache.get(routed!).name, 'message-logs', state);
                assert.deepEqual(result.created.includes('messages'), true, state);
            }
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

test('setup gives every log type its own channel, and each kind of event lands in the right one', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild } = fakeGuild();
        const result = await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        const routes = logChannels(store, G).routes as Record<string, string>;
        assert.deepEqual(Object.keys(routes).sort(), Object.keys(LEGACY_LOG_ROUTES).sort(), 'every log type has a channel');
        assert.equal(new Set(Object.values(routes)).size, TYPE_CHANNELS.length, 'no two types share a channel');
        assert.ok(![result.bans.channel.id, result.logging.channel.id].some(id => Object.values(routes).includes(id)), 'bans and the combined log are separate from the type channels');
        assert.deepEqual(routesWithoutChannel(store, G), []);
        const sends: any[] = [], logs: any = { push: (_g: string, _e: any, _rows: any, channel: string) => sends.push(channel) };
        for (const category of LOG_CATEGORIES) recordEvent(store, logs, G, { category, action: 'Something happened' });
        assert.deepEqual(sends, LOG_CATEGORIES.map(category => routes[category]), 'each event category posts to its own channel');
        sends.length = 0;
        recordMemberEvent(store, logs, { id: 'u', user: null, guild: { id: G } } as any, true);
        recordVoiceEvent(store, logs, { channelId: null } as any, { id: 'u', guild: { id: G }, channelId: 'voice' } as any);
        assert.deepEqual(sends, [routes.joins, routes.voice], 'joins and voice have their own channels too');
    } finally { store.close(); }
});

test('where only #message-logs exists, setup reuses it and creates the other nine', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild, created } = fakeGuild(['bans', 'midtown-vanguard-logging'], { categories: ['Archive - Veil Logs'], legacyChildren: ['message-logs'] });
        const old = channelNamed(guild, 'message-logs');
        const result = await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        const routes = logChannels(store, G).routes as Record<string, string>;
        assert.equal(routes.messages, old.id, 'the existing channel keeps its history and is the message log');
        assert.equal(old.parentId, result.category.id, 'it moves into Ghost Vanguard Logs');
        assert.equal(result.created.length, 9);
        assert.ok(!result.created.includes('messages'));
        assert.deepEqual(created.map(c => c.name).filter(name => TYPE_CHANNELS.includes(name)).sort(), TYPE_CHANNELS.filter(name => name !== 'message-logs').sort());
        for (const name of TYPE_CHANNELS)
            assert.equal(guild.channels.cache.filter((c: any) => c.name === name).size, 1, `exactly one #${name}`);
        const lines = describeRouteSetup(result).lines.join('\n');
        assert.match(lines, /Created, one per log type/);
        assert.match(lines, new RegExp(`Existing log channels reused:\\*\\* <#${old.id}>`));
    } finally { store.close(); }
});

test('running setup again keeps the same channels and replaces one that was deleted', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild, created } = fakeGuild();
        await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        const before = { ...logChannels(store, G).routes } as Record<string, string>;
        const total = created.length;
        const again = await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        assert.equal(created.length, total, 'a second run creates nothing');
        assert.deepEqual(again.created, []);
        assert.deepEqual(logChannels(store, G).routes, before);

        guild.channels.cache.delete(before.voice!); // an admin deleted #voice-logs
        const repaired = await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        assert.deepEqual(repaired.created, ['voice']);
        assert.equal(created.length, total + 1, 'only the missing channel is made again');
        const after = logChannels(store, G).routes as Record<string, string>;
        assert.notEqual(after.voice, before.voice);
        assert.deepEqual({ ...after, voice: '' }, { ...before, voice: '' }, 'every other route is unchanged');
        assert.equal(describeRouteSetup(repaired).attention, false, 'a deleted channel that was replaced needs no follow-up');
    } finally { store.close(); }
});

test('setup never adopts, moves or renames another bot\'s channels, even with the same names', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild } = fakeGuild(['member-logs'], { categories: ['Staff'], legacyChildren: ['join-logs', 'mod-logs'] });
        const staffJoin = [...guild.channels.cache.values()].find((c: any) => c.name === 'join-logs');
        const staffMod = [...guild.channels.cache.values()].find((c: any) => c.name === 'mod-logs');
        const loose = [...guild.channels.cache.values()].find((c: any) => c.name === 'member-logs');
        const staffCategory = staffJoin.parentId;
        const result = await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        const routes = logChannels(store, G).routes as Record<string, string>;
        for (const [route, other] of [['joins', staffJoin], ['moderation', staffMod], ['members', loose]] as const) {
            assert.notEqual(routes[route], other.id, `${route} does not use the look-alike`);
            const own = guild.channels.cache.get(routes[route]!);
            assert.equal(own.name, LEGACY_LOG_ROUTES[route]);
            assert.equal(own.parentId, result.category.id, `Vanguard's own #${own.name} is inside Ghost Vanguard Logs`);
        }
        assert.equal(staffJoin.parentId, staffCategory);
        assert.equal(staffMod.parentId, staffCategory);
        assert.equal(loose.parentId, null);
        assert.deepEqual([staffJoin.name, staffMod.name, loose.name], ['join-logs', 'mod-logs', 'member-logs'], 'nothing is renamed');

        // The merge preview explains why they stay; it does not tell anyone to remove another bot's channel.
        const plan = planLogMerge(store, guild);
        for (const other of [staffJoin, staffMod]) {
            const skip = plan.untouched.find(u => u.channelId === other.id);
            assert.match(skip?.why ?? '', /outside Vanguard's log area, so it may belong to another bot/);
            assert.doesNotMatch(skip?.why ?? '', /archive or remove it yourself/);
        }
        assert.deepEqual(plan.moves, [], 'nothing of Vanguard\'s is left outside the category');
    } finally { store.close(); }
});

test('with separate channels turned off, setup creates only the two core channels', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild, created } = fakeGuild(['bans', 'ghost-vanguard-logging'], { categories: ['Archive - Veil Logs'], legacyChildren: ['message-logs'] });
        const result = await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin', {}, { separate: false }));
        assert.deepEqual(created.map(c => c.name), ['Ghost Vanguard Logs']);
        assert.deepEqual(result.created, []);
        assert.deepEqual(Object.keys(logChannels(store, G).routes ?? {}), ['messages'], 'an existing log channel is still reused');
        assert.equal(routesWithoutChannel(store, G).length, TYPE_CHANNELS.length - 1);
        assert.equal(describeRouteSetup(result).attention, false);
    } finally { store.close(); }
});

test('setup stops at the first channel it cannot create, keeps the rest, and a second run finishes without duplicates', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    let failing = true;
    try {
        const { guild, created } = fakeGuild([], { failCreate: name => failing && name === 'role-logs' ? 'Missing Permissions' : undefined });
        const first = await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        assert.deepEqual(first.created, ['moderation', 'joins', 'members'], 'the channels before the failure were made');
        assert.equal(first.failed?.route, 'roles');
        assert.match(first.failed?.error ?? '', /Missing Permissions/);
        assert.deepEqual(Object.keys(logChannels(store, G).routes ?? {}).sort(), ['joins', 'members', 'moderation'], 'what was made is saved, nothing half-wired');
        assert.equal(eventLogConfig(store, G).enabled, true, 'logging is already on for the rest');
        const summary = describeRouteSetup(first);
        assert.equal(summary.attention, true);
        const text = summary.lines.join('\n');
        assert.match(text, /Could not create #role-logs:\*\* Missing Permissions/);
        assert.match(text, /Still without a channel:\*\* roles, channels, server, messages, voice, commands, antinuke/);

        failing = false;
        const second = await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        assert.deepEqual(second.created, ['roles', 'channels', 'server', 'messages', 'voice', 'commands', 'antinuke']);
        assert.equal(second.failed, null);
        for (const name of TYPE_CHANNELS) assert.equal(guild.channels.cache.filter((c: any) => c.name === name).size, 1, `exactly one #${name}`);
        assert.equal(created.filter(c => TYPE_CHANNELS.includes(c.name)).length, TYPE_CHANNELS.length);
        assert.equal(describeRouteSetup(second).attention, false);
    } finally { store.close(); }
});

test('two setups started together in one server make one set of channels, and a failed run does not block the next', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild, created } = fakeGuild([], { slowCreate: true });
        const [first, second] = await Promise.all([
            store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin')),
            store.withAuthorized(G, () => setupLogChannels(store, guild, 'other-admin')),
        ]);
        for (const name of ['bans', 'ghost-vanguard-logging', 'Ghost Vanguard Logs', ...TYPE_CHANNELS])
            assert.equal(guild.channels.cache.filter((c: any) => c.name === name).size, 1, `exactly one ${name}`);
        assert.equal(created.length, 3 + TYPE_CHANNELS.length);
        assert.equal(first.created.length, TYPE_CHANNELS.length);
        assert.deepEqual(second.created, [], 'the run that waited found everything already there');
        assert.deepEqual(first.routes, second.routes);

        // A failed run does not block the next one.
        const broken = fakeGuild([], { failCreate: name => name === 'bans' ? 'Missing Permissions' : undefined });
        await assert.rejects(store.withAuthorized(G, () => setupLogChannels(store, broken.guild, 'admin')), /Missing Permissions/);
        const again = await store.withAuthorized(G, () => setupLogChannels(store, broken.guild, 'admin')).catch(error => error);
        assert.match(String(again), /Missing Permissions/, 'the second attempt really ran');
    } finally { store.close(); }
});

test('an interrupted setup is resumed by name, so channels made before the interruption are not made twice', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        // The first run created #mod-logs and #join-logs in the category and was cut off before saving the routes.
        const { guild, created } = fakeGuild(['bans', 'ghost-vanguard-logging'], { categories: ['Ghost Vanguard Logs'], legacyChildren: ['mod-logs', 'join-logs'] });
        const result = await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        assert.equal(created.filter(c => c.name === 'mod-logs' || c.name === 'join-logs').length, 0);
        assert.equal(result.created.length, TYPE_CHANNELS.length - 2);
        assert.equal(logChannels(store, G).routes?.moderation, channelNamed(guild, 'mod-logs').id);
    } finally { store.close(); }
});

// ------------------------------------------------------------ pauses between changes

/** Run `work` with the setup pauses written into `timeline`, in order with the changes the fake guild records there. */
async function recordingPauses<T>(timeline: string[], work: () => Promise<T>): Promise<T> {
    const skipped = pacing.sleep;
    pacing.sleep = async ms => { timeline.push(`pause ${ms}`); };
    try { return await work(); } finally { pacing.sleep = skipped; }
}

/** One half-second pause between every two changes, and none before the first or after the last. */
function assertPausedBetweenChanges(timeline: string[]) {
    const shown = timeline.join(' | ');
    assert.ok(timeline.length >= 3, `expected several changes: ${shown}`);
    timeline.forEach((entry, n) => assert.equal(entry.startsWith('pause'), n % 2 === 1, `entry ${n} is "${entry}": ${shown}`));
    assert.equal(timeline.length % 2, 1, `it should end on a change, not a pause: ${shown}`);
    for (const entry of timeline.filter(e => e.startsWith('pause'))) assert.equal(entry, 'pause 500');
}

test('the pause between changes is half a second, and the built-in sleep really waits', async () => {
    assert.equal(pacing.pauseMs, 500);
    const started = Date.now();
    await realSleep(40);
    assert.ok(Date.now() - started >= 35, 'the built-in pause waits for the time it is given');
});

test('setup waits half a second between its changes, and not before the first or after the last', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const timeline: string[] = [];
        const { guild } = fakeGuild([], { timeline });
        await recordingPauses(timeline, () => store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin')));
        const changes = timeline.filter(entry => !entry.startsWith('pause'));
        assert.deepEqual(changes, ['create bans', 'create ghost-vanguard-logging', 'create Ghost Vanguard Logs', 'position Ghost Vanguard Logs',
            'move bans', 'move ghost-vanguard-logging', ...TYPE_CHANNELS.map(name => `create ${name}`)]);
        assert.equal(timeline.length, changes.length * 2 - 1, 'one pause between each two changes');
        assertPausedBetweenChanges(timeline);
    } finally { store.close(); }
});

test('moving reused channels and archiving the old Veil category are paced the same way', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const timeline: string[] = [];
        const { guild } = fakeGuild(['bans', 'ghost-vanguard-logging'], { categories: ['VEIL LOGS'], legacyChildren: ['join-logs', 'message-logs'], timeline });
        await recordingPauses(timeline, () => store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin')));
        for (const change of ['move join-logs', 'move message-logs', 'rename VEIL LOGS'])
            assert.ok(timeline.includes(change), `${change} happened: ${timeline.join(' | ')}`);
        assertPausedBetweenChanges(timeline);
    } finally { store.close(); }
});

test('a setup run with nothing to create or move does not wait', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const timeline: string[] = [];
        const { guild } = fakeGuild([], { timeline });
        await recordingPauses(timeline, async () => {
            await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
            timeline.length = 0;
            await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        });
        assert.deepEqual(timeline, ['position Ghost Vanguard Logs'], 'the second run only puts the category back at the top, so there is nothing to wait between');
    } finally { store.close(); }
});

test('setup does not wait again after a channel Discord refused to create', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const timeline: string[] = [];
        const { guild } = fakeGuild([], { timeline, failCreate: name => name === 'role-logs' ? 'Missing Permissions' : undefined });
        const result = await recordingPauses(timeline, () => store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin')));
        assert.equal(result.failed?.route, 'roles');
        assert.equal(timeline.at(-1), 'create role-logs', 'the refused channel was the last thing setup tried');
        assert.equal(timeline.filter(entry => entry === 'create role-logs').length, 1, 'it did not try again');
        assertPausedBetweenChanges(timeline);
    } finally { store.close(); }
});

test('merging waits half a second between the channels it moves and renames', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const timeline: string[] = [];
        const { guild } = fakeGuild(['bans', 'midtown-vanguard-logging', 'vanguard-security'], { timeline });
        configureEventLog(store, G, { enabled: true, channelId: channelNamed(guild, 'midtown-vanguard-logging').id });
        setLogChannels(store, G, { bansChannelId: channelNamed(guild, 'bans').id });
        const settings = store.settings(G); settings.logChannelId = channelNamed(guild, 'vanguard-security').id; store.save(settings);
        const result = await recordingPauses(timeline, () => applyLogMerge(store, guild, 'admin'));
        assert.deepEqual([result.moved, result.renamed], [3, 1]);
        assert.deepEqual(timeline.filter(entry => !entry.startsWith('pause')), ['create Ghost Vanguard Logs', 'position Ghost Vanguard Logs',
            'move bans', 'move midtown-vanguard-logging', 'move vanguard-security', 'rename midtown-vanguard-logging']);
        assertPausedBetweenChanges(timeline);
    } finally { store.close(); }
});

test('a server removed while setup or merge is paused gets no further change', async () => {
    // `/dev server deauthorize` lands during the nth wait between two changes.
    const removeDuringPause = async (store: Store, timeline: string[], work: () => Promise<unknown>, nth = 1) => {
        const waited = pacing.sleep;
        let pauses = 0;
        pacing.sleep = async ms => {
            timeline.push(`pause ${ms}`);
            if (++pauses === nth) store.run("UPDATE guild_authorization SET state='DEAUTHORIZED',generation=generation+1 WHERE guild_id=?", G);
        };
        try { await assert.rejects(work(), /requires developer authorization/); } finally { pacing.sleep = waited; }
    };
    const setupStore = new Store(':memory:'); authorize(setupStore, G);
    const mergeStore = new Store(':memory:'); authorize(mergeStore, G);
    try {
        const setupTimeline: string[] = [];
        const fresh = fakeGuild([], { timeline: setupTimeline });
        // Removed before the category is moved to the top. That change reads nothing from the database, so only the
        // check after the pause can stop it (creating a channel reads the staff roles first and would throw anyway).
        await removeDuringPause(setupStore, setupTimeline, () => setupStore.withAuthorized(G, () => setupLogChannels(setupStore, fresh.guild, 'admin')), 3);
        assert.deepEqual(setupTimeline, ['create bans', 'pause 500', 'create ghost-vanguard-logging', 'pause 500', 'create Ghost Vanguard Logs', 'pause 500'], 'setup changed nothing once the server was removed');
        assert.equal(fresh.guild.channels.cache.size, 3);

        // Removed while the log type channels are being made: the run stops with that error, it is not reported as a refused channel.
        const typesStore = new Store(':memory:'); authorize(typesStore, G);
        try {
            const typesTimeline: string[] = [];
            const partway = fakeGuild([], { timeline: typesTimeline });
            await removeDuringPause(typesStore, typesTimeline, () => typesStore.withAuthorized(G, () => setupLogChannels(typesStore, partway.guild, 'admin')), 7);
            assert.equal(typesTimeline.at(-1), 'pause 500', 'the last thing setup did was wait');
            assert.deepEqual([...partway.guild.channels.cache.values()].map((c: any) => c.name), ['bans', 'ghost-vanguard-logging', 'Ghost Vanguard Logs', 'mod-logs'], 'no channel was made after the server was removed');
        } finally { typesStore.close(); }

        const mergeTimeline: string[] = [];
        const scattered = fakeGuild(['bans', 'ghost-vanguard-logging'], { timeline: mergeTimeline });
        setLogChannels(mergeStore, G, { bansChannelId: channelNamed(scattered.guild, 'bans').id });
        await removeDuringPause(mergeStore, mergeTimeline, () => applyLogMerge(mergeStore, scattered.guild, 'admin'));
        assert.deepEqual(mergeTimeline, ['create Ghost Vanguard Logs', 'pause 500'], 'merge moved nothing once the server was removed');
        assert.equal(channelNamed(scattered.guild, 'bans').parentId, null);
    } finally { setupStore.close(); mergeStore.close(); }
});

test('the setup summary says what was created, reused, replaced and left undone', () => {
    const check = { channelId: 'old', ok: false, missing: ['Send Messages'], publiclyVisible: true, test: 'skipped' as const };
    const summary = describeRouteSetup({
        routes: { moderation: 'new-mod', joins: 'kept-join', stale: 'x' } as any, created: ['moderation'],
        skipped: [{ route: 'moderation', check }, { route: 'voice', check }], failed: { route: 'roles', error: 'Maximum number of channels in category reached' },
    });
    const text = summary.lines.join('\n');
    assert.match(text, /Created, one per log type:\*\* <#new-mod> · private, staff only/);
    assert.match(text, /Existing log channels reused:\*\* <#kept-join>/);
    assert.doesNotMatch(text, /<#x>/, 'a stale saved type is ignored');
    assert.match(text, /Not reused \(a new private #mod-logs was created instead\)/);
    assert.match(text, /Not activated:\*\* \*\*#voice-logs:\*\*/);
    assert.match(text, /Could not create #role-logs:\*\* Maximum number of channels in category reached/);
    assert.equal(summary.attention, true);
    assert.doesNotMatch(text, /\\n/, 'no literal backslash-n sequences');
    assert.equal(describeRouteSetup({ routes: {}, created: [], skipped: [], failed: null }).lines.length, 0, 'nothing to report when nothing happened');
});

test('/setup logs setup lists the channels it made, tests each one and stays well under the embed limit', async () => {
    const { default: command } = await import('../src/commands/configuration/logs.js');
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild, sentTo } = fakeGuild();
        const replies: any[] = [];
        const options = (separate: boolean | null) => ({ getSubcommand: () => 'setup', getChannel: () => null, getBoolean: (name: string) => name === 'separate_channels' ? separate : null });
        const i: any = { guildId: G, guild, user: { id: 'owner' }, options: options(null), editReply: async (reply: any) => { replies.push(reply); } };
        await store.withAuthorized(G, () => command.execute({ store } as any, i));
        assert.match(replies[0].embeds[0].toJSON().description, /one at a time, half a second apart, so a new server takes 10 seconds or more/, 'the first message says why a new server takes a while');
        const card = replies.at(-1).embeds[0].toJSON();
        assert.equal(card.title, '✅ Log channels ready');
        const routes = logChannels(store, G).routes as Record<string, string>;
        for (const id of Object.values(routes)) assert.ok(card.description.includes(`<#${id}>`), `the reply names <#${id}>`);
        assert.match(card.description, /Created, one per log type/);
        assert.match(card.description, /Log type channels:\*\* ✅/);
        assert.ok(card.description.length < 2500, `reply is ${card.description.length} characters`);
        assert.doesNotMatch(card.description, /\\n/);
        assert.equal(sentTo.length, 2 + TYPE_CHANNELS.length, 'bans, the server log and every type channel got a test embed');

        // A later check still lists them compactly, and tells staff nothing is missing.
        replies.length = 0;
        const check: any = { ...i, options: { getSubcommand: () => 'check' } };
        await store.withAuthorized(G, () => command.execute({ store } as any, check));
        assert.doesNotMatch(replies[0].embeds[0].toJSON().description, /half a second/, 'a check makes no channels, so it does not talk about pauses');
        const checked = replies.at(-1).embeds[0].toJSON();
        assert.equal(checked.title, '✅ Log channels ready');
        assert.doesNotMatch(checked.description, /Without their own channel/);

        // Turning separate channels off creates none, and the status points at what is missing.
        const bare = fakeGuild();
        const store2 = new Store(':memory:'); authorize(store2, G);
        try {
            const j: any = { guildId: G, guild: bare.guild, user: { id: 'owner' }, options: options(false), editReply: async (reply: any) => { replies.push(reply); } };
            await store2.withAuthorized(G, () => command.execute({ store: store2 } as any, j));
            assert.deepEqual(bare.created.map(c => c.name), ['bans', 'ghost-vanguard-logging', 'Ghost Vanguard Logs']);
            const status = await store2.withAuthorized(G, () => command.execute({ store: store2 } as any, { ...j, options: { getSubcommand: () => 'status' } }));
            assert.match(String(status), /Log types without their own channel:\*\* moderation, joins, members, roles, channels, server, messages, voice, commands, antinuke/);
            const checkOff = await store2.withAuthorized(G, () => command.execute({ store: store2 } as any, { ...j, options: { getSubcommand: () => 'check' } }));
            assert.equal(checkOff, undefined);
            assert.match(replies.at(-1).embeds[0].toJSON().description, /Without their own channel:\*\* moderation/);
        } finally { store2.close(); }
    } finally { store.close(); }
});

test('resetting a route says where that type goes now', async () => {
    const { default: command } = await import('../src/commands/configuration/logs.js');
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild } = fakeGuild(['bans', 'ghost-vanguard-logging']);
        const reset = (type: string) => command.execute({ store } as any, { guildId: G, guild, user: { id: 'owner' }, options: { getSubcommand: () => 'route', getString: () => type, getChannel: () => null } } as any);
        assert.match(String(await reset('messages')), /messages logs:\*\* the combined log channel\./);
        assert.match(String(await reset('voice')), /voice logs:\*\* no channel, so nothing is logged for this type\./);
        assert.match(String(await reset('commands')), /commands logs:\*\* no channel, so nothing is logged/);
        assert.match(String(await reset('voice')), /Running `\/setup logs setup` again creates a new channel for this type\./);
    } finally { store.close(); }
});

test('a setup failure is reported as a sentence', async () => {
    const { default: command } = await import('../src/commands/configuration/logs.js');
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const blocked = fakeGuild([], { failCreate: name => name === 'bans' ? 'Missing Permissions' : undefined });
        const run = (guild: any, getChannel: () => any = () => null) => command.execute({ store } as any, { guildId: G, guild, user: { id: 'owner' },
            options: { getSubcommand: () => 'setup', getChannel, getBoolean: () => null }, editReply: async () => undefined } as any);
        await assert.rejects(store.withAuthorized(G, () => run(blocked.guild)), /Setup could not finish: Missing Permissions\. Vanguard needs Manage Channels to create log channels\./);
        const same = fakeGuild(['shared']);
        const shared = channelNamed(same.guild, 'shared');
        await assert.rejects(store.withAuthorized(G, () => run(same.guild, () => shared)), (error: any) => /need two different channels\. Vanguard needs Manage Channels/.test(error.message) && !/\.\./.test(error.message));
    } finally { store.close(); }
});

test('the welcome panel button sets up the whole log set and reports it', async () => {
    const { Registry } = await import('../src/bot/registry.js');
    const { registerComponents } = await import('../src/ui/components.js');
    const registry = new Registry();
    registerComponents(registry);
    const button = registry.components.find(c => 'vgwelcome:logs:0'.startsWith(c.prefix))!;
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild, created } = fakeGuild();
        const replies: any[] = [], edits: any[] = [];
        const i: any = { customId: 'vgwelcome:logs:0', guild, guildId: G, user: { id: 'admin' }, message: { edit: async (m: any) => { edits.push(m); } }, editReply: async (reply: any) => { replies.push(reply); } };
        await store.withAuthorized(G, () => button.execute({ store } as any, i));
        assert.equal(created.filter(c => TYPE_CHANNELS.includes(c.name)).length, TYPE_CHANNELS.length);
        const card = replies.at(-1).embeds[0].toJSON();
        assert.equal(card.title, '✅ Log channels ready');
        assert.match(card.description, /Created, one per log type/);
        assert.equal(edits.length, 1, 'the panel checklist is refreshed');
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
        assert.ok(!created.some(c => c.name === 'ghost-vanguard-logging'), 'no second server log channel is created');
        assert.deepEqual(created.map(c => c.name), ['Ghost Vanguard Logs', ...TYPE_CHANNELS], 'only the category and the log type channels are new');
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

// ------------------------------------------------------------ merging scattered log channels

test('merging groups only Vanguard\'s own log channels and never takes another bot\'s', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild } = fakeGuild(['bans', 'ghost-vanguard-logging', 'vanguard-security'],
            { categories: ['Staff'], legacyChildren: ['join-logs', 'modlogs', 'veil-utilities-logging', 'honeypot'] });
        configureEventLog(store, G, { enabled: true, channelId: channelNamed(guild, 'ghost-vanguard-logging').id });
        setLogChannels(store, G, { bansChannelId: channelNamed(guild, 'bans').id });
        const settings = store.settings(G); settings.logChannelId = channelNamed(guild, 'vanguard-security').id; store.save(settings);

        const plan = planLogMerge(store, guild);
        assert.deepEqual(plan.moves.map(m => m.name).sort(), ['bans', 'ghost-vanguard-logging', 'vanguard-security']);
        assert.ok(!plan.moves.some(m => m.name === 'join-logs'), 'a look-alike channel in another bot\'s category is never claimed');
        assert.equal(plan.untouched[0]?.name, 'join-logs', 'the look-alike is reported so a human knows why it stays');
        assert.ok(!plan.untouched.some(u => ['modlogs', 'veil-utilities-logging', 'honeypot'].includes(u.name)), 'unrelated channels are not even listed');

        const result = await applyLogMerge(store, guild, 'admin');
        assert.equal(result.moved, 3);
        assert.equal(guild.channels.cache.get(result.categoryId).name, 'Ghost Vanguard Logs');
        for (const name of ['bans', 'ghost-vanguard-logging', 'vanguard-security'])
            assert.equal(channelNamed(guild, name).parentId, result.categoryId, `${name} is grouped`);
        for (const name of ['join-logs', 'modlogs', 'veil-utilities-logging', 'honeypot'])
            assert.equal(channelNamed(guild, name).parentId, '910000000000000000', `${name} stays where it is`);
        assert.equal(channelNamed(guild, 'join-logs').name, 'join-logs', 'no channel is renamed');
        assert.equal(logChannels(store, G).routes?.joins, undefined, 'a look-alike channel is never wired up as a route');

        const again = await applyLogMerge(store, guild, 'admin');
        assert.equal(again.moved, 0, 'merging again changes nothing');
    } finally { store.close(); }
});

test('merging works in a server that never had Veil channels', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild } = fakeGuild();
        const result = await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        assert.equal(result.category.name, 'Ghost Vanguard Logs');
        const plan = planLogMerge(store, guild);
        assert.deepEqual([plan.moves.length, plan.renames.length], [0, 0], 'setup alone already groups a fresh server');
        assert.equal(result.bans.channel.parentId, result.category.id);
        assert.equal(result.logging.channel.parentId, result.category.id);
    } finally { store.close(); }
});

test('merging brings only the legacy default logging name up to date, on the same channel', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild } = fakeGuild(['bans', 'midtown-vanguard-logging']);
        const legacy = channelNamed(guild, 'midtown-vanguard-logging');
        configureEventLog(store, G, { enabled: true, channelId: legacy.id });
        setLogChannels(store, G, { bansChannelId: channelNamed(guild, 'bans').id });
        const plan = planLogMerge(store, guild);
        assert.deepEqual(plan.renames, [{ channelId: legacy.id, from: 'midtown-vanguard-logging', to: 'ghost-vanguard-logging' }]);
        const result = await applyLogMerge(store, guild, 'admin');
        assert.deepEqual([result.moved, result.renamed], [2, 1]);
        assert.equal(legacy.name, 'ghost-vanguard-logging', 'same channel object, new name');
        assert.equal(legacy.id, eventLogConfig(store, G).channelId, 'the saved destination is unchanged');
        assert.equal(legacy.parentId, result.categoryId);

        // A name an admin chose is never rewritten.
        const custom = fakeGuild(['bans', 'staff-logs']);
        configureEventLog(store, G, { channelId: channelNamed(custom.guild, 'staff-logs').id });
        assert.deepEqual(planLogMerge(store, custom.guild).renames, []);
    } finally { store.close(); }
});

test('a duplicate log channel is reported, never deleted, and the configured one keeps being used', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild } = fakeGuild(['vanguard-security'], { categories: ['Ghost Vanguard Logs'], legacyChildren: ['vanguard-security'] });
        const both = [...guild.channels.cache.values()].filter((c: any) => c.name === 'vanguard-security');
        const inside = both.find((c: any) => c.parentId === '910000000000000000');
        const outside = both.find((c: any) => c.parentId === null);
        const settings = store.settings(G); settings.logChannelId = inside.id; store.save(settings);
        const size = guild.channels.cache.size;
        const plan = planLogMerge(store, guild);
        assert.deepEqual(plan.moves, [], 'the duplicate outside the log area is not pulled in');
        assert.ok(plan.untouched.some(u => u.channelId === outside.id && /another .* channel next to/.test(u.why)));
        const result = await applyLogMerge(store, guild, 'admin');
        assert.equal(result.moved, 0);
        assert.equal(guild.channels.cache.size, size, 'nothing is deleted');
        assert.equal(store.settings(G).logChannelId, inside.id, 'the configured channel is still the security log');
    } finally { store.close(); }
});

test('setup prefers an uncategorized Vanguard channel over a same-named look-alike in another bot\'s category', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        // Vanguard creates its own channels uncategorized; a #bans inside a staff category is far more
        // likely to belong to another bot, so it is not adopted when there is a better candidate.
        const { guild } = fakeGuild(['bans'], { categories: ['Staff'], legacyChildren: ['bans'] });
        const candidates = [...guild.channels.cache.values()].filter((c: any) => c.name === 'bans');
        const own = candidates.find((c: any) => c.parentId === null);
        const foreign = candidates.find((c: any) => c.parentId === '910000000000000000');
        const result = await store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin'));
        assert.equal(result.bans.channel.id, own.id, 'the uncategorized channel is reused');
        assert.equal(foreign.parentId, '910000000000000000', 'the look-alike stays in its own category');
        assert.equal(logChannels(store, G).bansChannelId, own.id);
    } finally { store.close(); }
});
