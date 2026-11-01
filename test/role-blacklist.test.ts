import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, Collection, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { Store } from '../src/database/db.js';
import { authorize } from './helpers.js';
import { Guard } from '../src/bot/guard.js';
import { defaults } from '../src/bot/registry.js';
import { config } from '../src/config.js';
import { RANKS, rankOf } from '../src/bot/ranks.js';
import { decideRoleChange } from '../src/security/role-policy.js';
import { addAssigner, addBlacklisted, assignersOf, blacklistAll, blacklistHolders, isBlacklisted } from '../src/security/role-blacklist.js';
import { enforceRoleBlacklist } from '../src/security/role-blacklist-enforce.js';
import roleCommand from '../src/commands/moderation/role.js';

const G = '123456789012345678', OWNER = '111111111111111111', DEV = '222222222222222222', ADMIN = '333333333333333333', MOD = '555555555555555555', TARGET = '777777777777777777', ROLE = '900000000000000099';

function fixture() {
    const store = new Store(':memory:');
    authorize(store, G);
    return store;
}

const fakeRole = (id = ROLE) => ({
    id, name: 'High Council', position: 40, hoist: false, mentionable: false, color: 0, managed: false,
    permissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
    comparePositionTo: () => 1, editable: true,
});

const actor = (id: string, roles: string[] = [], perms = 0n) => ({
    id, guild: { id: G, ownerId: OWNER }, permissions: new PermissionsBitField(perms),
    roles: { cache: new Collection(roles.map(r => [r, { id: r }])), highest: { comparePositionTo: () => 10 } },
}) as any;

// ------------------------------------------------------------ who may manage the list

test('only the Server Owner and Developers can manage the role blacklist', () => {
    const store = fixture();
    try {
        const guard = new Guard(store);
        const policy = { ...defaults, access: 'member' as const, requiredPermissions: [PermissionFlagsBits.ManageRoles] };
        const can = (id: string, member: any) => guard.allowed(policy, G, id, member, 'role', `role/blacklist/${'add'}`);
        assert.equal(can(ADMIN, actor(ADMIN, [], PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageRoles)), false, 'Administrator is not enough');
        assert.equal(rankOf(store, G, ADMIN, actor(ADMIN, [], PermissionFlagsBits.Administrator)), RANKS.headadmin);
        assert.equal(can(OWNER, actor(OWNER)), true, 'the server owner may');
        config.developers.add(DEV);
        try { assert.equal(can(DEV, actor(DEV)), true, 'Developers may'); } finally { config.developers.delete(DEV); }
    } finally { store.close(); }
});

test('a blacklisted role can only be given by the people listed for it, with no rank or Developer bypass', () => {
    const store = fixture();
    try {
        const role: any = fakeRole();
        addBlacklisted(store, G, role, OWNER);
        const guild: any = { id: G, ownerId: OWNER };
        const target: any = { id: TARGET, roles: { cache: new Collection(), highest: { comparePositionTo: () => 0 } } };
        const me: any = actor('bot', [], PermissionFlagsBits.ManageRoles);
        const call = (who: any) => decideRoleChange({ store, guild, actor: who, target, role, me, op: 'add' });

        const plain = call(actor(ADMIN, [], PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageRoles));
        assert.equal(plain.ok, false); assert.equal((plain as any).kind, 'blacklist');
        assert.match((plain as any).reason, /blacklisted in this server/);

        config.developers.add(DEV);
        try { assert.equal(call(actor(DEV)).ok, false, 'a Developer is not implicitly on the list'); } finally { config.developers.delete(DEV); }
        assert.equal(call(actor(OWNER)).ok, false, 'nor is the server owner');

        // Listed people and roles may give it.
        addAssigner(store, G, ROLE, 'user', OWNER, OWNER);
        store.run("INSERT INTO role_rules(guild_id,role_id,kind,grantor_type,grantor_id,by_id,at) VALUES(?,?,'grant','user',?,?,0)", G, ROLE, MOD, OWNER);
        assert.equal(call(actor(OWNER)).ok, true);
        addAssigner(store, G, ROLE, 'role', 'r-council', OWNER);
        assert.equal(call(actor(MOD, ['r-council'], PermissionFlagsBits.ManageRoles)).ok, true, 'a listed role works for everyone who holds it');
        // Taking it away is never blocked by the blacklist.
        assert.equal(decideRoleChange({ store, guild, actor: actor(MOD, ['r-council'], PermissionFlagsBits.ManageRoles), target, role, me, op: 'remove' }).ok, true);
    } finally { store.close(); }
});

// ------------------------------------------------------------ the command

function commandOptions(group: string, sub: string, extra: Record<string, any> = {}) {
    return {
        getSubcommandGroup: () => group, getSubcommand: () => sub,
        getRole: () => extra.role ?? null, getMentionable: () => extra.who ?? null, getBoolean: () => extra.remove ?? null,
    };
}

async function run(store: Store, userId: string, options: any, guildExtra: Record<string, any> = {}) {
    const guild: any = { id: G, ownerId: OWNER, name: 'Test', roles: { cache: new Collection(), create: async () => ({ id: 'new-role', setPosition: async () => {} }), fetch: async () => null }, ...guildExtra };
    return roleCommand.execute({ store, logs: { push: () => {} }, actor: actor(userId) } as any, { guildId: G, guild, user: { id: userId }, options } as any) as Promise<string>;
}

test('/role blacklist add and who-can-give write the list, and list shows it', async () => {
    const store = fixture();
    try {
        const role: any = fakeRole();
        role.members = new Collection();
        const added = await run(store, OWNER, commandOptions('blacklist', 'add', { role }));
        assert.match(added, /is blacklisted/);
        assert.equal(isBlacklisted(store, G, ROLE), true);
        assert.match(await run(store, OWNER, commandOptions('blacklist', 'list')), /nobody\*\* \(nobody can give it\)/);
        assert.match(await run(store, OWNER, commandOptions('blacklist', 'who-can-give', { role, who: { id: MOD, user: { id: MOD } } })), /can now give/);
        assert.deepEqual(assignersOf(store, G, ROLE).map(a => [a.grantor_type, a.grantor_id]), [['user', MOD]]);
        assert.match(await run(store, OWNER, commandOptions('blacklist', 'list')), new RegExp(`<@${MOD}>`));
        assert.match(await run(store, OWNER, commandOptions('blacklist', 'who-can-give', { role, who: { id: MOD, user: { id: MOD } }, remove: true })), /no longer/);
        assert.equal(assignersOf(store, G, ROLE).length, 0);
        assert.match(await run(store, OWNER, commandOptions('blacklist', 'remove', { role })), /no longer blacklisted/);
        assert.equal(blacklistAll(store, G).length, 0);
        // A Head Admin never reaches the handler.
        store.grant(G, ADMIN, 'admin', OWNER);
        await assert.rejects(run(store, ADMIN, commandOptions('blacklist', 'list')), /server owner or a Developer/);
    } finally { store.close(); }
});

// ------------------------------------------------------------ enforcement from Discord

function enforcementFixture(store: Store) {
    const dms: any[] = [], removed: string[] = [], given: string[] = [];
    const role = fakeRole();
    const targetMember: any = {
        id: TARGET,
        roles: {
            cache: new Collection([[ROLE, role]]),
            remove: async (ids: string[]) => { removed.push(...ids); },
            add: async (id: string) => { given.push(id); },
        },
    };
    const actorMember: any = { id: TARGET, roles: { cache: new Collection() } };
    const guild: any = {
        id: G, name: 'Test', ownerId: OWNER,
        client: { user: { id: 'bot' }, users: { fetch: async () => ({ send: async (message: any) => dms.push(message) }) } },
        roles: {
            cache: new Collection([[ROLE, role]]),
            create: async () => ({ id: 'new-role', setPosition: async () => {} }),
            fetch: async () => role,
        },
        members: {
            me: { roles: { highest: { comparePositionTo: () => 10 } } },
            fetch: async ({ user }: any) => (user === TARGET ? targetMember : actorMember),
        },
    };
    return { guild, dms, removed, given };
}

test('a blacklisted role given straight in Discord is taken back off and the person is DMed', async () => {
    const store = fixture();
    try {
        addBlacklisted(store, G, fakeRole(), OWNER);
        const f = enforcementFixture(store);
        const entry: any = { action: AuditLogEvent.MemberRoleUpdate, id: 'e1', executorId: ADMIN, targetId: TARGET, createdTimestamp: Date.now(), changes: [{ key: '$add', new: [{ id: ROLE }] }] };
        await enforceRoleBlacklist(store, { push: () => {} } as any, entry, f.guild);
        assert.deepEqual(f.removed, [ROLE], 'the role was removed');
        assert.equal(f.dms.length, 1, 'the person who tried is DMed');
        assert.equal(blacklistHolders(store, G, ROLE).includes(TARGET), true, 'holders are recorded for a later restore');

        // With the person listed, the same change is left alone.
        addAssigner(store, G, ROLE, 'user', ADMIN, OWNER);
        f.removed.length = 0;
        await enforceRoleBlacklist(store, { push: () => {} } as any, entry, f.guild);
        assert.deepEqual(f.removed, [], 'listed people are not interrupted');
    } finally { store.close(); }
});

test('deleting a blacklisted role puts it back unless the owner, a Developer or a listed person did it', async () => {
    const store = fixture();
    try {
        addBlacklisted(store, G, fakeRole(), OWNER);
        addNewHolder(store);
        const f = enforcementFixture(store);
        const deleteEntry: any = { action: AuditLogEvent.RoleDelete, id: 'd1', executorId: ADMIN, targetId: ROLE, createdTimestamp: Date.now(), changes: [] };
        await enforceRoleBlacklist(store, { push: () => {} } as any, deleteEntry, f.guild);
        assert.equal(isBlacklisted(store, G, 'new-role'), true, 'the blacklist follows the recreated role');
        assert.equal(isBlacklisted(store, G, ROLE), false, 'the old id is gone');
        assert.deepEqual(f.given, ['new-role'], 'holders get it back');
        assert.equal(f.dms.length, 1, 'and the person who deleted it is told');

        // The owner may delete it for good.
        const ownerDelete: any = { ...deleteEntry, id: 'd2', executorId: OWNER, targetId: 'new-role' };
        await enforceRoleBlacklist(store, { push: () => {} } as any, ownerDelete, f.guild);
        assert.equal(blacklistAll(store, G).length, 0, 'no entry left behind');
    } finally { store.close(); }
});

function addNewHolder(store: Store) {
    store.run('INSERT OR IGNORE INTO role_blacklist_holders(guild_id,role_id,user_id) VALUES(?,?,?)', G, ROLE, TARGET);
}
