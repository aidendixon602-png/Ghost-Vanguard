import { authorize } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { Store } from '../src/database/db.js';
import { lockGuild, lockdownState, planLock, planUnlock, TEXT_LOCK, unlockGuild, type Overwrite } from '../src/security/lockdown.js';

const P = PermissionFlagsBits;
const b = (...flags: bigint[]) => flags.reduce((all, f) => all | BigInt(f), 0n);
const sorted = (list: Overwrite[]) => [...list].sort((x, y) => x.id.localeCompare(y.id));
const noExempt = () => false;

test('locking denies @everyone, removes non-staff grants, and unlocking restores exactly', () => {
    const original: Overwrite[] = [
        { id: 'g', type: 0, allow: b(P.SendMessages), deny: b(P.MentionEveryone) },
        { id: 'members', type: 0, allow: b(P.SendMessages, P.AttachFiles), deny: 0n },
        { id: 'mods', type: 0, allow: b(P.SendMessages), deny: 0n },
        { id: 'muted', type: 0, allow: 0n, deny: b(P.SendMessages) },
    ];
    const { next, records } = planLock(original, 'g', TEXT_LOCK, o => o.id === 'mods');
    const get = (id: string) => next.find(o => o.id === id)!;
    assert.equal(get('g').deny & TEXT_LOCK, TEXT_LOCK);
    assert.equal(get('g').allow & TEXT_LOCK, 0n);
    assert.equal(get('g').deny & b(P.MentionEveryone), b(P.MentionEveryone), 'unrelated bits are kept');
    assert.equal(get('members').allow, b(P.AttachFiles), 'only the locked grant is removed');
    assert.equal(get('mods').allow, b(P.SendMessages), 'staff keep their access');
    assert.deepEqual(sorted(planUnlock(next, records)), sorted(original));
});

test('an @everyone overwrite created by the lockdown is removed again', () => {
    const { next, records } = planLock([], 'g', TEXT_LOCK, noExempt);
    assert.equal(next.length, 1);
    assert.deepEqual(planUnlock(next, records), []);
});

test('permission edits staff make during the lockdown are kept by the unlock', () => {
    const original: Overwrite[] = [{ id: 'members', type: 0, allow: b(P.SendMessages), deny: 0n }];
    const { next, records } = planLock(original, 'g', TEXT_LOCK, noExempt);
    const during = next.map(o => ({ ...o }));
    during.find(o => o.id === 'g')!.deny |= b(P.ViewChannel);
    during.push({ id: 'newrole', type: 0, allow: b(P.ReadMessageHistory), deny: 0n });
    const after = planUnlock(during, records);
    assert.equal(after.find(o => o.id === 'g')!.deny, b(P.ViewChannel), 'the @everyone overwrite stays because staff added to it');
    assert.equal(after.find(o => o.id === 'members')!.allow, b(P.SendMessages));
    assert.ok(after.some(o => o.id === 'newrole'));
});

test('lock then unlock round-trips 500 random permission setups exactly', () => {
    const pool = [P.SendMessages, P.SendMessagesInThreads, P.CreatePublicThreads, P.AddReactions, P.AttachFiles, P.ViewChannel, P.Connect, P.Speak].map(BigInt);
    const random = () => pool.reduce((all, bit) => Math.random() < 0.3 ? all | bit : all, 0n);
    for (let n = 0; n < 500; n++) {
        const ids = ['g', 'r1', 'r2', 'u1'].filter(() => Math.random() < 0.7);
        const original = ids.map(id => {
            const allow = random();
            return { id, type: id.startsWith('u') ? 1 : 0, allow, deny: random() & ~allow };
        });
        const { next, records } = planLock(original, 'g', TEXT_LOCK, o => o.id === 'r2');
        assert.deepEqual(sorted(planUnlock(next, records)), sorted(original));
    }
});
// A small stand-in for a Discord guild whose channels keep real overwrite state.

function fakeGuild() {
    const channels = new Map<string, any>();
    const sent: {
        channel: string;
        title: string;
    }[] = [], deleted: string[] = [];
    let messageId = 0;
    const channel = (id: string, type: number, overwrites: Overwrite[], failSet = false) => {
        const state = { cache: new Map(overwrites.map(o => [o.id, { id: o.id, type: o.type, allow: { bitfield: o.allow }, deny: { bitfield: o.deny } }])) };
        const c = {
            id, type, rawPosition: channels.size, failSet,
            permissionsFor: () => ({ has: () => true }),
            permissionOverwrites: {
                cache: state.cache,
                set: async (list: any[]) => {
                    if (c.failSet)
                        throw new Error('Missing Permissions');
                    state.cache = new Map(list.map(o => [o.id, { id: o.id, type: o.type, allow: { bitfield: BigInt(o.allow) }, deny: { bitfield: BigInt(o.deny) } }]));
                    c.permissionOverwrites.cache = state.cache;
                },
            },
            send: async (m: any) => {
                sent.push({ channel: id, title: m.embeds[0].data?.title ?? m.embeds[0].toJSON().title });
                return { id: `m${++messageId}` };
            },
            messages: { delete: async (mid: string) => {
                    deleted.push(mid);
                } },
        };
        channels.set(id, c);
        return c;
    };
    const guild: any = {
        id: 'g', ownerId: 'owner', client: { user: { id: 'bot' } },
        members: { me: null, cache: new Map() },
        roles: { everyone: { id: 'g' }, cache: new Map([['mods', { id: 'mods', permissions: { bitfield: b(P.ManageMessages) } }]]) },
        channels: { cache: channels },
    };
    const snapshot = () => new Map([...channels].map(([id, c]) => [id, sorted([...c.permissionOverwrites.cache.values()].map((o: any) => ({ id: o.id, type: o.type, allow: BigInt(o.allow.bitfield), deny: BigInt(o.deny.bitfield) })))]));
    return { guild, channel, sent, deleted, snapshot };
}

function setupStore(path = ':memory:') {
    const store = new Store(path);
    authorize(store);
    return store;
}

const logs: any = { push: () => { } };

test('lockdown posts notices in public text channels, locks voice too, and unlock restores and cleans up', async () => {
    const store = setupStore();
    const f = fakeGuild();
    f.channel('general', ChannelType.GuildText, [{ id: 'members', type: 0, allow: b(P.SendMessages), deny: 0n }]);
    f.channel('news', ChannelType.GuildAnnouncement, []);
    f.channel('voice', ChannelType.GuildVoice, []);
    f.channel('category', ChannelType.GuildCategory, []);
    const before = f.snapshot();
    const locked = await lockGuild({ store, logs }, f.guild, 'mod', 'Raid in progress', 'raid');
    assert.deepEqual([locked.locked, locked.notices, locked.total], [3, 2, 3]);
    assert.deepEqual(f.sent.map(s => s.channel), ['general', 'news'], 'notices only where ordinary messages can be posted');
    assert.deepEqual(f.snapshot().get('category'), before.get('category'), 'categories are not touched');
    await assert.rejects(lockGuild({ store, logs }, f.guild, 'mod', 'again', 'again'), /already|since/i);
    const unlocked = await unlockGuild({ store, logs }, f.guild, 'mod', 'All clear', true);
    assert.deepEqual([unlocked.restored, unlocked.noticesRemoved, unlocked.messages], [3, 2, 2]);
    assert.deepEqual(f.snapshot(), before, 'every channel is back exactly as it was');
    assert.equal(lockdownState(store, 'g'), null);
    await assert.rejects(unlockGuild({ store, logs }, f.guild, 'mod', null, true), /not in lockdown/);
    store.close();
});

test('a channel that cannot be restored keeps the lockdown open so /unlock can be retried', async () => {
    const store = setupStore();
    const f = fakeGuild();
    const stubborn = f.channel('a', ChannelType.GuildText, []);
    f.channel('b', ChannelType.GuildText, []);
    const before = f.snapshot();
    await lockGuild({ store, logs }, f.guild, 'mod', '', 'test');
    stubborn.failSet = true;
    const first = await unlockGuild({ store, logs }, f.guild, 'mod', null, true);
    assert.deepEqual([first.restored, first.failed], [1, 1]);
    assert.ok(lockdownState(store, 'g'), 'the lockdown stays recorded');
    stubborn.failSet = false;
    const second = await unlockGuild({ store, logs }, f.guild, 'mod', null, true);
    assert.deepEqual([second.restored, second.failed], [1, 0]);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(lockdownState(store, 'g'), null);
    store.close();
});

test('a lockdown survives a bot restart and can still be undone exactly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vanguard-lockdown-'));
    const path = join(dir, 'vanguard.db');
    const f = fakeGuild();
    f.channel('general', ChannelType.GuildText, [{ id: 'g', type: 0, allow: b(P.AddReactions), deny: 0n }]);
    const before = f.snapshot();
    const first = setupStore(path);
    await lockGuild({ store: first, logs }, f.guild, 'mod', 'Locked', 'test');
    first.close();
    const restarted = new Store(path);
    assert.ok(lockdownState(restarted, 'g'));
    await unlockGuild({ store: restarted, logs }, f.guild, 'mod', null, true);
    assert.deepEqual(f.snapshot(), before);
    restarted.close();
    rmSync(dir, { recursive: true, force: true });
});
