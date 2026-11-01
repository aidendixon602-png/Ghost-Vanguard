import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { Store } from '../src/database/db.js';
import { authorize } from './helpers.js';
import { setFeature } from '../src/features/settings.js';
import { AUTOMOD_DEFAULTS, automodConfig, clearAutomod, containsBlockedPhrase, processAutomod, processEditedPhrase } from '../src/features/automod.js';
import command from '../src/commands/security/automod.js';

const G = '123456789012345678', U = '223456789012345678';
function fixture() {
    const store = new Store(':memory:'); authorize(store, G);
    const logs: any[] = [], deleted: string[] = [];
    const queue: any = { push: (_g: string, e: any) => logs.push(e.toJSON()) };
    const make = (content: string, staff = false, id = U): any => ({
        inGuild: () => true, author: { id, bot: false, tag: 'test' }, content, id: `msg-${id}`, channelId: 'c', webhookId: null, system: false, partial: false,
        member: { id, permissions: { has: () => staff } }, mentions: { users: new Collection(), roles: new Collection() },
        guild: { id: G, ownerId: 'owner', channels: { cache: new Collection() }, members: { fetch: async () => null } },
        delete: async () => { deleted.push(content); },
    });
    return { store, logs, queue, deleted, make };
}

test('literal Unicode phrase matching avoids substrings and regex injection', () => {
    assert.equal(containsBlockedPhrase('BAD   word!', ['bad word']), true);
    assert.equal(containsBlockedPhrase('badger words', ['bad word', 'bad']), false);
    assert.equal(containsBlockedPhrase('ＦＯＯ', ['foo']), true);
    assert.equal(containsBlockedPhrase('prefix foo suffix', ['f.o']), false);
    assert.equal(containsBlockedPhrase('a f.o b', ['f.o']), true);
    assert.equal(containsBlockedPhrase('привет мир', ['мир']), true);
});

test('phrase filtering is opt-in, checks edits, and exempts staff and trusted users', async () => {
    const f = fixture();
    try {
        setFeature(f.store, G, 'automod', AUTOMOD_DEFAULTS, { spam: false, invites: false, blockedWords: ['bad word'] });
        await processAutomod(f.store, f.queue, f.make('bad word'), () => false);
        assert.equal(f.deleted.length, 0);
        setFeature(f.store, G, 'automod', AUTOMOD_DEFAULTS, { wordsEnabled: true });
        await processAutomod(f.store, f.queue, f.make('Bad word!'), () => false);
        await processEditedPhrase(f.store, f.queue, f.make('edited: bad word'), () => false);
        await processAutomod(f.store, f.queue, f.make('bad word', true, '323456789012345678'), () => false);
        await processEditedPhrase(f.store, f.queue, f.make('bad word', false, '423456789012345678'), () => true);
        assert.deepEqual(f.deleted, ['Bad word!', 'edited: bad word']);
        assert.equal(f.logs.length, 2);
        assert.doesNotMatch(JSON.stringify(f.logs), /bad word/i);
        const failed = f.make('bad word'); failed.delete = async () => { throw new Error('missing permission'); };
        await processEditedPhrase(f.store, f.queue, failed, () => false);
        assert.match(JSON.stringify(f.logs.at(-1)), /Could not delete/);
    } finally { f.store.close(); }
});

test('phrase commands add, list, enable and remove server settings', async () => {
    const f = fixture();
    try {
        let sub = 'word-list', action = 'add', phrase: string | null = '  Bad   Word  ';
        const i: any = { guildId: G, user: { id: U }, options: { getSubcommand: () => sub, getString: (name: string) => name === 'action' ? action : phrase, getBoolean: () => true, getInteger: () => null } };
        const ctx: any = { store: f.store, logs: f.queue };
        await command.execute(ctx, i);
        assert.deepEqual(automodConfig(f.store, G).blockedWords, ['bad word']);
        action = 'list'; phrase = null;
        assert.match(String(await command.execute(ctx, i)), /bad word/);
        sub = 'words'; await command.execute(ctx, i);
        assert.equal(automodConfig(f.store, G).wordsEnabled, true);
        sub = 'word-list'; action = 'remove'; phrase = 'BAD WORD'; await command.execute(ctx, i);
        assert.deepEqual(automodConfig(f.store, G).blockedWords, []);
    } finally { f.store.close(); }
});

test('phrase filtering stops before deletion if server authorization is revoked', async () => {
    const f = fixture();
    try {
        setFeature(f.store, G, 'automod', AUTOMOD_DEFAULTS, { wordsEnabled: true, blockedWords: ['blocked'] });
        await assert.rejects(processEditedPhrase(f.store, f.queue, f.make('blocked'), () => {
            f.store.run("UPDATE guild_authorization SET state='DEAUTHORIZED' WHERE guild_id=?", G);
            return false;
        }), /authoriz/i);
        assert.deepEqual(f.deleted, []);
    } finally { f.store.close(); }
});

test('partial edited messages ignore only the already-deleted race', async () => {
    const f = fixture();
    try {
        setFeature(f.store, G, 'automod', AUTOMOD_DEFAULTS, { wordsEnabled: true, blockedWords: ['blocked'] });
        const msg = f.make('blocked'); msg.partial = true;
        msg.fetch = async () => { throw { code: 10008 }; };
        await processEditedPhrase(f.store, f.queue, msg, () => false);
        msg.fetch = async () => { throw { code: 50013 }; };
        await assert.rejects(processEditedPhrase(f.store, f.queue, msg, () => false), (error: any) => error.code === 50013);
        assert.deepEqual(f.deleted, []);
    } finally { f.store.close(); }
});

test('overlapping phrase matches preserve invite and link strikes', async () => {
    const f = fixture();
    try {
        setFeature(f.store, G, 'automod', AUTOMOD_DEFAULTS, { spam: false, invites: true, links: 'blocklist', blockedDomains: ['blocked.example'], wordsEnabled: true, blockedWords: ['blocked'] });
        let timeouts = 0;
        for (const [id, link] of [[U, 'discord.gg/external'], ['423456789012345678', 'https://blocked.example']] as const) {
            for (let n = 0; n < 3; n++) {
                const msg = f.make(`blocked ${link} message ${n}`, false, id);
                msg.member.moderatable = true;
                msg.member.timeout = async () => { timeouts++; };
                msg.client = { user: { id: '999999999999999999' }, fetchInvite: async () => ({ guild: { id: 'other' } }) };
                msg.channel = { isSendable: () => false };
                await processAutomod(f.store, f.queue, msg, () => false, 100000 + n * 11000);
            }
        }
        assert.equal(f.deleted.length, 6);
        assert.equal(timeouts, 2, 'both existing rules retain their three-strike timeout');
    } finally { clearAutomod(G); f.store.close(); }
});
