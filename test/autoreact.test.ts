import test from 'node:test';
import assert from 'node:assert/strict';
import { authorize } from './helpers.js';
import { Store } from '../src/database/db.js';
import { autoReact, parseEmoji } from '../src/features/autoreact.js';
import { treeJson, indexTree } from '../src/bot/command-tree.js';
import { Registry } from '../src/bot/registry.js';

const G = '500000000000000001', OTHER = '500000000000000002', GOAT = '400000000000000001', PLAIN = '400000000000000002';

const message = (guildId: string, authorId: string, extra: any = {}) => {
    const reacted: string[] = [];
    return { reacted, m: { guildId, author: { id: authorId }, system: false, webhookId: null, react: async (e: string) => { reacted.push(e); }, ...extra } as any };
};

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

test('the bot reacts only to listed members, only in the server they were added in, and survives a restart', async () => {
    const file = `${process.env.TMPDIR ?? '/tmp'}/autoreact-${process.pid}.db`;
    let store = new Store(file); authorize(store, G); authorize(store, OTHER);
    try {
        await store.withAuthorized(G, async () => { store.run('INSERT INTO autoreact_users(guild_id,user_id,emoji,by_id,at) VALUES(?,?,?,?,?)', G, GOAT, '🐐', 'dev', Date.now()); });
        store.close(); store = new Store(file);
        const a = message(G, GOAT), b = message(G, PLAIN), c = message(OTHER, GOAT);
        for (const { m } of [a, b, c]) await store.withAuthorized(m.guildId, () => autoReact(store, m));
        assert.deepEqual(a.reacted, ['🐐']);
        assert.deepEqual(b.reacted, [], 'members not on the list are ignored');
        assert.deepEqual(c.reacted, [], 'the list is per server');
        const failing = message(G, GOAT, { react: async () => { throw { code: 50013 }; } });
        await store.withAuthorized(G, () => autoReact(store, failing.m)); // missing permission: no crash
        const hook = message(G, GOAT, { webhookId: '1' });
        await store.withAuthorized(G, () => autoReact(store, hook.m));
        assert.deepEqual(hook.reacted, [], 'webhook messages are skipped');
    } finally { store.close(); for (const s of ['', '-wal', '-shm']) try { (await import('node:fs')).rmSync(file + s); } catch {} }
});

test('developer auto-reactions are grouped under /dev in slash commands', async () => {
    const registry = new Registry();
    await registry.load(new URL('../src/commands', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    indexTree(registry);
    const tree = treeJson(registry);
    const dev = tree.find(command => command.name === 'dev');
    assert.ok(dev);
    assert.ok(dev.options?.some((option: any) => option.name === 'autoreact'));
});
