import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, Collection, PermissionFlagsBits } from 'discord.js';
import { Store } from '../src/database/db.js';
import { Security } from '../src/security/security.js';
import { authorize } from './helpers.js';

const ACTOR = '222222222222222222';

function fixture() {
    const store = new Store(':memory:'); authorize(store, 'g');
    const settings = store.settings('g'); settings.enabled = true; settings.mode = 'enforce'; store.save(settings);
    const security = new Security(store, { push: () => undefined } as any);
    const member = {
        id: ACTOR,
        user: { bot: false, username: 'actor' },
        roles: { cache: new Collection() },
        send: async () => undefined,
    };
    const guild: any = {
        id: 'g', name: 'Test Guild', ownerId: 'owner', client: { user: { id: 'bot' } },
        roles: { cache: new Collection<string, any>() },
        members: { cache: new Collection([[ACTOR, member]]), fetch: async () => member },
    };
    const calls = { punished: 0, reverted: 0 };
    security.punish = async () => { calls.punished++; return 'Removed 1 dangerous role(s).'; };
    security.revert = async () => { calls.reverted++; return 'Removed the newly granted permissions.'; };
    return { store, security, guild, calls };
}

const roleUpdate = (id: string, permission: bigint) => ({
    id, executorId: ACTOR, targetId: 'role', action: AuditLogEvent.RoleUpdate, createdTimestamp: Date.now(),
    changes: [{ key: 'permissions', old: '0', new: String(permission) }],
}) as any;

const selfAssignment = (permission: bigint) => ({
    id: `self-${permission}`, executorId: ACTOR, targetId: ACTOR, action: AuditLogEvent.MemberRoleUpdate, createdTimestamp: Date.now(),
    changes: [{ key: '$add', new: [{ id: 'privileged' }] }],
    permission,
}) as any;

function addPrivilegedRole(f: ReturnType<typeof fixture>, permission: bigint) {
    f.guild.roles.cache.set('privileged', { id: 'privileged', managed: false, permissions: { bitfield: permission } });
}

test('other dangerous grants revert and warn first, repeat within an hour strips, and an old warning expires', async () => {
    const f = fixture();
    try {
        await f.security.audit(roleUpdate('first', PermissionFlagsBits.BanMembers), f.guild);
        assert.equal(f.calls.punished, 0, 'the first grant does not strip');
        assert.equal(f.calls.reverted, 1, 'the first grant is still reverted');
        assert.equal(f.store.get("SELECT mode FROM incidents WHERE rule='dangerous_grant'")!.mode, 'warn');

        await f.security.audit(roleUpdate('second', PermissionFlagsBits.ManageChannels), f.guild);
        assert.equal(f.calls.punished, 1, 'a repeat inside the warning window strips');
        assert.equal(f.calls.reverted, 2, 'the repeat undoes the new grant without replaying the first undo');
        assert.equal(f.store.get("SELECT mode FROM incidents WHERE rule='dangerous_grant' ORDER BY id DESC LIMIT 1")!.mode, 'enforce');

        const old = Date.now() - 2 * 60 * 60 * 1000;
        f.store.run('UPDATE incidents SET at=?', old);
        f.store.run('UPDATE observations SET at=?', old);
        await f.security.audit(roleUpdate('third', PermissionFlagsBits.ManageWebhooks), f.guild);
        assert.equal(f.calls.punished, 1, 'an incident after the one-hour window gets a fresh warning');
        assert.equal(f.store.get("SELECT mode FROM incidents WHERE rule='dangerous_grant' ORDER BY id DESC LIMIT 1")!.mode, 'warn');
    } finally { f.store.close(); }
});

test('unwhitelisted self-assignment of Administrator or Manage Server strips and reverts immediately', async () => {
    for (const permission of [PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild]) {
        const f = fixture();
        try {
            addPrivilegedRole(f, permission);
            await f.security.audit(selfAssignment(permission), f.guild);
            assert.equal(f.calls.punished, 1, `${permission} must not be downgraded to a warning`);
            assert.equal(f.calls.reverted, 1);
            assert.equal(f.store.get("SELECT mode FROM incidents WHERE rule='dangerous_grant'")!.mode, 'enforce');
        } finally { f.store.close(); }
    }
});

test('only the separate permission-grant whitelist is an exception to self-admin enforcement', async () => {
    // A full bypass never allows handing out Administrator: that is its own whitelist.
    const full = fixture();
    try {
        full.store.grant('g', ACTOR, 'trust', 'owner');
        addPrivilegedRole(full, PermissionFlagsBits.Administrator);
        await full.security.audit(selfAssignment(PermissionFlagsBits.Administrator), full.guild);
        assert.equal(full.calls.punished, 1, 'a full bypass does not cover granting Administrator');
        assert.equal(full.calls.reverted, 1);
        assert.notEqual(full.store.get("SELECT mode FROM incidents WHERE rule='dangerous_grant'")!.mode, 'exempt');
    } finally { full.store.close(); }

    // Neither does a bypass for other rules.
    const other = fixture();
    try {
        other.store.grant('g', ACTOR, 'trust:mass_ban', 'owner');
        addPrivilegedRole(other, PermissionFlagsBits.Administrator);
        await other.security.audit(selfAssignment(PermissionFlagsBits.Administrator), other.guild);
        assert.equal(other.calls.punished, 1);
    } finally { other.store.close(); }

    // The permission-grant whitelist, for a user or for a role they hold, does.
    for (const role of [false, true]) {
        const f = fixture();
        try {
            if (role) {
                f.guild.members.cache.get(ACTOR)!.roles.cache.set('grantrole', { id: 'grantrole' });
                f.store.grant('g', 'grantrole', 'trust_role:dangerous_grant', 'owner');
            } else f.store.grant('g', ACTOR, 'trust:dangerous_grant', 'owner');
            addPrivilegedRole(f, PermissionFlagsBits.Administrator);
            await f.security.audit(selfAssignment(PermissionFlagsBits.Administrator), f.guild);
            assert.equal(f.calls.punished, 0, role ? 'allowed by the role entry' : 'allowed by the user entry');
            assert.equal(f.calls.reverted, 0);
            assert.equal(f.store.get("SELECT mode FROM incidents WHERE rule='dangerous_grant'")!.mode, 'exempt');
        } finally { f.store.close(); }
    }
});
