import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { config } from '../src/config.js';
import { PrefixCommands, recognizesPrefixCommand, prefixHelp } from '../src/bot/prefix-commands.js';
import { prefixDeleteDelayMs, restorePrefixMessageDeletions, schedulePrefixMessageDeletion } from '../src/bot/prefix-cleanup.js';
import { Registry, defineCommand } from '../src/bot/registry.js';
import { Interactions } from '../src/bot/interactions.js';
import { treeJson } from '../src/bot/command-tree.js';
import { Store } from '../src/database/db.js';
import { KeyedQueue } from '../src/core.js';

const GUILD = '500000000000000001';
const OWNER = '200000000000000001';
const DEV = '200000000000000002';

const message = (content: string, authorId = DEV, client: any = fakeClient()) => {
    const replies: any[] = [];
    const guild: any = {
        id: GUILD,
        ownerId: OWNER,
        members: {
            me: { permissions: { has: () => true } },
            fetch: async (id: string) => ({ id, user: { id, bot: false }, roles: { cache: new Map() }, permissions: { has: () => true } }),
            cache: new Map(),
        },
        channels: { cache: new Map() },
        roles: { cache: new Map() },
    };
    const m: any = {
        id: `input-${Math.random()}`,
        content,
        guildId: GUILD,
        guild,
        author: { id: authorId, bot: false, tag: 'developer#0001' },
        member: { id: authorId, user: { id: authorId, bot: false }, guild, roles: { cache: new Map() }, permissions: { has: () => true } },
        channelId: '500000000000000099',
        channel: { id: '500000000000000099' },
        client,
        mentions: { users: new Map(), roles: new Map(), channels: new Map() },
        attachments: new Map(),
        createdTimestamp: Date.now(),
        reply: async (payload: any) => {
            const reply: any = { id: `reply-${replies.length}`, content: payload, delete: async () => {} };
            reply.edit = async (next: any) => { reply.content = next; return reply; };
            replies.push(reply);
            return reply;
        },
        replies,
    };
    return m;
};

function fakeClient() {
    const deleted: string[] = [];
    const client: any = {
        user: { id: '600000000000000001' },
        users: { cache: new Map(), fetch: async (id: string) => ({ id, bot: false }) },
        channels: {
            fetch: async () => ({
                isTextBased: () => true,
                messages: { fetch: async (id: string) => ({ id, delete: async () => { deleted.push(id); } }) },
            }),
        },
        deleted,
    };
    return client;
}

async function loadedRegistry() {
    const registry = new Registry();
    await registry.load();
    return registry;
}

function fakeStore() {
    const jobs: any[] = [];
    return {
        jobs,
        get: () => undefined,
        all: () => [...jobs],
        run: (sql: string, ...values: any[]) => {
            if (sql.startsWith('INSERT INTO prefix_message_cleanup'))
                jobs.push({ id: values[0], channel_id: values[1], message_id: values[2], delete_at: values[3] });
            return { changes: 1 };
        },
    };
}

function slashInteraction(name: string) {
    const replies: any[] = [], acks: any[] = [];
    const member: any = { id: DEV, permissions: { has: () => false }, guild: { id: GUILD, ownerId: OWNER }, roles: { cache: new Map() } };
    const guild: any = { id: GUILD, name: 'Test Guild', ownerId: OWNER, members: { me: { permissions: { has: () => true } }, fetch: async () => member } };
    const i: any = {
        id: `interaction-${name}`, commandName: name, commandType: 1, guildId: GUILD, channelId: 'channel', guild, member,
        user: { id: DEV, tag: 'developer#0001' }, deferred: false, replied: false, responded: false,
        options: { data: [], getSubcommandGroup: () => null, getSubcommand: () => null },
        isCommand: () => true, isChatInputCommand: () => true, isAutocomplete: () => false,
        isButton: () => false, isAnySelectMenu: () => false, isModalSubmit: () => false, inCachedGuild: () => true,
        deferReply: async (options: any) => { acks.push(options); i.deferred = true; },
        reply: async (payload: any) => { replies.push(payload); i.replied = true; },
        editReply: async (payload: any) => { replies.push(payload); },
    };
    return { i, replies, acks };
}

test('only known developer comma commands are intercepted, and their slash versions are hidden', async () => {
    const registry = await loadedRegistry();
    for (const content of [',restart', ',help', ',update now', ',dev diagnostics', ',database backup', ',staff global @200000000000000003 supreme', ',hardban @400000000000000001'])
        assert.equal(recognizesPrefixCommand({ content, guildId: GUILD, author: { id: DEV, bot: false } } as any, registry), true, content);
    for (const content of ['ordinary chat', ',unknown', ',mod ban @400000000000000001', ',staff role @role admin', ',restart extra'])
        assert.equal(recognizesPrefixCommand({ content, guildId: GUILD, author: { id: DEV, bot: false } } as any, registry), false, content);
    assert.equal(recognizesPrefixCommand({ content: ',restart', guildId: null, author: { id: DEV, bot: false } } as any, registry), false, 'DMs are not commands');
    assert.equal(recognizesPrefixCommand({ content: ',restart', guildId: GUILD, author: { id: DEV, bot: true } } as any, registry), false, 'bot messages are ignored');
    assert.match(prefixHelp(registry), /`,update \[status\|now\]`/);
    assert.match(prefixHelp(registry), /`,staff global/);
    assert.ok(treeJson(registry).some(command => ['dev', 'network'].includes(command.name)));
});

test('comma commands authorize only exact DEVELOPER_IDS entries, silently', async () => {
    const oldOwner = config.ownerId;
    const ownerWasListed = config.developers.has(OWNER);
    const store = fakeStore();
    const registry = await loadedRegistry();
    const client = fakeClient();
    try {
        config.ownerId = OWNER;
        config.developers.delete(OWNER);
        const outsider = message(',help', OWNER, client);
        await new PrefixCommands({ store, registry, client, lifecycle: { isReady: () => true } } as any, new KeyedQueue()).handle(outsider);
        assert.equal(outsider.replies.length, 0, 'BOT_OWNER_ID alone gets no response');
        assert.equal(store.all('SELECT id FROM prefix_message_cleanup').length, 0, 'unauthorized messages are not queued or deleted');

        config.developers.add(DEV);
        const allowed = message(',help', DEV, client);
        await new PrefixCommands({ store, registry, client, lifecycle: { isReady: () => true } } as any, new KeyedQueue()).handle(allowed);
        assert.ok(allowed.replies.length >= 1);
        assert.match(allowed.replies[0].content, /only IDs listed in `DEVELOPER_IDS`/i);
        assert.equal(store.all('SELECT id FROM prefix_message_cleanup').length, allowed.replies.length + 1, 'both the invocation and every reply are scheduled for cleanup');
    } finally {
        if (ownerWasListed) config.developers.add(OWNER); else config.developers.delete(OWNER);
        config.developers.delete(DEV);
        config.ownerId = oldOwner;
    }
});

test('the prefix adapter executes current developer handlers with quoted arguments and schedules both messages', async () => {
    const registry = new Registry();
    let received = '';
    registry.add(defineCommand(new SlashCommandBuilder().setName('prefixprobe').setDescription('Test-only developer command')
        .addStringOption(option => option.setName('first').setDescription('First').setRequired(true))
        .addStringOption(option => option.setName('second').setDescription('Second')),
    { developerOnly: true, requiresAuthorization: false }, async (_ctx, i) => {
        received = `${i.options.getString('first')}|${i.options.getString('second')}`;
        return received;
    }), 'prefix probe');
    const oldListed = config.developers.has(DEV);
    const store = fakeStore();
    const client = fakeClient();
    try {
        config.developers.add(DEV);
        const services = { store, registry, client, lifecycle: { isReady: () => true } };
        const cmd = new PrefixCommands(services as any, new KeyedQueue());
        const msg = message(',prefixprobe hello "two words"', DEV, client);
        await cmd.handle(msg);
        assert.equal(received, 'hello|two words');
        assert.equal(msg.replies[0].content, 'hello|two words');
        assert.equal(store.all('SELECT id FROM prefix_message_cleanup').length, 2);
    } finally {
        if (!oldListed) config.developers.delete(DEV);
    }
});

test('slash utility replies stay public; sensitive/staff replies are private', async () => {
    const registry = new Registry();
    registry.add(defineCommand(new SlashCommandBuilder().setName('utilityprobe').setDescription('Public utility'),
        { category: 'utility', requiresAuthorization: false }, async () => 'ok'), 'utility probe');
    registry.add(defineCommand(new SlashCommandBuilder().setName('staffprobe').setDescription('Sensitive staff action'),
        { category: 'moderation', requiresAuthorization: false, requiredPermissions: [1n] }, async () => 'ok'), 'staff probe');
    const store = new Store(':memory:');
    const oldListed = config.developers.has(DEV);
    try {
        config.developers.add(DEV);
        const router = new Interactions({ store, registry, lifecycle: { isReady: () => true } } as any);
        const utility = slashInteraction('utilityprobe');
        await router.handle(utility.i);
        assert.deepEqual(utility.acks, [{}], 'ordinary utility defers publicly');
        const sensitive = slashInteraction('staffprobe');
        await router.handle(sensitive.i);
        assert.equal(sensitive.acks[0]?.flags, MessageFlags.Ephemeral, 'sensitive staff defers privately');
    } finally {
        if (!oldListed) config.developers.delete(DEV);
        store.close();
    }
});

test('non-developers cannot invoke developer-only handlers', async () => {
    const registry = new Registry();
    let executions = 0;
    registry.add(defineCommand(new SlashCommandBuilder().setName('hiddenprobe').setDescription('Hidden developer action'),
        { developerOnly: true, requiresAuthorization: false }, async () => { executions++; return 'ran'; }), 'hidden probe');
    const store = new Store(':memory:');
    try {
        const router = new Interactions({ store, registry, lifecycle: { isReady: () => true } } as any);
        const stale = slashInteraction('hiddenprobe');
        await router.handle(stale.i);
        assert.equal(executions, 0);
        assert.match(stale.replies[0]?.embeds?.[0]?.data?.description ?? '', /approved Ghost Vanguard developers/);
    } finally {
        store.close();
    }
});

test('prefix cleanup persists and restores deletion jobs, then deletes the bot message', async () => {
    const store = new Store(':memory:');
    const client = fakeClient();
    try {
        const saved = process.env.COMMA_DELETE_SECONDS;
        process.env.COMMA_DELETE_SECONDS = '';
        assert.equal(prefixDeleteDelayMs(), 60_000, 'default: one minute');
        process.env.COMMA_DELETE_SECONDS = '300'; assert.equal(prefixDeleteDelayMs(), 300_000, 'set in .env');
        process.env.COMMA_DELETE_SECONDS = 'junk'; assert.equal(prefixDeleteDelayMs(), 60_000, 'bad value: default');
        process.env.COMMA_DELETE_SECONDS = '0';
        assert.equal(schedulePrefixMessageDeletion(client, store, 'channel', 'kept', Date.now()), null, '0 keeps them');
        assert.equal(store.get('SELECT 1 FROM prefix_message_cleanup WHERE message_id=?', 'kept'), undefined);
        process.env.COMMA_DELETE_SECONDS = saved ?? '';
        store.run('INSERT INTO prefix_message_cleanup(id,channel_id,message_id,delete_at) VALUES(?,?,?,?)', 'restore-me', 'channel', 'old-message', Date.now() - 1);
        assert.equal(restorePrefixMessageDeletions(client, store), 1);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.deepEqual(client.deleted, ['old-message']);
        assert.equal(store.get('SELECT id FROM prefix_message_cleanup WHERE id=?', 'restore-me'), undefined);

        schedulePrefixMessageDeletion(client, store, 'channel', 'new-message', Date.now());
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.deepEqual(client.deleted, ['old-message', 'new-message']);
    } finally {
        store.close();
    }
});
