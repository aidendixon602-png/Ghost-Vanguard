import { authorize } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/database/db.js';
import { moderate } from '../src/security/moderation.js';

function setup(sub: string, options: Record<string, unknown>, members: Record<string, unknown> = {}) {
    const store = new Store(':memory:');
    authorize(store);
    const settings = store.settings('g');
    settings.authorized = true;
    store.save(settings);
    const bans: Record<string, unknown>[] = [];
    const above = { comparePositionTo: () => 1 };
    const me = { id: 'bot', roles: { highest: above } };
    const guild: any = {
        id: 'g', name: 'Test', ownerId: 'owner',
        members: {
            fetchMe: async () => me,
            fetch: async ({ user }: {
                user: string;
            }) => {
                if (members[user])
                    return members[user];
                throw { code: 10007 };
            },
            ban: async (id: string, options: object) => {
                bans.push({ id, ...options });
            },
        },
    };
    const actor: any = { id: 'mod', guild, roles: { highest: above } };
    const i: any = {
        guild, guildId: 'g', channelId: 'c',
        options: {
            getSubcommand: () => sub,
            getString: (name: string) => options[name] ?? null,
            getInteger: (name: string) => options[name] ?? null,
            getUser: (name: string) => options[name] ?? null,
        },
    };
    return { store, i, actor, bans, logs: { push: () => { } } as any };
}

test('ban can also delete the user\'s recent messages', async () => {
    const { store, i, actor, bans, logs } = setup('ban', { user: { id: 'spammer' }, reason: 'spam', delete_messages: 86400 });
    const reply = await moderate(i, store, logs, actor);
    assert.deepEqual(bans, [{ id: 'spammer', reason: 'mod: spam', deleteMessageSeconds: 86400 }]);
    assert.match(reply, /last 24 hours were deleted/);
    store.close();
});

test('ban keeps messages by default', async () => {
    const { store, i, actor, bans, logs } = setup('ban', { user: { id: 'spammer' }, reason: 'spam' });
    const reply = await moderate(i, store, logs, actor);
    assert.equal(bans[0]!.deleteMessageSeconds, 0);
    assert.doesNotMatch(reply, /deleted/);
    store.close();
});

test('warn tells the moderator when the DM could not be delivered', async () => {
    const member = { id: 'u1', roles: { highest: {} } };
    const closed = setup('warn', { user: { id: 'u1', send: async () => {
                throw new Error('Cannot send messages to this user');
            } }, reason: 'rule 3' }, { u1: member });
    assert.match(await moderate(closed.i, closed.store, closed.logs, closed.actor), /could not be delivered/);
    assert.equal(closed.store.all("SELECT * FROM cases WHERE guild_id=? AND action='warn'", 'g').length, 1, 'the warning is still recorded');
    closed.store.close();
    const open = setup('warn', { user: { id: 'u1', send: async () => ({}) }, reason: 'rule 3' }, { u1: member });
    assert.doesNotMatch(await moderate(open.i, open.store, open.logs, open.actor), /could not be delivered/);
    open.store.close();
});
