import test from 'node:test';
import assert from 'node:assert/strict';
import { autoReact, autoReactFor, parseEmoji } from '../src/features/autoreact.js';
import { AUTOREACT_IDS, SERVER_AUTOREACT_IDS } from '../src/bot/access-ids.js';
import { treeJson, indexTree } from '../src/bot/command-tree.js';
import { Registry } from '../src/bot/registry.js';

const G = '500000000000000001', OTHER = '500000000000000002', GOAT = '400000000000000001', PLAIN = '400000000000000002';

const message = (guildId: string, authorId: string, extra: any = {}) => {
    const reacted: string[] = [];
    return { reacted, m: { guildId, author: { id: authorId }, system: false, webhookId: null, react: async (e: string) => { reacted.push(e); }, ...extra } as any };
};

function withList(global: Record<string, string>, perServer: Record<string, Record<string, string>> = {}) {
    const beforeGlobal = { ...AUTOREACT_IDS }, beforeServer = { ...SERVER_AUTOREACT_IDS };
    for (const key of Object.keys(AUTOREACT_IDS)) delete AUTOREACT_IDS[key];
    for (const key of Object.keys(SERVER_AUTOREACT_IDS)) delete SERVER_AUTOREACT_IDS[key];
    Object.assign(AUTOREACT_IDS, global);
    for (const [guild, list] of Object.entries(perServer)) SERVER_AUTOREACT_IDS[guild] = { ...list };
    return () => {
        for (const key of Object.keys(AUTOREACT_IDS)) delete AUTOREACT_IDS[key];
        for (const key of Object.keys(SERVER_AUTOREACT_IDS)) delete SERVER_AUTOREACT_IDS[key];
        Object.assign(AUTOREACT_IDS, beforeGlobal);
        Object.assign(SERVER_AUTOREACT_IDS, beforeServer);
    };
}

test('emoji input: 🐐 by default, single unicode or custom emoji accepted, text refused', () => {
    assert.equal(parseEmoji(null), '🐐');
    assert.equal(parseEmoji('  '), '🐐');
    assert.equal(parseEmoji('🔥'), '🔥');
    assert.equal(parseEmoji('👍🏽'), '👍🏽');
    assert.equal(parseEmoji('🇺🇸'), '🇺🇸');
    assert.equal(parseEmoji('<:goat:123456789012345678>'), '<:goat:123456789012345678>');
    assert.equal(parseEmoji('<a:spin:123456789012345678>'), '<a:spin:123456789012345678>');
    for (const bad of ['goat', 'hi 🐐', ':goat:', '<:goat:12>', '🐐 🐐 🐐 🐐 🐐 🐐']) assert.equal(parseEmoji(bad), null, bad);
});

test('the list is source-only: global entries apply everywhere, server entries only in their server', async () => {
    const restore = withList({ [GOAT]: '🐐' }, { [G]: { [PLAIN]: '🔥' } });
    try {
        assert.equal(autoReactFor(G, GOAT), '🐐');
        assert.equal(autoReactFor(OTHER, GOAT), '🐐', 'a global entry works in every server');
        assert.equal(autoReactFor(G, PLAIN), '🔥', 'a server entry works in that server');
        assert.equal(autoReactFor(OTHER, PLAIN), null, 'but not in other servers');
        assert.equal(autoReactFor(G, 'someone-else'), null);

        const a = message(G, GOAT), b = message(G, PLAIN), c = message(OTHER, PLAIN), d = message(G, 'someone-else');
        for (const { m } of [a, b, c, d]) await autoReact(m);
        assert.deepEqual(a.reacted, ['🐐']);
        assert.deepEqual(b.reacted, ['🔥']);
        assert.deepEqual(c.reacted, [], 'server-only entries never leak to another server');
        assert.deepEqual(d.reacted, []);
    } finally { restore(); }
});

test('a blank emoji falls back to 🐐, a server entry wins over a global one, and failures are skipped', async () => {
    const restore = withList({ [GOAT]: '' }, { [G]: { [GOAT]: '👀' } });
    try {
        assert.equal(autoReactFor(G, GOAT), '👀', 'the server entry wins');
        assert.equal(autoReactFor(OTHER, GOAT), '🐐', 'a blank value means the default');
        const failing = message(G, GOAT, { react: async () => { throw { code: 50013 }; } });
        await autoReact(failing.m); // missing permission: no crash
        const hook = message(G, GOAT, { webhookId: '1' });
        await autoReact(hook.m);
        assert.deepEqual(hook.reacted, [], 'webhook messages are skipped');
        const system = message(G, GOAT, { system: true });
        await autoReact(system.m);
        assert.deepEqual(system.reacted, [], 'system messages are skipped');
    } finally { restore(); }
});

test('there is no /autoreact command and no /dev autoreact group: it is built into the code', async () => {
    const registry = new Registry();
    await registry.load(new URL('../src/commands', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    indexTree(registry);
    const tree = treeJson(registry);
    assert.equal(tree.find(command => command.name === 'autoreact'), undefined, 'no standalone /autoreact');
    const dev = tree.find(command => command.name === 'dev');
    assert.ok(dev);
    assert.equal(dev.options?.some((option: any) => option.name === 'autoreact'), false, 'no /dev autoreact');
});
