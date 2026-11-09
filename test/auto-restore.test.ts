import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, ChannelType, Collection, Colors, PermissionsBitField } from 'discord.js';
import { Store } from '../src/database/db.js';
import { Snapshots, type ChannelData, type RoleData, type Snapshot } from '../src/recovery/snapshots.js';
import { AutoRestore, MAX_SETTLE_MS, SETTLE_MS, TRIES } from '../src/recovery/auto-restore.js';
import { BUSY_MESSAGE, selectComponents } from '../src/recovery/recovery.js';
import { incidentRestorePlan } from '../src/recovery/incident-plan.js';
import { AppError } from '../src/errors.js';
import { Security } from '../src/security/security.js';
import { PLUS_DEFAULTS } from '../src/features/plus-settings.js';
import { setFeature } from '../src/features/settings.js';
import { authorize } from './helpers.js';

const TEXT = ChannelType.GuildText, CATEGORY = ChannelType.GuildCategory;
const role = (id: string, name: string, position: number, permissions = '0'): RoleData => ({ id, name, position, permissions, color: 0, hoist: false, mentionable: false, managed: false });
const channel = (id: string, name: string, type: number, position: number, parent: string | null = null, overwrites: ChannelData['overwrites'] = [{ id: 'g', type: 0, allow: '0', deny: '1024' }]): ChannelData => ({ id, name, type, position, parent, overwrites });
const ADMIN = '8', VIEW = '1024';

/** A server that records every change made to it, and a backup of how it used to look. */
function world() {
    const store = new Store(':memory:');
    authorize(store);
    const settings = store.settings('g');
    settings.enabled = true;
    settings.mode = 'enforce';
    store.save(settings);
    const service = new Snapshots(store, 0), calls: string[] = [];
    let next = 0;
    const guild: any = { id: 'g', name: 'Guild', client: { user: { id: 'bot-user' } }, features: [], afkTimeout: 300, verificationLevel: 0, explicitContentFilter: 0, defaultMessageNotifications: 0, preferredLocale: 'en-US', afkChannelId: null, systemChannelId: null, rulesChannelId: null, publicUpdatesChannelId: null };
    const roles = new Collection<string, any>(), channels = new Collection<string, any>();
    function addRole(r: RoleData, editable = true) {
        const current: any = { ...r, rawPosition: r.position, permissions: new PermissionsBitField(BigInt(r.permissions)), editable,
            edit: async (props: any) => {
                calls.push(`role-edit:${current.id}`);
                Object.assign(current, props);
                if (props.colors) current.color = props.colors.primaryColor;
                if (props.permissions !== undefined) current.permissions = new PermissionsBitField(props.permissions);
                return current;
            },
            delete: async () => { calls.push(`role-delete:${r.id}`); roles.delete(r.id); } };
        roles.set(r.id, current);
        return current;
    }
    function addChannel(c: ChannelData) {
        const current: any = { ...c, rawPosition: c.position, parentId: c.parent, isThread: () => false, manageable: true };
        const overwriteCache = new Collection<string, any>();
        const set = (items: any[]) => {
            overwriteCache.clear();
            for (const o of items) overwriteCache.set(o.id, { ...o, allow: new PermissionsBitField(o.allow), deny: new PermissionsBitField(o.deny) });
        };
        set(c.overwrites.map(o => ({ ...o, allow: BigInt(o.allow), deny: BigInt(o.deny) })));
        current.permissionOverwrites = { cache: overwriteCache, set: async (items: any[]) => { calls.push(`overwrite:${current.id}`); set(items); return current; } };
        current.edit = async (props: any) => { calls.push(`channel-edit:${current.id}`); Object.assign(current, props); if ('parent' in props) current.parentId = props.parent; return current; };
        current.delete = async () => { calls.push(`channel-delete:${current.id}`); channels.delete(current.id); };
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
            for (const v of items) Object.assign(roles.get(v.role), { position: v.position, rawPosition: v.position });
            return guild;
        } };
    guild.channels = { cache: channels, fetch: async () => channels, create: async (props: any) => {
            calls.push(`channel-create:${props.name}`);
            return addChannel({ ...channel(`new-channel-${++next}`, props.name, props.type, 0, props.parent), ...props, overwrites: props.permissionOverwrites.map((o: any) => ({ ...o, type: o.type ?? (roles.has(o.id) ? 0 : 1), allow: String(new PermissionsBitField(o.allow ?? 0n).bitfield), deny: String(new PermissionsBitField(o.deny ?? 0n).bitfield) })) });
        }, setPositions: async (items: any[]) => {
            calls.push('channel-order:' + items.map(v => channels.get(v.channel).name).join(','));
            for (const v of items) Object.assign(channels.get(v.channel), { position: v.position, rawPosition: v.position });
            return guild;
        } };
    guild.edit = async (props: any) => { calls.push('guild-edit'); Object.assign(guild, props); return guild; };
    const data: Snapshot = { version: 1, guildId: 'g', name: 'Guild', roles: [role('g', '@everyone', 0)], channels: [], unsupported: [], roleMap: {}, channelMap: {} };
    /** Save the backup as it stands now, `ago` milliseconds in the past. */
    const insert = (ago = 300_000, purpose = 'synced', kind = 'backup') => {
        const id = Number(store.run('INSERT INTO snapshots(guild_id,by_id,at,json) VALUES(?,?,?,?)', 'g', 'bot-user', Date.now() - ago, JSON.stringify(data)).lastInsertRowid);
        store.run('INSERT INTO snapshot_metadata(snapshot_id,guild_id,kind,purpose) VALUES(?,?,?,?)', id, 'g', kind, purpose);
        return id;
    };
    /** The attacker deleted these, a minute ago, and was contained. */
    const deleted = (actor: string, ids: { channels?: string[]; roles?: string[] }) => {
        const at = Date.now() - 60_000;
        for (const id of ids.channels ?? []) store.observe(`d-${id}`, 'g', actor, 'channel_delete', id, at);
        for (const id of ids.roles ?? []) store.observe(`d-${id}`, 'g', actor, 'role_delete', id, at);
        return store.incident('g', actor, 'channel_delete', 'enforce', 'Contained');
    };
    const posted: any[] = [];
    const restorer = (extra: Partial<ConstructorParameters<typeof AutoRestore>[0]> = {}) => new AutoRestore({ store, snapshots: service, post: (_g, card) => { posted.push(card.toJSON()); }, sleep: async () => { }, ...extra });
    return { store, service, guild, data, calls, addRole, addChannel, insert, deleted, posted, restorer, roles, channels };
}

/** The server as it was: one category with two channels, one channel on its own, and three roles. */
function backupOfAWholeServer(w: ReturnType<typeof world>) {
    w.data.roles.push(role('admin', 'Admin', 3, ADMIN), role('mods', 'Mods', 2, '8192'), role('members', 'Members', 1));
    w.data.channels.push(
        channel('cat', 'Community', CATEGORY, 0),
        channel('rules', 'rules', TEXT, 1, 'cat'),
        channel('staff', 'staff-room', TEXT, 2, 'cat', [{ id: 'g', type: 0, allow: '0', deny: VIEW }, { id: 'mods', type: 0, allow: VIEW, deny: '0' }]),
        channel('lonely', 'lonely', TEXT, 3));
}

/** …and after the attack: the Mods role and two channels are gone, and some of what is left has been changed on purpose since the backup. */
function afterTheAttack(w: ReturnType<typeof world>) {
    // Changes made on purpose since the backup: a rename and a permission change on one role, a role moved up,
    // and a channel edited, moved and given other permissions. None of these may be undone by a restore of the deleted objects.
    w.addRole(role('admin', 'Admins', 3, '0'));
    w.addRole(role('members', 'Members', 4));
    w.addChannel(channel('cat', 'Community', CATEGORY, 0));
    w.addChannel({ ...channel('rules', 'rules', TEXT, 5, 'cat', [{ id: 'g', type: 0, allow: '0', deny: '0' }]), topic: 'edited on purpose' } as any);
}

test('re-create only: puts back exactly the deleted objects and edits nothing else', async () => {
    const w = world();
    try {
        backupOfAWholeServer(w);
        afterTheAttack(w);
        const id = w.insert();
        const recreate = { roles: ['mods'], channels: ['staff', 'lonely'] };
        const components = ['roles', 'categories', 'channels', 'permissions'] as any;
        const plan = await w.service.plan(w.guild, w.service.load('g', id).data, false, components, recreate);
        assert.deepEqual([plan.roleCreate, plan.channelCreate, plan.roleUpdate, plan.channelUpdate], [1, 2, 0, 0], 'the preview counts only what is missing');
        const report = await w.service.restore(w.guild, id, false, plan.fingerprint, { components, actor: 'bot-user', recreate, quiet: true });
        assert.match(report, /\*\*Created:\*\* 3/);
        assert.match(report, /\*\*Updated:\*\* 3/, 'the three updates are the saved permissions being applied to the three new objects');
        assert.match(report, /\*\*Failures:\*\* 0/);
        assert.match(report, /\*\*Remaining structural differences:\*\* 0/);
        const edits = w.calls.filter(c => /edit|overwrite|order/.test(c));
        assert.ok(edits.every(c => /^(role-edit:new-role-\d+|overwrite:new-channel-\d+|role-order:Mods|channel-order:lonely,staff-room)$/.test(c)), `every edit lands on a new object or orders only the new ones: ${edits.join(' ')}`);
        assert.deepEqual(w.calls.filter(c => /create/.test(c)), ['role-create:Mods', 'channel-create:lonely', 'channel-create:staff-room'], 'roles first, then channels with no category, then the rest');
        assert.ok(!w.calls.some(c => c === 'role-edit:admin' || c === 'channel-edit:rules' || c === 'overwrite:rules' || c === 'role-delete:members'), `nothing that still exists was touched: ${w.calls.join(' ')}`);
        assert.equal(w.roles.get('admin').name, 'Admins', 'a rename made since the backup is kept');
        assert.equal(w.channels.get('rules').topic, 'edited on purpose', 'an edit made since the backup is kept');
        // The new channel sits in its old category, and its saved permissions point at the re-created role.
        const staff = [...w.channels.values()].find(c => c.name === 'staff-room');
        assert.equal(staff.parentId, 'cat');
        const mods = [...w.roles.values()].find(r => r.name === 'Mods');
        assert.equal(mods.permissions.bitfield, 8192n, 'the role comes back with its saved permissions');
        assert.ok(staff.permissionOverwrites.cache.has(mods.id), 'its overwrite follows the new role, not the dead ID');
        assert.deepEqual(staff.permissionOverwrites.cache.get('g').deny.bitfield, BigInt(VIEW));
        // Nothing was written about objects that were not asked for.
        assert.deepEqual(w.store.all('SELECT kind,source_id FROM recovery_mappings').map(r => `${r.kind}:${r.source_id}`).sort(), ['channel:lonely', 'channel:staff', 'role:mods']);
    } finally { w.store.close(); }
});

test('re-create only: a channel is not skipped because another category has a channel with the same name', async () => {
    const w = world();
    try {
        w.data.channels.push(channel('cat-a', 'A', CATEGORY, 0), channel('cat-b', 'B', CATEGORY, 1), channel('general-a', 'general', TEXT, 1, 'cat-a'), channel('general-b', 'general', TEXT, 2, 'cat-b'));
        w.addChannel(channel('cat-a', 'A', CATEGORY, 0));
        w.addChannel(channel('cat-b', 'B', CATEGORY, 1));
        w.addChannel(channel('general-b', 'general', TEXT, 2, 'cat-b'));
        const id = w.insert();
        const components = ['categories', 'channels', 'permissions'] as any, recreate = { roles: [], channels: ['general-a'] };
        const plan = await w.service.plan(w.guild, w.service.load('g', id).data, false, components, recreate);
        assert.equal(plan.channelCreate, 1, 'the one in A is missing even though B has a #general');
        assert.deepEqual(plan.skipped, []);
        await w.service.restore(w.guild, id, false, plan.fingerprint, { components, actor: 'bot-user', recreate, quiet: true });
        const again = [...w.channels.values()].filter(c => c.name === 'general');
        assert.deepEqual(again.map(c => c.parentId).sort(), ['cat-a', 'cat-b']);
        assert.equal(w.channels.get('general-b').parentId, 'cat-b', 'the other #general is untouched');
        assert.ok(!w.calls.includes('channel-edit:general-b'));
    } finally { w.store.close(); }
});

test('re-create only: a deleted category and the channels inside it all come back, in order', async () => {
    const w = world();
    try {
        w.data.channels.push(channel('cat', 'Staff', CATEGORY, 0), channel('one', 'one', TEXT, 1, 'cat'), channel('two', 'two', TEXT, 2, 'cat'));
        const id = w.insert();
        const components = ['categories', 'channels', 'permissions'] as any, recreate = { roles: [], channels: ['cat', 'one', 'two'] };
        const plan = await w.service.plan(w.guild, w.service.load('g', id).data, false, components, recreate);
        assert.equal(plan.channelCreate, 3);
        await w.service.restore(w.guild, id, false, plan.fingerprint, { components, actor: 'bot-user', recreate, quiet: true });
        assert.deepEqual(w.calls.filter(c => c.startsWith('channel-create')), ['channel-create:Staff', 'channel-create:one', 'channel-create:two']);
        const category = [...w.channels.values()].find(c => c.name === 'Staff');
        assert.deepEqual([...w.channels.values()].filter(c => c.name !== 'Staff').map(c => c.parentId), [category.id, category.id]);
    } finally { w.store.close(); }
});

test('re-create only: a deleted category is put back even when a spam category with the same name exists', async () => {
    const w = world();
    try {
        w.data.channels.push(channel('cat', 'Staff', CATEGORY, 0), channel('one', 'one', TEXT, 1, 'cat'));
        w.addChannel(channel('spam', 'Staff', CATEGORY, 0));
        const id = w.insert();
        const components = ['categories', 'channels', 'permissions'] as any, recreate = { roles: [], channels: ['cat', 'one'] };
        const plan = await w.service.plan(w.guild, w.service.load('g', id).data, false, components, recreate);
        assert.equal(plan.channelCreate, 2, 'the category and the channel inside it are both missing');
        assert.deepEqual(plan.skipped, [], 'the child is not held back by the look-alike category');
        await w.service.restore(w.guild, id, false, plan.fingerprint, { components, actor: 'bot-user', recreate, quiet: true });
        const created = [...w.channels.values()].filter(c => c.id.startsWith('new-channel'));
        const category = created.find(c => c.name === 'Staff'), child = created.find(c => c.name === 'one');
        assert.ok(category && child);
        assert.equal(child.parentId, category.id, 'the channel went into the re-created category, not the spam one');
        assert.ok(!w.calls.includes('channel-edit:spam'));
    } finally { w.store.close(); }
});

test('re-create only: a look-alike role with the deleted role\'s name is not adopted in its place', async () => {
    const w = world();
    try {
        w.data.roles.push(role('mods', 'Mods', 2, '8192'));
        w.addRole(role('spam', 'Mods', 1));
        const id = w.insert();
        const components = ['roles', 'permissions'] as any, recreate = { roles: ['mods'], channels: [] };
        const plan = await w.service.plan(w.guild, w.service.load('g', id).data, false, components, recreate);
        assert.equal(plan.roleCreate, 1);
        await w.service.restore(w.guild, id, false, plan.fingerprint, { components, actor: 'bot-user', recreate, quiet: true });
        assert.equal([...w.roles.values()].filter(r => r.name === 'Mods').length, 2);
        assert.ok(!w.calls.includes('role-edit:spam'), 'the look-alike is not edited into the real thing');
    } finally { w.store.close(); }
});

test('re-create only: what could not be put back is named, and nothing else is reported', async () => {
    const w = world();
    try {
        w.data.roles.push({ ...role('bot-role', 'Some Bot', 4), managed: true }, role('mods', 'Mods', 2));
        w.data.channels.push(channel('cat', 'Gone', CATEGORY, 0));
        w.data.unsupported.push('77:rules-thing');
        w.addRole(role('ambient', 'Ambient', 5));
        const id = w.insert();
        const components = ['roles', 'categories', 'channels', 'permissions'] as any;
        const recreate = { roles: ['bot-role'], channels: ['77'] };
        const plan = await w.service.plan(w.guild, w.service.load('g', id).data, false, components, recreate);
        assert.deepEqual([...plan.skipped].sort(), [
            'Channel rules-thing was not put back: Vanguard cannot create that type of channel.',
            'Role Some Bot was not put back: it belongs to an integration.',
        ]);
        assert.equal(plan.roleCreate + plan.channelCreate, 0, 'neither of them can be created');
        assert.ok(!plan.skipped.some(s => /Ambient|Gone|Mods/.test(s)), 'objects nobody asked about are not mentioned');
        // A channel whose category is neither live nor asked for is named in the report, in plain words.
        w.data.channels.push(channel('kid', 'kid', TEXT, 1, 'cat'));
        const second = w.insert(), recreateKid = { roles: [], channels: ['kid'] };
        const p2 = await w.service.plan(w.guild, w.service.load('g', second).data, false, components, recreateKid);
        const report = await w.service.restore(w.guild, second, false, p2.fingerprint, { components, actor: 'bot-user', recreate: recreateKid, quiet: true });
        assert.match(report, /\nMissing category for kid\.(\n|$)/);
        assert.doesNotMatch(report, /select Categories/);
    } finally { w.store.close(); }
});

test('re-create only: a restore that stopped before applying permissions finishes the job when run again, without making anything twice', async () => {
    const w = world();
    try {
        backupOfAWholeServer(w);
        afterTheAttack(w);
        const id = w.insert();
        const components = ['roles', 'categories', 'channels', 'permissions'] as any, recreate = { roles: ['mods'], channels: ['staff', 'lonely'] };
        // First run: Discord refuses to set permissions on the new role and on the new #staff-room.
        let refuse = true;
        const createRole = w.guild.roles.create, createChannel = w.guild.channels.create;
        w.guild.roles.create = async (props: any) => {
            const made = await createRole(props), edit = made.edit;
            made.edit = async (changes: any) => { if (refuse && changes.permissions !== undefined) throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); return edit(changes); };
            return made;
        };
        w.guild.channels.create = async (props: any) => {
            const made = await createChannel(props), set = made.permissionOverwrites.set;
            if (props.name === 'staff-room') made.permissionOverwrites.set = async (items: any[], reason: string) => { if (refuse) throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); return set(items, reason); };
            return made;
        };
        const first = await w.service.plan(w.guild, w.service.load('g', id).data, false, components, recreate);
        const firstReport = await w.service.restore(w.guild, id, false, first.fingerprint, { components, actor: 'bot-user', recreate, quiet: true });
        assert.match(firstReport, /Role permissions Mods: Discord denied access/);
        assert.match(firstReport, /Channel permissions staff-room: Discord denied access/);
        assert.equal([...w.roles.values()].find(r => r.name === 'Mods').permissions.bitfield, 0n, 'the role is back but still has no permissions');
        // Second run: nothing is missing any more, so nothing is created, and the permissions are applied.
        refuse = false;
        w.calls.length = 0;
        const second = await w.service.plan(w.guild, w.service.load('g', id).data, false, components, recreate);
        assert.deepEqual([second.roleCreate, second.channelCreate, second.roleUpdate, second.channelUpdate], [0, 0, 0, 0], 'the preview counts creations only');
        const secondReport = await w.service.restore(w.guild, id, false, second.fingerprint, { components, actor: 'bot-user', recreate, quiet: true });
        assert.match(secondReport, /\*\*Created:\*\* 0/);
        assert.match(secondReport, /\*\*Reused:\*\* 0/, 'the counts describe what this run made, not every object that happens to exist');
        assert.deepEqual(w.calls.filter(c => /create/.test(c)), [], 'nothing is made twice');
        const mods = [...w.roles.values()].find(r => r.name === 'Mods'), staff = [...w.channels.values()].find(c => c.name === 'staff-room');
        assert.equal(mods.permissions.bitfield, 8192n, 'the permissions went on');
        assert.ok(staff.permissionOverwrites.cache.has(mods.id), 'and so did the channel\'s overwrite for that role');
        assert.ok(!w.calls.some(c => c === 'role-edit:admin' || c === 'channel-edit:rules' || c === 'overwrite:rules' || c === 'role-edit:members'), `still nothing else was touched: ${w.calls.join(' ')}`);
        assert.equal([...w.roles.values()].filter(r => r.name === 'Mods').length, 1);
    } finally { w.store.close(); }
});

test('re-create only never touches server settings or deletes extras, even if both are asked for', async () => {
    const w = world();
    try {
        backupOfAWholeServer(w);
        w.data.settings = { afkTimeout: 300, verificationLevel: 2, explicitContentFilter: 0, defaultMessageNotifications: 0, preferredLocale: 'en-US', afkChannelId: null, systemChannelId: null, rulesChannelId: null, publicUpdatesChannelId: null };
        afterTheAttack(w);
        w.addRole(role('extra', 'Not in the backup', 1));
        w.addChannel(channel('extra-channel', 'not-in-the-backup', TEXT, 9));
        const id = w.insert();
        const recreate = { roles: ['mods'], channels: ['staff'] };
        const everything = selectComponents();
        const plan = await w.service.plan(w.guild, w.service.load('g', id).data, true, everything, recreate);
        assert.deepEqual([plan.settingsUpdate, plan.roleDelete, plan.channelDelete], [0, [], []], 'the preview plans no settings change and no deletion');
        const report = await w.service.restore(w.guild, id, true, plan.fingerprint, { components: everything, actor: 'bot-user', recreate, quiet: true });
        assert.ok(!w.calls.includes('guild-edit'), 'verification level and the rest are left as they are');
        assert.ok(!w.calls.some(c => c.endsWith('-delete:extra') || c.endsWith('-delete:extra-channel')), 'extras are not pruned');
        assert.doesNotMatch(report, /does not contain supported guild settings|Deletion of extras/);
        assert.deepEqual(w.calls.filter(c => /create/.test(c)), ['role-create:Mods', 'channel-create:staff-room']);
    } finally { w.store.close(); }
});

test('without re-create the restore behaves exactly as before: it also edits what drifted', async () => {
    const w = world();
    try {
        backupOfAWholeServer(w);
        afterTheAttack(w);
        const id = w.insert();
        const components = ['roles', 'categories', 'channels', 'permissions'] as any;
        const plan = await w.service.plan(w.guild, w.service.load('g', id).data, false, components);
        assert.ok(plan.roleUpdate >= 1 && plan.channelUpdate >= 1, 'a full restore still brings drifted objects back to the backup');
        await w.service.restore(w.guild, id, false, plan.fingerprint, { components, actor: 'owner' });
        assert.ok(w.calls.includes('role-edit:admin'));
        assert.ok(w.calls.includes('channel-edit:rules'));
    } finally { w.store.close(); }
});

test('a quiet restore records its audit trail but posts no cards', async () => {
    const w = world();
    try {
        const cards: string[] = [];
        w.service.onAudit = (_g, title) => { cards.push(title); };
        w.data.channels.push(channel('lonely', 'lonely', TEXT, 1));
        const id = w.insert();
        const components = ['channels', 'permissions'] as any, recreate = { roles: [], channels: ['lonely'] };
        const plan = await w.service.plan(w.guild, w.service.load('g', id).data, false, components, recreate);
        await w.service.restore(w.guild, id, false, plan.fingerprint, { components, actor: 'bot-user', recreate, quiet: true });
        assert.deepEqual(cards, []);
        const events = w.store.all('SELECT event FROM recovery_events ORDER BY id').map(r => r.event);
        assert.deepEqual(events, ['restore_started', 'backup_created', 'restore_finished']);
        await w.service.restore(w.guild, id, false, (await w.service.plan(w.guild, w.service.load('g', id).data, false, components)).fingerprint, { components, actor: 'owner' });
        assert.deepEqual(cards, ['restore started', 'backup created', 'restore finished'], 'a manual restore still posts its cards');
    } finally { w.store.close(); }
});

// ---- AutoRestore ----

test('auto-restore puts back what the attacker deleted from the newest backup before the first deletion', async () => {
    const w = world();
    try {
        backupOfAWholeServer(w);
        const stale = w.insert(2 * 3600_000), fresh = w.insert(5 * 60_000);
        // A backup saved after the deletions began must never be the one used.
        const poisoned = w.insert(10_000);
        void stale; void poisoned;
        afterTheAttack(w);
        const engineCards: string[] = [];
        w.service.onAudit = (_g, title) => { engineCards.push(title); };
        const incident = w.deleted('nuker', { channels: ['staff', 'lonely'], roles: ['mods'] });
        const outcome = await w.restorer().restoreNow(w.guild, 'nuker', incident);
        assert.equal(outcome, 'restored');
        assert.deepEqual(w.calls.filter(c => /create/.test(c)), ['role-create:Mods', 'channel-create:lonely', 'channel-create:staff-room']);
        assert.ok(!w.calls.includes('role-edit:admin') && !w.calls.includes('channel-edit:rules'), 'only the deleted objects are touched');
        assert.deepEqual(engineCards, [], 'the engine posts nothing of its own');
        assert.equal(w.posted.length, 1, 'one card for the whole thing');
        const card = w.posted[0];
        assert.equal(card.title, `Put back from backup #${w.service.numberOf('g', fresh)}`);
        assert.match(card.description, /<@nuker> deleted 2 channels and 1 role\. Vanguard put back 2 channels and 1 role from backup #\d+, saved <t:\d+:R>\./);
        assert.match(card.description, /Only what was deleted was re-created; nothing else was changed\. Messages in a deleted channel cannot be brought back\./);
        assert.doesNotMatch(card.description, /Still missing/);
        assert.equal(card.color, Colors.Green, 'green when everything is back');
    } finally { w.store.close(); }
});

test('a second look finds everything already back and says nothing', async () => {
    const w = world();
    try {
        backupOfAWholeServer(w);
        w.insert();
        afterTheAttack(w);
        const incident = w.deleted('nuker', { channels: ['staff', 'lonely'], roles: ['mods'] });
        const auto = w.restorer();
        assert.equal(await auto.restoreNow(w.guild, 'nuker', incident), 'restored');
        w.posted.length = 0; w.calls.length = 0;
        assert.equal(await auto.restoreNow(w.guild, 'nuker', incident), 'already-back');
        assert.deepEqual(w.calls.filter(c => /create/.test(c)), [], 'nothing is created twice');
        assert.deepEqual(w.posted, []);
    } finally { w.store.close(); }
});

test('only the deletions of the contained person are restored, not someone else\'s', async () => {
    const w = world();
    try {
        backupOfAWholeServer(w);
        w.insert();
        afterTheAttack(w);
        // 'lonely' was deleted by a different person (a moderator tidying up); only 'staff' belongs to the incident.
        w.store.observe('d-lonely', 'g', 'moderator', 'channel_delete', 'lonely', Date.now() - 60_000);
        const incident = w.deleted('nuker', { channels: ['staff'] });
        await w.restorer().restoreNow(w.guild, 'nuker', incident);
        assert.deepEqual(w.calls.filter(c => /create/.test(c)), ['channel-create:staff-room']);
    } finally { w.store.close(); }
});

test('no backup from before the deletions: the card says so and points at backup sync', async () => {
    const w = world();
    try {
        backupOfAWholeServer(w);
        w.insert(10_000);
        afterTheAttack(w);
        const incident = w.deleted('nuker', { channels: ['staff'] });
        assert.equal(await w.restorer().restoreNow(w.guild, 'nuker', incident), 'no-backup');
        assert.equal(w.posted[0].title, 'Could not put back what was deleted');
        assert.match(w.posted[0].description, /no backup was saved before that.*\/antinuke settings.*\/setup config backups/s);
        assert.deepEqual(w.calls, []);
    } finally { w.store.close(); }
});

test('a backup that predates the deleted objects cannot restore them, and the card says so', async () => {
    const w = world();
    try {
        w.insert();
        afterTheAttack(w);
        const incident = w.deleted('nuker', { channels: ['made-after-the-backup'] });
        assert.equal(await w.restorer().restoreNow(w.guild, 'nuker', incident), 'not-in-backup');
        assert.match(w.posted[0].description, /None of them are in backup #\d+, which is older than they are/);
        assert.deepEqual(w.calls, []);
    } finally { w.store.close(); }
});

test('deleted roles that are newer than the backup, or belong to an integration, are not counted as restorable', async () => {
    const w = world();
    try {
        w.data.roles.push({ ...role('integration', 'Some Bot', 4), managed: true });
        w.insert();
        afterTheAttack(w);
        const incident = w.deleted('nuker', { roles: ['made-after-the-backup', 'integration'] });
        assert.equal(await w.restorer().restoreNow(w.guild, 'nuker', incident), 'not-in-backup');
        assert.match(w.posted[0].description, /deleted 2 roles\. None of them are in backup #\d+/);
        assert.deepEqual(w.calls, []);
    } finally { w.store.close(); }
});

test('an unreadable newest backup is skipped for the next one', async () => {
    const w = world();
    try {
        backupOfAWholeServer(w);
        const good = w.insert(20 * 60_000);
        const broken = w.insert(5 * 60_000);
        w.store.run('UPDATE snapshots SET json=? WHERE id=?', '{"version":2}', broken);
        afterTheAttack(w);
        const incident = w.deleted('nuker', { channels: ['lonely'] });
        assert.equal(await w.restorer().restoreNow(w.guild, 'nuker', incident), 'restored');
        assert.match(w.posted[0].title, new RegExp(`#${w.service.numberOf('g', good)}$`));
    } finally { w.store.close(); }
});

test('auto-restore does nothing when switched off, when anti-nuke only observes, or when backups are off', async () => {
    for (const how of ['setting', 'observe', 'feature'] as const) {
        const w = world();
        try {
            backupOfAWholeServer(w);
            w.insert();
            afterTheAttack(w);
            const incident = w.deleted('nuker', { channels: ['lonely'] });
            if (how === 'setting') setFeature(w.store, 'g', 'antinukeplus', PLUS_DEFAULTS, { autoRestore: false });
            if (how === 'observe') { const s = w.store.settings('g'); s.mode = 'observe'; w.store.save(s); }
            if (how === 'feature') w.store.run("INSERT INTO feature_settings(guild_id,feature,enabled) VALUES('g','snapshots',0)");
            const outcome = await w.restorer().restoreNow(w.guild, 'nuker', incident);
            assert.equal(outcome, how === 'observe' ? 'not-enforcing' : 'off', how);
            assert.deepEqual(w.calls, [], how);
            assert.deepEqual(w.posted, [], how);
            assert.equal(await w.restorer().schedule(w.guild, 'nuker', incident), how === 'observe' ? 'not-enforcing' : 'off', `${how} through schedule`);
        } finally { w.store.close(); }
    }
});

test('an incident with no recorded deletions has nothing to restore', async () => {
    const w = world();
    try {
        w.insert();
        const incident = w.store.incident('g', 'pruner', 'member_prune', 'enforce', 'Contained');
        assert.equal(await w.restorer().restoreNow(w.guild, 'pruner', incident), 'nothing');
        assert.equal(await w.restorer().restoreNow(w.guild, 'pruner', 9999), 'nothing');
        assert.deepEqual(w.posted, []);
    } finally { w.store.close(); }
});

test('a restore that finds another recovery running, or the server changing, is tried again', async () => {
    const w = world();
    try {
        backupOfAWholeServer(w);
        w.insert();
        afterTheAttack(w);
        const incident = w.deleted('nuker', { channels: ['lonely'] });
        const real = w.service.restore.bind(w.service), waits: number[] = [];
        let attempts = 0;
        w.service.restore = (async (...args: Parameters<Snapshots['restore']>) => {
            attempts++;
            if (attempts === 1) throw new AppError('VALIDATION_ERROR', BUSY_MESSAGE);
            if (attempts === 2) throw new AppError('VALIDATION_ERROR', 'The server changed after the preview. Run /recovery snapshot restore again to review a fresh plan.');
            return real(...args);
        }) as any;
        const outcome = await w.restorer({ sleep: async ms => { waits.push(ms); } }).restoreNow(w.guild, 'nuker', incident);
        assert.equal(outcome, 'restored');
        assert.equal(attempts, 3);
        assert.deepEqual(waits, [5000, 5000]);
        assert.equal(TRIES, 3);
    } finally { w.store.close(); }
});

test('a restore that keeps failing stops after the last try and says why', async () => {
    const w = world();
    try {
        backupOfAWholeServer(w);
        w.insert();
        afterTheAttack(w);
        const incident = w.deleted('nuker', { channels: ['lonely'] });
        let attempts = 0;
        w.service.restore = (async () => { attempts++; throw new AppError('VALIDATION_ERROR', BUSY_MESSAGE); }) as any;
        assert.equal(await w.restorer().restoreNow(w.guild, 'nuker', incident), 'failed');
        assert.equal(attempts, TRIES);
        assert.equal(w.posted[0].title, 'Could not put back what was deleted');
        assert.match(w.posted[0].description, /A server recovery operation is already running\./);
        assert.match(w.posted[0].description, /Review restore/);
        assert.equal(w.posted[0].color, Colors.Red);
    } finally { w.store.close(); }
});

test('an error that is not worth retrying is reported at once', async () => {
    const w = world();
    try {
        backupOfAWholeServer(w);
        w.insert();
        afterTheAttack(w);
        const incident = w.deleted('nuker', { channels: ['lonely'] });
        let attempts = 0;
        w.service.restore = (async () => { attempts++; throw new Error('Missing Permissions'); }) as any;
        assert.equal(await w.restorer().restoreNow(w.guild, 'nuker', incident), 'failed');
        assert.equal(attempts, 1);
        assert.match(w.posted[0].description, /Missing Permissions/);
    } finally { w.store.close(); }
});

test('a restore that could only do part says what is still missing', async () => {
    const w = world();
    try {
        backupOfAWholeServer(w);
        w.insert();
        afterTheAttack(w);
        const incident = w.deleted('nuker', { channels: ['staff', 'lonely'], roles: ['mods'] });
        // Discord refuses to create one of the channels.
        const create = w.guild.channels.create;
        w.guild.channels.create = async (props: any) => { if (props.name === 'lonely') throw Object.assign(new Error('Missing Access'), { code: 50001 }); return create(props); };
        assert.equal(await w.restorer().restoreNow(w.guild, 'nuker', incident), 'incomplete');
        const card = w.posted[0];
        assert.match(card.title, /^Partly put back from backup #/);
        assert.match(card.description, /put back 1 channel and 1 role from backup/);
        assert.match(card.description, /\*\*Still missing:\*\* 1 channel\./);
        assert.match(card.description, /• Create lonely: Discord denied access or management permissions\./);
        assert.equal(card.color, Colors.Orange);
    } finally { w.store.close(); }
});

test('what was deleted but is not in the backup is named, and the result is called partial', async () => {
    const w = world();
    try {
        backupOfAWholeServer(w);
        w.insert();
        afterTheAttack(w);
        const incident = w.deleted('nuker', { channels: ['staff', 'made-after-the-backup'], roles: ['mods', 'also-new'] });
        assert.equal(await w.restorer().restoreNow(w.guild, 'nuker', incident), 'incomplete');
        const card = w.posted[0];
        assert.match(card.title, /^Partly put back from backup #/);
        assert.match(card.description, /deleted 2 channels and 2 roles\. Vanguard put back 1 channel and 1 role from backup/);
        assert.match(card.description, /\*\*Not in the backup:\*\* 1 channel and 1 role\. They were made after it was saved, or are a kind Vanguard cannot create\./);
        assert.doesNotMatch(card.description, /Still missing/, 'nothing that could be put back is missing');
        assert.equal(card.color, Colors.Orange);
    } finally { w.store.close(); }
});

test('a restore that skipped something is not called complete, and the skipped item is listed', async () => {
    const w = world();
    try {
        backupOfAWholeServer(w);
        // The category of #staff-room is gone too, but nobody asked for it, so the channel cannot be placed.
        w.insert();
        afterTheAttack(w);
        w.channels.delete('cat');
        w.channels.get('rules').parentId = null;
        const incident = w.deleted('nuker', { channels: ['staff'] });
        assert.equal(await w.restorer().restoreNow(w.guild, 'nuker', incident), 'incomplete');
        assert.match(w.posted[0].title, /^Partly put back/);
        assert.match(w.posted[0].description, /• Missing category for staff-room\./);
    } finally { w.store.close(); }
});

test('everything is back but a permission could not be applied: partial, with the reason', async () => {
    const w = world();
    try {
        backupOfAWholeServer(w);
        w.insert();
        afterTheAttack(w);
        const incident = w.deleted('nuker', { channels: ['lonely'] });
        const create = w.guild.channels.create;
        w.guild.channels.create = async (props: any) => {
            const made = await create(props);
            made.permissionOverwrites.set = async () => { throw new Error('Request entity too large'); };
            return made;
        };
        assert.equal(await w.restorer().restoreNow(w.guild, 'nuker', incident), 'incomplete');
        assert.match(w.posted[0].title, /^Partly put back/);
        assert.match(w.posted[0].description, /• Channel permissions lonely: Request entity too large/);
        assert.doesNotMatch(w.posted[0].description, /Still missing/, 'the channel itself is back');
    } finally { w.store.close(); }
});

test('a channel whose saved permissions point at a role that is not coming back stays private, and the card says so', async () => {
    const w = world();
    try {
        backupOfAWholeServer(w);
        w.insert();
        afterTheAttack(w);
        // #staff-room let the Mods role in, and Mods is gone and was not deleted by this person.
        const incident = w.deleted('nuker', { channels: ['staff'] });
        assert.equal(await w.restorer().restoreNow(w.guild, 'nuker', incident), 'incomplete');
        assert.match(w.posted[0].description, /• Unresolved overwrite role mods on staff-room/);
        assert.match(w.posted[0].description, /• Permissions unchanged for staff-room: overwrite subjects could not be resolved safely\./);
        const staff = [...w.channels.values()].find(c => c.name === 'staff-room');
        assert.deepEqual([...staff.permissionOverwrites.cache.keys()].sort(), ['bot-user', 'g'], 'only the private default the restore starts new channels with');
    } finally { w.store.close(); }
});

test('if the check afterwards cannot run, the card says so instead of claiming success', async () => {
    const w = world();
    try {
        backupOfAWholeServer(w);
        w.insert();
        afterTheAttack(w);
        const incident = w.deleted('nuker', { channels: ['lonely'] });
        const real = w.service.plan.bind(w.service);
        let calls = 0;
        // The restore plans twice itself (before it starts and to verify); the fourth look is the card's own check.
        w.service.plan = (async (...args: Parameters<Snapshots['plan']>) => { calls++; if (calls > 3) throw new Error('Discord is down'); return real(...args); }) as any;
        assert.equal(await w.restorer().restoreNow(w.guild, 'nuker', incident), 'incomplete');
        assert.match(w.posted[0].title, /^Partly put back/);
        assert.match(w.posted[0].description, /Vanguard could not check afterwards what is still missing\./);
    } finally { w.store.close(); }
});

test('schedule waits until the deletions have stopped for 10 seconds, then restores once', async () => {
    const w = world();
    try {
        backupOfAWholeServer(w);
        w.insert();
        afterTheAttack(w);
        // The last deletion was 3 seconds ago on the (fake) clock.
        let clock = Date.now();
        const sleeps: number[] = [];
        const incident = w.deleted('nuker', { channels: ['staff', 'lonely'], roles: ['mods'] });
        w.store.run("UPDATE observations SET at=? WHERE guild_id='g'", clock - 3000);
        const settled: string[] = [];
        const outcome = await w.restorer({ now: () => clock, settled: async id => { settled.push(id); }, sleep: async ms => { sleeps.push(ms); clock += ms; } }).schedule(w.guild, 'nuker', incident);
        assert.equal(outcome, 'restored');
        assert.equal(sleeps.reduce((a, b) => a + b, 0), SETTLE_MS - 3000, 'it waited just long enough for the 10 seconds of quiet');
        assert.ok(settled.length >= 1 && settled.every(id => id === 'g'), 'it waits for anti-nuke to finish handling what it has been sent');
        assert.equal(w.calls.filter(c => c.startsWith('channel-create')).length, 2);
    } finally { w.store.close(); }
});

test('the wait for quiet counts role deletions as well as channel deletions', async () => {
    const w = world();
    try {
        backupOfAWholeServer(w);
        w.insert();
        afterTheAttack(w);
        let clock = Date.now();
        const sleeps: number[] = [];
        const incident = w.deleted('nuker', { channels: ['staff', 'lonely'], roles: ['mods'] });
        // The channels went a minute ago; the last role went 4 seconds ago.
        w.store.run("UPDATE observations SET at=? WHERE guild_id='g' AND rule='channel_delete'", clock - 60_000);
        w.store.run("UPDATE observations SET at=? WHERE guild_id='g' AND rule='role_delete'", clock - 4000);
        await w.restorer({ now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; } }).schedule(w.guild, 'nuker', incident);
        assert.equal(sleeps.reduce((a, b) => a + b, 0), SETTLE_MS - 4000);
    } finally { w.store.close(); }
});

test('a deletion that keeps going is restored anyway after two minutes', async () => {
    const w = world();
    try {
        backupOfAWholeServer(w);
        w.insert();
        afterTheAttack(w);
        let clock = Date.now(), n = 0;
        const incident = w.deleted('nuker', { channels: ['staff', 'lonely'], roles: ['mods'] });
        w.store.run("UPDATE observations SET at=? WHERE guild_id='g'", clock);
        const started = clock;
        const outcome = await w.restorer({ now: () => clock, sleep: async ms => {
            clock += ms;
            // The attacker is still deleting something every second.
            w.store.observe(`more-${n++}`, 'g', 'nuker', 'channel_delete', 'lonely', clock);
        } }).schedule(w.guild, 'nuker', incident);
        assert.equal(outcome, 'restored');
        assert.equal(clock - started, MAX_SETTLE_MS);
    } finally { w.store.close(); }
});

test('a second incident for the same person while one is running makes it look again instead of starting another', async () => {
    const w = world();
    try {
        const auto = w.restorer();
        let runs = 0, release!: () => void;
        const hold = new Promise<void>(r => { release = r; });
        auto.restoreNow = (async () => { runs++; if (runs === 1) await hold; return 'restored'; }) as any;
        const first = auto.schedule(w.guild, 'nuker', 1);
        assert.equal(auto.busy('g', 'nuker'), true);
        assert.equal(await auto.schedule(w.guild, 'nuker', 2), undefined, 'the second call returns at once');
        assert.equal(auto.schedule(w.guild, 'someone-else', 3) instanceof Promise, true, 'another person is a separate job');
        release();
        await first;
        assert.equal(runs, 3, 'one pass, one extra look for the repeat, and one for the other person');
        assert.equal(auto.busy('g', 'nuker'), false, 'finished jobs are forgotten');
        auto.restoreNow = (async () => { runs++; return 'restored'; }) as any;
        await auto.schedule(w.guild, 'nuker', 4);
        assert.equal(runs, 4, 'a later incident starts a fresh job');
    } finally { w.store.close(); }
});

test('an error inside a job is logged and never escapes', async () => {
    const w = world();
    try {
        const auto = w.restorer();
        auto.restoreNow = (async () => { throw new Error('boom'); }) as any;
        assert.equal(await auto.schedule(w.guild, 'nuker', 1), 'failed');
        assert.equal(auto.busy('g', 'nuker'), false);
    } finally { w.store.close(); }
});

// ---- the hook in anti-nuke ----

function nuke(options: { mode?: 'enforce' | 'observe'; bot?: boolean } = {}) {
    const store = new Store(':memory:');
    authorize(store);
    const settings = store.settings('g');
    settings.enabled = true; settings.mode = options.mode ?? 'enforce';
    store.save(settings);
    const security = new Security(store, { push: () => undefined } as any);
    security.punish = async () => 'Removed 3 dangerous role(s).';
    const heard: { actor: string; incident: number }[] = [];
    security.onDeletions = ({ actor, incident }) => { heard.push({ actor, incident }); };
    const attacker: any = { id: 'nuker', user: { bot: options.bot ?? true, username: 'nuker' }, roles: { cache: new Collection() } };
    const guild: any = { id: 'g', ownerId: 'owner', client: { user: { id: 'bot' } }, members: { cache: new Collection(), fetch: async () => attacker } };
    const entry = (id: string, action: number, actor = 'nuker', target = id) => ({ id, targetId: target, action, executorId: actor, createdTimestamp: Date.now() }) as any;
    return { store, security, guild, heard, entry };
}

test('anti-nuke tells the restore when it has contained someone who deleted channels, with the deletions on record', async () => {
    const f = nuke();
    try {
        for (let n = 0; n < 3; n++) await f.security.audit(f.entry(`d${n}`, AuditLogEvent.ChannelDelete, 'nuker', `c${n}`), f.guild);
        assert.deepEqual(f.heard, [{ actor: 'nuker', incident: 1 }]);
        assert.deepEqual(incidentRestorePlan(f.store, 'g', 1).deleted, { channels: ['c0', 'c1', 'c2'], roles: [] });
        for (let n = 0; n < 5; n++) await f.security.audit(f.entry(`r${n}`, AuditLogEvent.RoleDelete, 'nuker', `role${n}`), f.guild);
        assert.equal(f.heard.length, 2, 'a role wipe is heard as well');
        assert.deepEqual(incidentRestorePlan(f.store, 'g', 2).deleted.roles, ['role0', 'role1', 'role2', 'role3', 'role4']);
    } finally { f.store.close(); }
});

test('the restore is not told about a first warning, observe mode, an exempt person, or an incident without deletions', async () => {
    const human = nuke({ bot: false });
    try {
        for (let n = 0; n < 3; n++) await human.security.audit(human.entry(`d${n}`, AuditLogEvent.ChannelDelete, 'nuker', `c${n}`), human.guild);
        assert.deepEqual(human.heard, [], 'a person gets a warning first, nothing is contained, so nothing is restored');
        assert.equal(human.store.get("SELECT mode FROM incidents")!.mode, 'warn');
    } finally { human.store.close(); }
    const observing = nuke({ mode: 'observe' });
    try {
        for (let n = 0; n < 3; n++) await observing.security.audit(observing.entry(`d${n}`, AuditLogEvent.ChannelDelete, 'nuker', `c${n}`), observing.guild);
        assert.deepEqual(observing.heard, []);
    } finally { observing.store.close(); }
    const owner = nuke();
    try {
        for (let n = 0; n < 3; n++) await owner.security.audit(owner.entry(`d${n}`, AuditLogEvent.ChannelDelete, 'owner', `c${n}`), owner.guild);
        assert.deepEqual(owner.heard, [], 'the owner is never punished, so nothing is undone behind their back');
    } finally { owner.store.close(); }
    const bans = nuke();
    try {
        for (let n = 0; n < 5; n++) await bans.security.audit(bans.entry(`b${n}`, AuditLogEvent.MemberBanAdd, 'nuker', `u${n}`), bans.guild);
        assert.equal(bans.store.get("SELECT COUNT(*) AS n FROM incidents")!.n >= 1, true);
        assert.deepEqual(bans.heard, [], 'no deletions, nothing to restore');
    } finally { bans.store.close(); }
});

test('a restore that blows up cannot break anti-nuke', async () => {
    const f = nuke();
    try {
        f.security.onDeletions = () => { throw new Error('boom'); };
        for (let n = 0; n < 3; n++) await f.security.audit(f.entry(`d${n}`, AuditLogEvent.ChannelDelete, 'nuker', `c${n}`), f.guild);
        assert.equal(f.store.get("SELECT COUNT(*) AS n FROM incidents WHERE mode='enforce'")!.n, 1, 'the incident is still recorded and contained');
    } finally { f.store.close(); }
});
