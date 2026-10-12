import { authorize } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionFlagsBits } from 'discord.js';
import { Store } from '../src/database/db.js';
import { GuildLifecycle } from '../src/bot/lifecycle.js';
import { setupStatus, welcomePanel, WELCOME_COOLDOWN_MS } from '../src/ui/setup-tips.js';

const title = (m: any) => m.embeds?.[0]?.data?.title ?? m.embeds?.[0]?.toJSON?.().title;

function fakeGuild(id: string, { admin = false, rank = 3, canEmbed = true } = {}) {
    const sent: any[] = [];
    const edits: any[] = [];
    const roles = new Collection<string, any>([[id, { id, position: 0 }]]);
    for (let n = 1; n <= 5; n++)
        roles.set(`r${n}`, { id: `r${n}`, position: 6 - n });
    const highest = roles.get(`r${rank}`);
    const messages = new Map<string, any>();
    const channel: any = { id: 'system', isSendable: () => true, isTextBased: () => true, permissionsFor: () => ({ has: (p: any[]) => canEmbed || !p.includes(PermissionFlagsBits.EmbedLinks) }),
        send: async (m: any) => {
            sent.push(m);
            const msg = { id: `m${sent.length}`, channelId: 'system', edit: async (e: any) => { edits.push(e); } };
            messages.set(msg.id, msg);
            return msg;
        },
        messages: { fetch: async (mid: string) => messages.get(mid) ?? null } };
    const guild: any = {
        id, name: 'Test Guild', systemChannel: channel, channels: { cache: new Collection([['system', channel]]), fetch: async () => channel }, roles: { cache: roles },
        members: { me: { joinedTimestamp: Date.now(), permissions: { has: (p: bigint) => admin && p === PermissionFlagsBits.Administrator }, roles: { highest } } },
        leave: async () => { },
    };
    return { guild, sent, edits };
}

const settle = () => new Promise(r => setTimeout(r, 30));

const fields = (m: any) => Object.fromEntries((m.embeds[0].data ?? m.embeds[0].toJSON()).fields.map((f: any) => [f.name.replace(/ .*/, ''), f.value]));

test('the welcome panel shows protection, a live checklist and buttons that do the setup', () => {
    const store = new Store(':memory:'); authorize(store, 'g');
    try {
        const weak = fakeGuild('g', { admin: false, rank: 3 }).guild;
        assert.deepEqual(setupStatus(weak), { admin: false, top: false, rank: 3, total: 5 });
        const panel = welcomePanel(store, weak, '1277709272041394187');
        const e = panel.embeds[0]!.toJSON();
        assert.equal(e.title, '🛡️ Midtown Vanguard is online');
        assert.match(e.description!, /Authorized by approved developer <@1277709272041394187>/);
        assert.doesNotMatch(JSON.stringify(e), /antinuke enable/, 'no outdated "run /antinuke enable" advice: it is already on');
        const f = fields(panel);
        assert.match(f.Protection, /Anti-nuke on/);
        assert.match(f.Setup, /⚠️ \*\*Administrator permission/);
        assert.match(f.Setup, /⚠️ \*\*Role position #3 of 5/);
        assert.match(f.Setup, /⚠️ \*\*Log channels/);
        assert.match(e.fields!.find(x => x.name.startsWith('Setup'))!.name, /0\/4/);
        const buttons = panel.components[0]!.toJSON().components.map((b: any) => [b.custom_id, b.label]);
        assert.deepEqual(buttons, [['vgwelcome:logs:1277709272041394187', 'Set up logs'], ['vgwelcome:check:1277709272041394187', 'Re-check'], ['vgcommands:open', 'Commands']]);
        const strong = fakeGuild('g', { admin: true, rank: 1 }).guild;
        assert.match(fields(welcomePanel(store, strong)).Setup, /✅ \*\*Administrator[\s\S]*✅ \*\*Role position #1/);
    } finally { store.close(); }
});

test('a fresh invite posts the countdown, then the welcome panel once authorized; restarts post nothing', async () => {
    const store = new Store(':memory:');
    const { guild, sent } = fakeGuild('123456789012345678');
    const lifecycle = new GuildLifecycle(store, { guilds: { cache: new Collection([[guild.id, guild]]) } } as any, () => { }, async () => { });
    await lifecycle.joined(guild, true);
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(title(sent[0]), '⏳ Waiting for a Midtown Vanguard developer');
    assert.match(sent[0].embeds[0].toJSON().description, /<t:\d+:R>/, 'a live countdown');
    await lifecycle.joined(guild, false);
    await settle();
    assert.equal(sent.length, 1, 'reconnecting or restarting does not repeat it');
    lifecycle.close();
    store.close();
});

test('re-adding the bot to an authorized server posts the panel, but not again within 6 hours', async () => {
    const store = new Store(':memory:');
    const { guild, sent } = fakeGuild('223456789012345678');
    authorize(store, guild.id);
    const lifecycle = new GuildLifecycle(store, { guilds: { cache: new Collection([[guild.id, guild]]) } } as any, () => { }, async () => { });
    await lifecycle.joined(guild, true);
    await settle();
    assert.deepEqual(sent.map(title), ['🛡️ Midtown Vanguard is online']);
    await lifecycle.joined(guild, true);
    await settle();
    assert.equal(sent.length, 1, 'kicking and re-adding cannot spam the channel');
    assert.equal(await lifecycle.welcome(guild, 'ready', null, Date.now() + WELCOME_COOLDOWN_MS + 1000), true, 'after the cooldown it posts again');
    assert.equal(sent.length, 2);
    lifecycle.close();
    store.close();
});

test('no channel that allows embeds means a short plain-text message, and the join still succeeds', async () => {
    const store = new Store(':memory:');
    const { guild, sent } = fakeGuild('323456789012345678', { canEmbed: false });
    const lifecycle = new GuildLifecycle(store, { guilds: { cache: new Collection([[guild.id, guild]]) } } as any, () => { }, async () => { });
    await lifecycle.joined(guild, true);
    await settle();
    assert.equal(store.authorization(guild.id)?.state, 'PENDING_AUTHORIZATION');
    assert.ok(!sent.some(m => title(m)), 'no embed');
    assert.match(sent[0].content, /waiting for an approved developer/);
    lifecycle.close();
    store.close();
});

test('the welcome buttons register alongside every other control without clashing', async () => {
    const { Registry } = await import('../src/bot/registry.js');
    const { registerComponents } = await import('../src/ui/components.js');
    const registry = new Registry();
    registerComponents(registry);
    const find = (id: string) => registry.components.find(c => id.startsWith(c.prefix))!;
    assert.equal(find('vgwelcome:logs:0').metadata.access, 'security', 'setup buttons need Admin or above');
    assert.equal(find('vgwelcome:check:0').metadata.cooldown, 15000, 'with a cooldown');
    assert.equal(find('vgcommands:open').metadata.access, 'member', 'the command list is for everyone');
});

test('one message per join: the countdown turns into the welcome panel when a developer authorizes', async () => {
    const store = new Store(':memory:');
    const { guild, sent, edits } = fakeGuild('423456789012345678');
    const lifecycle = new GuildLifecycle(store, { guilds: { cache: new Collection([[guild.id, guild]]) } } as any, () => { }, async () => { });
    const { config } = await import('../src/config.js');
    config.developers.add('1277709272041394187');
    try {
        await lifecycle.joined(guild, true);
        await settle();
        assert.equal(sent.length, 1);
        await lifecycle.authorize(guild, '1277709272041394187');
        await settle();
        assert.equal(sent.length, 1, 'no second message');
        assert.equal(edits.length, 1, 'the countdown was edited');
        assert.equal(edits[0].embeds[0].toJSON().title, '🛡️ Midtown Vanguard is online');
    } finally { config.developers.delete('1277709272041394187'); lifecycle.close(); store.close(); }
});

test('a restart is silent: known servers get no welcome, countdown or panel, only a real invite does', async () => {
    const store = new Store(':memory:');
    const { guild, sent } = fakeGuild('523456789012345678');
    authorize(store, guild.id);
    const lifecycle = new GuildLifecycle(store, { guilds: { cache: new Collection([[guild.id, guild]]) } } as any, () => { }, async () => { });
    for (let n = 0; n < 3; n++) await lifecycle.joined(guild, false);
    await settle();
    assert.equal(sent.length, 0);
    lifecycle.close();
    store.close();
});
