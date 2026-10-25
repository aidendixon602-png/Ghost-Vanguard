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
        assert.equal(f.calls.reverted, 3, 'the repeat rolls back both grants in its 60-second event window');
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

test('explicit anti-nuke whitelist entries remain an exception to self-admin enforcement', async () => {
    for (const kind of ['trust', 'trust:dangerous_grant']) {
        const f = fixture();
        try {
            f.store.grant('g', ACTOR, kind, 'owner');
            addPrivilegedRole(f, PermissionFlagsBits.Administrator);
            await f.security.audit(selfAssignment(PermissionFlagsBits.Administrator), f.guild);
            assert.equal(f.calls.punished, 0);
            assert.equal(f.calls.reverted, 0);
            assert.equal(f.store.get("SELECT mode FROM incidents WHERE rule='dangerous_grant'")!.mode, 'exempt');
        } finally { f.store.close(); }
    }
});
