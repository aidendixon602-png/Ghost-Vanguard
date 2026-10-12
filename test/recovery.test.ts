import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionsBitField, ChannelType } from 'discord.js';
import { Store } from '../src/database/db.js';
import { Snapshots, type Snapshot, type RoleData, type ChannelData } from '../src/recovery/snapshots.js';
import { ActionPacer, RecoveryLocks, selectComponents } from '../src/recovery/recovery.js';
import { MAX_RATE_LIMIT_WAIT_MS } from '../src/recovery/limits.js';
import { COMPONENT_OPTIONS, showLayoutReview } from '../src/ui/layout-ui.js';
import { overrideRule, RULES } from '../src/core.js';
import { Registry } from '../src/bot/registry.js';
import { authorize } from './helpers.js';

const role = (id: string, name: string, position: number, permissions = '0'): RoleData => ({ id, name, position, permissions, color: 0, hoist: false, mentionable: false, managed: false });
const channel = (id: string, name: string, type: number, position: number, parent: string | null = null): ChannelData => ({ id, name, type, position, parent, overwrites: [{ id: 'g', type: 0, allow: '0', deny: '1024' }] });

function fixture() {
    const store = new Store(':memory:');
    authorize(store);
    const service = new Snapshots(store, 0), calls: string[] = [];
    let next = 0;
    const guild: any = { id: 'g', name: 'Guild', afkTimeout: 300, verificationLevel: 0, explicitContentFilter: 0, defaultMessageNotifications: 0, preferredLocale: 'en-US', afkChannelId: null, systemChannelId: null, rulesChannelId: null, publicUpdatesChannelId: null };
    const roles = new Collection<string, any>(), channels = new Collection<string, any>();
    function addRole(r: RoleData, editable = true) {
        const current: any = { ...r, rawPosition: r.position, permissions: new PermissionsBitField(BigInt(r.permissions)), editable,
            edit: async (props: any) => {
                calls.push(`role-edit:${current.id}`);
                Object.assign(current, props);
                if (props.colors)
                    current.color = props.colors.primaryColor;
                if (props.permissions !== undefined)
                    current.permissions = new PermissionsBitField(props.permissions);
                return current;
            },
            delete: async () => {
                calls.push(`role-delete:${r.id}`);
                roles.delete(r.id);
            } };
        roles.set(r.id, current);
        return current;
    }
    function addChannel(c: ChannelData) {
        const current: any = { ...c, rawPosition: c.position, parentId: c.parent, isThread: () => false };
        const overwriteCache = new Collection<string, any>();
        const set = (items: any[]) => {
            overwriteCache.clear();
            for (const o of items)
                overwriteCache.set(o.id, { ...o, allow: new PermissionsBitField(o.allow), deny: new PermissionsBitField(o.deny) });
        };
        set(c.overwrites.map(o => ({ ...o, allow: BigInt(o.allow), deny: BigInt(o.deny) })));
        current.permissionOverwrites = { cache: overwriteCache, set: async (items: any[]) => {
                calls.push(`overwrite:${c.id}`);
                set(items);
                return current;
            } };
        current.edit = async (props: any) => {
            calls.push(`channel-edit:${c.id}`);
            Object.assign(current, props);
            if ('parent' in props)
                current.parentId = props.parent;
            return current;
        };
        current.delete = async () => {
            calls.push(`channel-delete:${c.id}`);
            channels.delete(c.id);
        };
        channels.set(c.id, current);
        return current;
    }
    addRole(role('g', '@everyone', 0));
    addRole({ ...role('bot', 'Vanguard', 10), managed: true }, false);
    const me = { id: 'bot-user', permissions: new PermissionsBitField(['ManageGuild', 'ManageRoles', 'ManageChannels']), roles: { highest: roles.get('bot'), cache: new Collection([['bot', roles.get('bot')]]) } };
    guild.members = { fetchMe: async () => me, fetch: async (id: string) => ({ id }) };
    guild.roles = { cache: roles, fetch: async () => roles, create: async (props: any) => {
            calls.push(`role-create:${props.name}`);
            return addRole({ ...role(`new-role-${++next}`, props.name, 1), ...props, color: props.colors?.primaryColor ?? props.color ?? 0, permissions: String(props.permissions) });
        }, setPositions: async (items: any[]) => {
            calls.push('role-order:' + items.map(v => roles.get(v.role).name).join(','));
            for (const v of items)
                Object.assign(roles.get(v.role), { position: v.position, rawPosition: v.position });
            return guild;
        } };
    guild.channels = { cache: channels, fetch: async () => channels, create: async (props: any) => {
            calls.push(`channel-create:${props.name}`);
            return addChannel({ ...channel(`new-channel-${++next}`, props.name, props.type, 0, props.parent), ...props, overwrites: props.permissionOverwrites.map((o: any) => ({ ...o, allow: String(new PermissionsBitField(o.allow ?? 0n).bitfield), deny: String(new PermissionsBitField(o.deny ?? 0n).bitfield) })) });
        }, setPositions: async (items: any[]) => {
            calls.push('channel-order:' + items.map(v => channels.get(v.channel).name).join(','));
            for (const v of items)
                Object.assign(channels.get(v.channel), { position: v.position, rawPosition: v.position });
            return guild;
        } };
    guild.edit = async (props: any) => {
        calls.push('guild-edit');
        Object.assign(guild, props);
        return guild;
    };
    const data: Snapshot = { version: 1, guildId: 'g', name: 'Guild', roles: [role('g', '@everyone', 0)], channels: [], unsupported: [], roleMap: {}, channelMap: {} };
    const insert = () => Number(store.run('INSERT INTO snapshots(guild_id,by_id,at,json) VALUES(?,?,?,?)', 'g', 'owner', Date.now(), JSON.stringify(data)).lastInsertRowid);
    const restore = async (id: number, components = selectComponents()) => {
        const p = await service.plan(guild, service.load('g', id).data, false, components);
        return service.restore(guild, id, false, p.fingerprint, { components, actor: 'owner' });
    };
    return { store, service, guild, data, calls, addRole, addChannel, insert, restore };
}

test('repeated restore reuses persistent mappings and sends zero new mutations', async () => {
    const f = fixture();
    f.data.roles.push(role('old-high', 'High', 5, '1024'), role('old-low', 'Low', 2));
    f.data.channels.push(channel('cat-low', 'Lower', 4, 3), channel('cat-high', 'Upper', 4, 0), channel('chat-low', 'second', 0, 2, 'cat-high'), channel('chat-high', 'first', 0, 1, 'cat-high'));
    const id = f.insert();
    const report = await f.restore(id);
    assert.match(report, /Failures:\*\* 0/);
    assert.deepEqual(f.calls.filter(c => c.startsWith('role-create')), ['role-create:High', 'role-create:Low']);
    assert.deepEqual(f.calls.filter(c => c.startsWith('channel-create')), ['channel-create:Upper', 'channel-create:Lower', 'channel-create:first', 'channel-create:second']);
    assert.ok(f.calls.find(c => c === 'role-order:High,Low'));
    assert.ok(f.store.all('SELECT * FROM recovery_mappings').length >= 7);
    const sizes = [f.guild.roles.cache.size, f.guild.channels.cache.size];
    f.calls.length = 0;
    await f.restore(id);
    assert.deepEqual(f.calls, []);
    assert.deepEqual([f.guild.roles.cache.size, f.guild.channels.cache.size], sizes);
    // Recreating the service simulates restart: mappings live in the database.
    const restarted = new Snapshots(f.store, 0), p = await restarted.plan(f.guild, restarted.load('g', id).data, false);
    await restarted.restore(f.guild, id, false, p.fingerprint);
    assert.deepEqual(f.calls, []);
    f.store.close();
});

test('unique matching roles/channels are reused; ambiguous names are skipped', async () => {
    const f = fixture();
    f.data.roles.push(role('old', 'Staff', 3));
    f.addRole(role('live', 'Staff', 3));
    f.data.channels.push(channel('old-cat', 'Lobby', 4, 0));
    f.addChannel(channel('live-cat', 'Lobby', 4, 0));
    const id = f.insert();
    await f.restore(id);
    assert.deepEqual(f.calls, []);
    assert.equal(f.service.load('g', id).data.roleMap.old, 'live');
    const ambiguous = fixture();
    ambiguous.data.roles.push(role('old', 'Staff', 3));
    ambiguous.addRole(role('one', 'Staff', 3));
    ambiguous.addRole(role('two', 'Staff', 4));
    ambiguous.data.channels.push(channel('old-cat', 'Lobby', 4, 0));
    ambiguous.addChannel(channel('one-cat', 'Lobby', 4, 0));
    ambiguous.addChannel(channel('two-cat', 'Lobby', 4, 1));
    const result = await ambiguous.restore(ambiguous.insert());
    assert.match(result, /Ambiguous existing/);
    assert.deepEqual(ambiguous.calls, []);
    f.store.close();
    ambiguous.store.close();
});

test('stored mappings win over matching names and renamed objects are updated', async () => {
    const f = fixture();
    f.data.roles.push(role('old', 'Staff', 3));
    const id = f.insert();
    await f.restore(id);
    const target = f.service.load('g', id).data.roleMap.old!;
    f.guild.roles.cache.get(target).name = 'Renamed';
    f.addRole(role('decoy', 'Staff', 6));
    f.calls.length = 0;
    await f.restore(id);
    assert.equal(f.guild.roles.cache.get(target).name, 'Staff');
    assert.ok(f.calls.includes(`role-edit:${target}`));
    assert.equal(f.calls.filter(c => c.startsWith('role-create')).length, 0);
    f.store.close();
});

test('permissions-only selection never creates objects or edits role appearance', async () => {
    const f = fixture();
    f.data.roles.push(role('staff', 'Snapshot name', 4, '1024'), role('missing', 'Missing', 2));
    f.addRole(role('staff', 'Current name', 4));
    f.data.channels.push(channel('missing-channel', 'missing', 0, 0));
    const result = await f.restore(f.insert(), ['permissions']);
    assert.equal(f.guild.roles.cache.get('staff').name, 'Current name');
    assert.equal(f.guild.roles.cache.get('staff').permissions.bitfield, 1024n);
    assert.deepEqual(f.calls, ['role-edit:staff']);
    assert.match(result, /Missing role for permissions/);
    f.store.close();
});

test('managed roles are never recreated and missing overwrite subjects preserve private channels', async () => {
    const f = fixture();
    f.data.roles.push({ ...role('managed-absent', 'Integration', 5), managed: true });
    const c = channel('chat', 'private', 0, 0);
    c.overwrites.push({ id: 'managed-absent', type: 0, allow: '1024', deny: '0' });
    f.data.channels.push(c);
    const result = await f.restore(f.insert());
    assert.equal(f.calls.some(c => c === 'role-create:Integration'), false);
    assert.match(result, /overwrite subjects could not be resolved safely/);
    const live = [...f.guild.channels.cache.values()][0] as any;
    assert.equal(live.permissionOverwrites.cache.get('g').deny.bitfield, 1024n);
    f.store.close();
});

test('backup failure aborts before creation and releases the recovery lock', async () => {
    const f = fixture();
    f.data.roles.push(role('missing', 'Missing', 3));
    const id = f.insert();
    f.service.save = async () => {
        throw Error('disk full');
    };
    await assert.rejects(f.restore(id), /disk full/);
    assert.deepEqual(f.calls, []);
    assert.equal(f.service.locks.busy('g'), false);
    f.store.close();
});

test('partial failures preserve mappings so retry does not duplicate earlier creations', async () => {
    const f = fixture();
    f.data.roles.push(role('one', 'One', 5), role('two', 'Two', 3));
    const id = f.insert();
    const create = f.guild.roles.create;
    let failed = false;
    f.guild.roles.create = async (props: any) => {
        if (props.name === 'Two' && !failed) {
            failed = true;
            throw Error('temporary failure');
        }
        return create(props);
    };
    assert.match(await f.restore(id), /Failed:\*\* 1/);
    await f.restore(id);
    assert.equal(f.calls.filter(c => c === 'role-create:One').length, 1);
    assert.equal(f.calls.filter(c => c === 'role-create:Two').length, 1);
    f.store.close();
});

test('recovery lock rejects conflicts across services and both layout-copy guilds', async () => {
    const store = new Store(':memory:');
    authorize(store, 'a');
    authorize(store, 'b');
    const locks = new RecoveryLocks(store), other = new RecoveryLocks(store);
    let finish!: () => void;
    const promise = locks.run(['a', 'b'], () => new Promise<void>(resolve => {
        finish = resolve;
    }));
    assert.equal(other.busy('b'), true);
    await assert.rejects(other.run(['b'], async () => { }), /already running/);
    finish();
    await promise;
    assert.equal(other.busy('a'), false);
    assert.equal(other.busy('b'), false);
    await assert.rejects(locks.run(['a'], async () => {
        throw Error('failure');
    }), /failure/);
    assert.equal(other.busy('a'), false);
    store.close();
});

function fakeClock() {
    let time = 0;
    const events: string[] = [];
    return {
        events,
        advance: (ms: number) => {
            time += ms;
        },
        sleep: async (ms: number) => {
            events.push(`wait:${ms}`);
            time += ms;
        },
        now: () => time,
    };
}

test('actions run back to back by default and honor a surfaced short 429 retry_after', async () => {
    const clock = fakeClock();
    const pacer = new ActionPacer(0, () => { }, clock.sleep, clock.now);
    await pacer.run(async () => {
        clock.events.push('first');
    });
    let tries = 0;
    await pacer.run(async () => {
        clock.events.push('second');
        if (tries++ === 0)
            throw { status: 429, rawError: { retry_after: 3 } };
    });
    assert.deepEqual(clock.events, ['first', 'second', 'wait:3000', 'second']);
});

test('a configured delay spaces actions apart, crediting time already elapsed since the last one', async () => {
    const clock = fakeClock();
    const pacer = new ActionPacer(2000, () => { }, clock.sleep, clock.now);
    await pacer.run(async () => {
        clock.events.push('first');
    });
    clock.advance(700);
    await pacer.run(async () => {
        clock.events.push('second');
    });
    clock.advance(2500);
    await pacer.run(async () => {
        clock.events.push('third');
    });
    assert.deepEqual(clock.events, ['first', 'wait:1300', 'second', 'third']);
});

test('a 429 longer than the cap is rethrown, one at the cap is waited out', async () => {
    const clock = fakeClock();
    const pacer = new ActionPacer(0, () => { }, clock.sleep, clock.now);
    const tooLong = { status: 429, rawError: { retry_after: MAX_RATE_LIMIT_WAIT_MS / 1000 + 1 } };
    await assert.rejects(pacer.run(async () => {
        throw tooLong;
    }), error => error === tooLong);
    assert.deepEqual(clock.events, []);
    let tries = 0;
    await pacer.run(async () => {
        if (tries++ === 0)
            throw { status: 429, rawError: { retry_after: MAX_RATE_LIMIT_WAIT_MS / 1000 } };
    });
    assert.deepEqual(clock.events, [`wait:${MAX_RATE_LIMIT_WAIT_MS}`]);
});

test('a surfaced 429 is retried five times, then the error is rethrown', async () => {
    const clock = fakeClock();
    const pacer = new ActionPacer(0, () => { }, clock.sleep, clock.now);
    const limited = { status: 429, rawError: { retry_after: 1 } };
    let calls = 0;
    await assert.rejects(pacer.run(async () => {
        calls++;
        throw limited;
    }), error => error === limited);
    assert.equal(calls, 6);
});

test('All is first and expands to every supported component', () => {
    assert.equal(COMPONENT_OPTIONS[0]!.label, 'All');
    assert.deepEqual(selectComponents(['all']), ['roles', 'categories', 'channels', 'permissions', 'settings']);
    assert.deepEqual(selectComponents(['channels', 'all']), selectComponents());
    assert.throws(() => selectComponents(['unknown']));
});

test('the anti-nuke command offers only on/off, status and checks — no rule editing', async () => {
    const registry = new Registry();
    await registry.load();
    const names = (registry.commands.get('1:antinuke')!.data.options as any[]).map(o => o.name).sort();
    assert.deepEqual(names, ['check', 'disable', 'enable', 'rules', 'status', 'test']);
});

test('layout copy remaps source objects and repeated copies reuse destination mappings', async () => {
    const f = fixture();
    authorize(f.store, 'source');
    f.data.sourceGuildId = 'source';
    f.data.roles[0]!.id = 'source';
    f.data.roles.push(role('source-staff', 'Staff', 3));
    const cat = channel('source-cat', 'Category', 4, 0), chat = channel('source-chat', 'Chat', 0, 1, 'source-cat');
    for (const c of [cat, chat]) {
        c.overwrites[0]!.id = 'source';
        c.overwrites.push({ id: 'source-staff', type: 0, allow: '1024', deny: '0' });
    }
    f.data.channels.push(cat, chat);
    const id = f.insert();
    let p = await f.service.plan(f.guild, f.data, false);
    await f.service.copy({ id: 'source' } as any, f.guild, id, p.fingerprint, { components: selectComponents(), actor: 'owner' });
    const mapped = f.service.load('g', id).data;
    assert.equal(mapped.roleMap.source, 'g');
    const live = f.guild.channels.cache.get(mapped.channelMap['source-chat']) as any;
    assert.equal(live.parentId, mapped.channelMap['source-cat']);
    assert.ok(live.permissionOverwrites.cache.has(mapped.roleMap['source-staff']));
    // A fresh copy has empty snapshot-local maps; the global source/destination mapping is used.
    const again = f.insert();
    p = await f.service.plan(f.guild, f.service.load('g', again).data, false);
    f.calls.length = 0;
    await f.service.copy({ id: 'source' } as any, f.guild, again, p.fingerprint, { components: selectComponents(), actor: 'owner' });
    assert.deepEqual(f.calls, []);
    f.store.close();
});

test('confirmation menus put All first, expand components, and remain valid after partial selection', async () => {
    const f = fixture(), id = f.insert(), replies: any[] = [];
    const pending = { guild: 'g', user: 'owner', snapshot: id, prune: false, fingerprint: '', components: selectComponents(), expires: Date.now() + 10000 };
    const ctx: any = { snapshots: f.service, store: f.store }, interaction: any = { guild: f.guild, editReply: async (r: any) => replies.push(r) };
    await showLayoutReview(ctx, interaction, 'key', pending);
    const payload = replies[0], select = payload.components[0].toJSON().components[0];
    assert.equal(select.options[0].label, 'All');
    assert.equal(select.options[0].default, true);
    assert.match(payload.embeds[0].toJSON().description, /Roles, Categories, Channels, Permissions, Settings/);
    assert.match(payload.components[1].toJSON().components[0].custom_id, /^restore:/);
    pending.components = selectComponents(['roles']);
    await showLayoutReview(ctx, interaction, 'key', pending);
    assert.equal(replies[1].components[0].toJSON().components[0].options.find((o: any) => o.label === 'Roles').default, true);
    f.store.close();
});

test('invalid snapshots reject before backup/mutations and closest valid role order stays descending', async () => {
    const f = fixture();
    f.data.roles.push(role('high', 'High', 30), role('middle', 'Middle', 29), role('low', 'Low', 28));
    const report = await f.restore(f.insert());
    assert.match(report, /closest valid position/);
    const maps = f.service.load('g', 1).data.roleMap;
    const positions = ['high', 'middle', 'low'].map(id => f.guild.roles.cache.get(maps[id]).position);
    assert.ok(positions[0] > positions[1] && positions[1] > positions[2]);
    assert.ok(positions[0] < 10);
    const invalid = fixture();
    invalid.data.channels.push(channel('child', 'Child', 0, 0, 'nonexistent-parent'));
    const id = invalid.insert();
    await assert.rejects(invalid.restore(id), /Invalid or unsupported/);
    assert.deepEqual(invalid.calls, []);
    f.store.close();
    invalid.store.close();
});

test('authorization generation changes interrupt recovery checks and release leases', async () => {
    const store = new Store(':memory:');
    authorize(store);
    const locks = new RecoveryLocks(store);
    await assert.rejects(locks.run(['g'], async (check) => {
        store.run('UPDATE guild_authorization SET generation=generation+1 WHERE guild_id=?', 'g');
        check();
    }), /no longer authorized/);
    assert.equal(locks.busy('g'), false);
    store.close();
});

test('cross-server preview checks destination authorization and security access independently', async () => {
    const { checkDestination } = await import('../src/ui/layout-ui.js');
    const f = fixture();
    const ctx: any = { store: f.store, lifecycle: { isReady: () => true } };
    f.guild.ownerId = 'destination-owner';
    await assert.rejects(checkDestination(ctx, f.guild, 'outsider', selectComponents()), /security access/);
    f.store.grant('g', 'authorized-staff', 'admin', 'owner');
    await checkDestination(ctx, f.guild, 'authorized-staff', selectComponents());
    f.store.run("UPDATE guild_authorization SET state='DEAUTHORIZED' WHERE guild_id=?", 'g');
    await assert.rejects(checkDestination(ctx, f.guild, 'destination-owner', selectComponents()), /authorized and ready/);
    f.store.close();
});

test('settings-only restoration verifies supported guild configuration without creating objects', async () => {
    const f = fixture();
    f.data.settings = { afkTimeout: 900, verificationLevel: 2, explicitContentFilter: 1, defaultMessageNotifications: 1, preferredLocale: 'en-US', afkChannelId: null, systemChannelId: null, rulesChannelId: null, publicUpdatesChannelId: null };
    const report = await f.restore(f.insert(), ['settings']);
    assert.deepEqual(f.calls, ['guild-edit']);
    assert.equal(f.guild.afkTimeout, 900);
    assert.match(report, /Remaining structural differences:\*\* 0/);
    f.store.close();
});

test('category/channel mapping with mismatched types is skipped without creation', async () => {
    const f = fixture();
    f.data.channels.push(channel('old', 'Category', ChannelType.GuildCategory, 0));
    f.data.channelMap.old = 'live';
    f.addChannel(channel('live', 'Text', ChannelType.GuildText, 0));
    const report = await f.restore(f.insert());
    assert.match(report, /Mapped channel type mismatch/);
    assert.deepEqual(f.calls, []);
    f.store.close();
});

test('restored role creation and editing use the current colors API and preserve primary color', async () => {
    const f = fixture();
    const saved = { ...role('old', 'Colored', 3), color: 0x123456 };
    f.data.roles.push(saved);
    const create = f.guild.roles.create;
    f.guild.roles.create = async (props: any) => {
        assert.equal(Object.hasOwn(props, 'color'), false);
        assert.equal(props.colors.primaryColor, 0x123456);
        return create(props);
    };
    const id = f.insert();
    await f.restore(id);
    const live = f.guild.roles.cache.get(f.service.load('g', id).data.roleMap.old)!;
    assert.equal(live.color, 0x123456);
    live.color = 0x654321;
    const edit = live.edit;
    live.edit = async (props: any) => {
        assert.equal(Object.hasOwn(props, 'color'), false);
        assert.equal(props.colors.primaryColor, 0x123456);
        return edit(props);
    };
    await f.restore(id);
    assert.equal(live.color, 0x123456);
    f.calls.length = 0;
    await f.restore(id);
    assert.deepEqual(f.calls, []);
    f.store.close();
});

test('obsolete server and rule-editing commands are retired while current information remains', async () => {
    const registry = new Registry();
    await registry.load();
    assert.equal(registry.commands.has('1:server'), false);
    assert.ok(registry.commands.has('1:server-info'));
    assert.ok(registry.commands.has('1:bot-info'));
    const antinuke = registry.commands.get('1:antinuke')!.data;
    assert.equal(antinuke.options?.some((s: any) => s.name === 'rule'), false);
    assert.equal(registry.commands.has('1:antinuke-rule'), false);
});

test('long Discord wait stops restore, persists partial mappings and report, and releases locks', async () => {
    const f = fixture();
    f.data.roles.push(role('high', 'High', 5), role('low', 'Low', 2));
    const id = f.insert();
    const create = f.guild.roles.create;
    let attempts = 0;
    f.guild.roles.create = async (props: any) => {
        if (++attempts === 2)
            throw { status: 429, rawError: { retry_after: 172800 } };
        return create(props);
    };
    await assert.rejects(f.restore(id), /recovery stopped at Create role Low/);
    assert.equal(f.service.locks.busy('g'), false);
    assert.ok(f.service.load('g', id).data.roleMap.high);
    assert.match(f.store.get('SELECT report FROM recovery_history WHERE snapshot_id=?', id).report, /Backup: #/);
    f.guild.roles.create = create;
    f.calls.length = 0;
    await f.restore(id);
    assert.deepEqual(f.calls.filter(c => c.startsWith('role-create:')), ['role-create:Low']);
    f.store.close();
});
