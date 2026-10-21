import test from 'node:test';
import assert from 'node:assert/strict';
import { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { Registry, defineCommand, validateArguments, defaults } from '../src/bot/registry.js';
import { normalizeCommands, syncCommands, cleanLegacyGuildCommands } from '../src/bot/command-sync.js';
import { Store } from '../src/database/db.js';
import { Guard } from '../src/bot/guard.js';
import { Interactions } from '../src/bot/interactions.js';
import { failure, redact, logEvent } from '../src/errors.js';
import { config } from '../src/config.js';
import { authorize } from './helpers.js';

const guildId = '123456789012345678', userId = '223456789012345678';

function interaction(kind = 'slash', name = 'probe') {
    const replies: any[] = [], events: string[] = [];
    const member: any = { id: userId, permissions: new PermissionsBitField(0n), guild: { id: guildId, ownerId: 'owner' }, roles: { highest: { comparePositionTo: () => 1 } } };
    const me = { permissions: new PermissionsBitField(0n) };
    const guild: any = { id: guildId, name: 'Guild', members: { me, fetch: async () => member } };
    const i: any = { id: Math.random().toString(), commandName: name, commandType: kind === 'user' ? 2 : kind === 'message' ? 3 : 1, customId: 'probe:hello', guildId, channelId: 'channel', guild, member, user: { id: userId, tag: 'User' }, deferred: false, replied: false, responded: false,
        options: { data: [], getSubcommandGroup: () => null, getSubcommand: () => null },
        isCommand: () => ['slash', 'user', 'message'].includes(kind), isChatInputCommand: () => kind === 'slash', isAutocomplete: () => kind === 'autocomplete', isButton: () => kind === 'button', isAnySelectMenu: () => kind === 'select', isModalSubmit: () => kind === 'modal', inCachedGuild: () => true,
        deferReply: async () => {
            events.push('ack');
            i.deferred = true;
        }, reply: async (p: any) => {
            events.push('reply');
            i.replied = true;
            replies.push(p);
        }, editReply: async (p: any) => {
            events.push('edit');
            replies.push(p);
        }, respond: async (p: any) => {
            i.responded = true;
            replies.push(p);
        } };
    return { i, replies, events, member, me };
}

function services(store: Store, registry: Registry): any {
    return { store, registry, client: {}, security: {}, roblox: {}, snapshots: {}, logs: {}, lifecycle: { isReady: () => true }, confirmations: new Map(), ai: { inFlight: 0 } };
}

test('global normalization ignores read-only IDs, JSON order and explicit API defaults', () => {
    const local = [{ name: 'probe', description: 'Description', contexts: [0], integration_types: [0], options: [{ type: 3, name: 'input', description: 'Text' }] }];
    const remote = [{ ...local[0], id: '999', application_id: '123', version: '456', type: 1, nsfw: false, name_localizations: null, options: [{ ...local[0]!.options[0], required: false, autocomplete: false, choices: [] }] }];
    assert.equal(normalizeCommands(local), normalizeCommands(remote));
    assert.notEqual(normalizeCommands(local), normalizeCommands([{ ...local[0], description: 'Changed' }]));
});

test('command sync fetches once and never overwrites unchanged commands', async () => {
    let writes = 0, reads = 0;
    const schema = [{ name: 'probe', description: 'Test', contexts: [0], integration_types: [0] }];
    assert.equal(await syncCommands({ get: async () => {
            reads++;
            return schema;
        }, put: async () => {
            writes++;
        } } as any, 'app', schema), false);
    assert.equal(reads, 1);
    assert.equal(writes, 0);
});

test('changed command sync bulk replaces entire set, removing obsolete commands', async () => {
    let body: any;
    const wanted = [{ name: 'new', description: 'New command', contexts: [0] }];
    await syncCommands({ get: async () => [{ name: 'old', description: 'Old' }], put: async (_route: any, p: any) => {
            body = p.body;
        } } as any, 'app', wanted);
    assert.deepEqual(body, wanted);
});

test('legacy per-guild registrations are removed once and checkpointed across restarts', async () => {
    const s = new Store(':memory:');
    let reads = 0, writes = 0;
    const rest: any = { get: async () => {
            reads++;
            return [{ name: 'old' }];
        }, put: async () => {
            writes++;
        } };
    await cleanLegacyGuildCommands(rest, 'app', guildId, s);
    await cleanLegacyGuildCommands(rest, 'app', guildId, s);
    assert.equal(reads, 1);
    assert.equal(writes, 1);
    s.close();
});

test('registry rejects duplicate command names and missing handlers with exact source', () => {
    const registry = new Registry(), def = defineCommand(new SlashCommandBuilder().setName('probe').setDescription('Test'), {}, async () => { });
    registry.add(def, 'a.ts');
    assert.throws(() => registry.add(def, 'duplicate.ts'), /duplicate.ts/);
    assert.throws(() => registry.add({ ...def, execute: null } as any, 'broken.ts'), /broken.ts/);
});

test('full loader discovers every module, validates every subcommand and sets guild context', async () => {
    const r = new Registry();
    await r.load();
    assert.equal(r.commands.size, 69);
    for (const d of r.commands.values()) {
        assert.deepEqual(d.data.contexts, [0]);
        assert.equal(d.metadata.dmAllowed, false);
        assert.equal(typeof d.execute, 'function');
    }
    assert.ok(r.commands.has('1:authserver'));
    assert.ok(r.commands.has('1:snapshot'));
    assert.ok(!r.commands.has('1:purge'));
});

test('arguments reject missing subcommands, malformed IDs, overflow and invalid enum values', () => {
    const schema = { options: [{ name: 'act', type: 1, options: [{ name: 'guild_id', type: 3, required: true, max_length: 20 }, { name: 'count', type: 4, min_value: 1, max_value: 100 }, { name: 'mode', type: 3, choices: [{ name: 'Safe', value: 'safe' }] }] }] };
    assert.throws(() => validateArguments(schema, []), /subcommand/);
    assert.throws(() => validateArguments(schema, [{ name: 'act', type: 1, options: [{ name: 'guild_id', type: 3, value: 'bad' }] }]), /Invalid ID/);
    assert.throws(() => validateArguments(schema, [{ name: 'act', type: 1, options: [{ name: 'guild_id', type: 3, value: guildId }, { name: 'count', type: 4, value: 101 }] }]), /Invalid number/);
    assert.throws(() => validateArguments(schema, [{ name: 'act', type: 1, options: [{ name: 'guild_id', type: 3, value: guildId }, { name: 'mode', type: 3, value: 'evil' }] }]), /Invalid choice/);
    validateArguments(schema, [{ name: 'act', type: 1, options: [{ name: 'guild_id', type: 3, value: guildId }, { name: 'count', type: 4, value: 50 }] }]);
});

test('permission errors name exact missing bot permissions and do not grant developer to Administrator', async () => {
    const s = new Store(':memory:');
    authorize(s, guildId);
    const { i, member } = interaction();
    member.permissions = new PermissionsBitField(PermissionFlagsBits.Administrator);
    const guard = new Guard(s);
    await assert.rejects(guard.check(i, { ...defaults, developerOnly: true }, 'dev'), /approved/);
    await assert.rejects(guard.check(i, { ...defaults, botPermissions: [PermissionFlagsBits.BanMembers, PermissionFlagsBits.ManageRoles] }, 'probe'), /Ban Members[\s\S]*Manage Roles/);
    s.close();
});

for (const kind of ['slash', 'button', 'select', 'modal', 'user', 'message', 'autocomplete']) {
    test(`${kind} interactions are blocked before execution in unauthorized servers`, async () => {
        const s = new Store(':memory:'), r = new Registry();
        let calls = 0;
        const def = defineCommand(new SlashCommandBuilder().setName('probe').setDescription('Test'), {}, async () => {
            calls++;
        });
        if (kind === 'user' || kind === 'message')
            def.data = { name: 'probe', type: kind === 'user' ? 2 : 3 } as any;
        if (kind === 'autocomplete')
            def.autocomplete = async () => {
                calls++;
            };
        r.add(def, 'probe');
        r.component({ prefix: 'probe:', kinds: ['button', 'select', 'modal'], metadata: defaults, execute: async () => {
                calls++;
            } });
        const { i, replies } = interaction(kind);
        await new Interactions(services(s, r)).handle(i);
        assert.equal(calls, 0);
        assert.equal(replies.length, 1);
        if (kind !== 'autocomplete')
            assert.match(replies[0].embeds[0].data.description, /authorization/);
        else
            assert.deepEqual(replies[0], []);
        s.close();
    });
}

test('interaction ACK precedes async execution; duplicate deliveries execute once', async () => {
    const s = new Store(':memory:');
    authorize(s, guildId);
    const r = new Registry(), f = interaction();
    let calls = 0;
    r.add(defineCommand(new SlashCommandBuilder().setName('probe').setDescription('Test'), {}, async () => {
        assert.deepEqual(f.events, ['ack']);
        calls++;
        return 'Done';
    }), 'probe');
    const router = new Interactions(services(s, r));
    await router.handle(f.i);
    await router.handle(f.i);
    assert.equal(calls, 1);
    assert.deepEqual(f.events, ['ack', 'edit']);
    s.close();
});

test('cooldown rejects a second execution; stale unsupported components fail closed', async () => {
    const s = new Store(':memory:');
    authorize(s, guildId);
    const r = new Registry();
    let calls = 0;
    r.add(defineCommand(new SlashCommandBuilder().setName('probe').setDescription('Test'), { cooldown: 10000 }, async () => {
        calls++;
        return 'Done';
    }), 'probe');
    const router = new Interactions(services(s, r));
    await router.handle(interaction().i);
    const next = interaction();
    await router.handle(next.i);
    assert.equal(calls, 1);
    assert.match(next.replies[0].embeds[0].data.description, /Wait/);
    const unknown = interaction('select');
    await router.handle(unknown.i);
    assert.match(unknown.replies[0].embeds[0].data.description, /no longer available/);
    s.close();
});

test('unexpected SDK errors show reference only and redact secrets from full internal stack', () => {
    const old = config.token;
    config.token = 'TOP_SECRET_TOKEN';
    try {
        const f = failure(new Error('SDK fail TOP_SECRET_TOKEN Authorization=BearerPassword password=dbsecret https://discord.com/api/webhooks/123/secret'));
        assert.match(f.reference, /^MV-CMD-[A-F0-9]{12}$/);
        assert.equal(f.message, 'Ghost Vanguard could not complete this action.');
        assert.ok(!f.details.includes('TOP_SECRET_TOKEN'));
        assert.ok(!f.details.includes('dbsecret'));
        assert.ok(!f.details.includes('/webhooks/'));
        assert.ok(!redact('postgresql://name:secret@server/db').includes('secret'));
    } finally {
        config.token = old;
    }
});

test('help is generated from registry and hides protected/developer commands before auth', async () => {
    const s = new Store(':memory:'), r = new Registry();
    await r.load();
    const f = interaction('slash', 'help');
    await new Interactions(services(s, r)).handle(f.i);
    const text = f.replies[0].embeds[0].data.description;
    // Before authorization only the information commands are usable.
    assert.match(text, /Information\*\* · 4/);
    assert.ok(!text.includes('Roblox') && !text.includes('Developer') && !text.includes('Moderation'));
    s.close();
});

test('redacted activity logs remain valid structured JSON', () => {
    const original = console.log, oldFormat = config.logFormat;
    config.logFormat = 'json';
    let line = '';
    console.log = (message: any) => {
        line = String(message);
    };
    try {
        logEvent('test', { details: 'SDK password=opaque_secret', Authorization: 'Bot UNKNOWN_TOKEN' });
        const row = JSON.parse(line);
        assert.equal(row.event, 'test');
        assert.ok(!line.includes('opaque_secret'));
        assert.ok(!line.includes('UNKNOWN_TOKEN'));
    } finally {
        console.log = original;
        config.logFormat = oldFormat;
    }
});

test('a grouped command (/info ping) runs end to end through the router', async () => {
    const s = new Store(':memory:'), r = new Registry();
    await r.load();
    const { indexTree } = await import('../src/bot/command-tree.js'); indexTree(r);
    const f = interaction('slash', 'info');
    f.i.options = { data: [{ type: 1, name: 'ping', options: [] }], getSubcommandGroup: () => null, getSubcommand: () => 'ping' };
    f.i.client = { ws: { ping: 42 } }; f.i.createdTimestamp = Date.now();
    await new Interactions({ ...services(s, r), client: { ws: { ping: 42 }, guilds: { cache: new Map() }, users: { cache: new Map() } } }).handle(f.i);
    const text = JSON.stringify(f.replies);
    assert.ok(!/replaced|Unknown option/.test(text), text);
    assert.match(text, /42/);
    s.close();
});
