import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent } from 'discord.js';
import { Store } from '../src/database/db.js';
import { config } from '../src/config.js';
import { blockedBy, parseCommandBlacklist } from '../src/bot/env-rules.js';
import { enforceProtectedRoles } from '../src/security/protected-roles.js';

const A = '111111111111111111', B = '222222222222222222', ROLE = '333333333333333333', OTHER = '444444444444444444', ASSIGNER = '555555555555555555', BOT = '999999999999999999';

test('COMMAND_BLACKLIST: per person, whole commands or single subcommands, * for everything; the bot owner is never blocked', () => {
    const parsed = parseCommandBlacklist(`${A}:mod ban|/Genreban ; ${B}=*; junk; ${config.ownerId}:*`);
    assert.deepEqual(parsed.get(A), ['mod ban', 'genreban']);
    const saved = process.env.COMMAND_BLACKLIST;
    process.env.COMMAND_BLACKLIST = `${A}:mod ban|genreban;${B}:*;${config.ownerId}:*`;
    try {
        assert.equal(blockedBy(A, 'mod ban'), 'mod ban');
        assert.equal(blockedBy(A, 'mod bans lookup'), null, '"mod ban" does not block "mod bans"');
        assert.equal(blockedBy(A, 'mod kick'), null);
        assert.equal(blockedBy(A, 'genreban'), 'genreban', 'a standalone command can be blocked');
        assert.equal(blockedBy(A, null), null, 'buttons are only blocked by *');
        assert.equal(blockedBy(B, 'info ping'), '*'); assert.equal(blockedBy(B, null), '*');
        assert.equal(blockedBy(config.ownerId, 'dev restart'), null, 'the bot owner cannot be locked out');
        assert.equal(blockedBy('777777777777777777', 'mod ban'), null);
    } finally { process.env.COMMAND_BLACKLIST = saved ?? ''; }
});

test('legacy blacklist rules still block the renamed Roblox sharing command', () => {
    const saved = process.env.COMMAND_BLACKLIST;
    try {
        process.env.COMMAND_BLACKLIST = `${A}:roblox network;${B}:roblox sharing`;
        assert.equal(blockedBy(A, 'roblox sharing'), 'roblox network');
        assert.equal(blockedBy(B, 'roblox sharing'), 'roblox sharing');
        assert.equal(blockedBy(A, 'roblox partner'), null);
    } finally { process.env.COMMAND_BLACKLIST = saved ?? ''; }
});

function world(actorId: string, reason: string | null = null) {
    const store = new Store(':memory:');
    const logs: any[] = [], removed: string[][] = [];
    const roles = new Map([[ROLE, {}], [OTHER, {}]]);
    const member = { roles: { cache: roles, remove: async (ids: string[]) => { removed.push(ids); for (const id of ids) roles.delete(id); } } };
    const guild: any = { id: 'g', name: 'Midtown', ownerId: 'owner', client: { user: { id: BOT } }, members: { fetch: async () => member } };
    const entry: any = { action: AuditLogEvent.MemberRoleUpdate, executorId: actorId, targetId: 'target', reason, changes: [{ key: '$add', new: [{ id: ROLE, name: 'High Command' }, { id: OTHER, name: 'Cosmetic' }] }] };
    return { store, logs: { push: (_g: string, e: any) => logs.push(e) } as any, logged: logs, guild, entry, removed };
}

test('PROTECTED_ROLES: given by anyone else (by hand, or through Vanguard for a staff member) it is taken back and logged', async () => {
    const saved = [process.env.PROTECTED_ROLES, process.env.PROTECTED_ROLE_ASSIGNERS];
    process.env.PROTECTED_ROLES = ROLE; process.env.PROTECTED_ROLE_ASSIGNERS = ASSIGNER;
    try {
        let w = world(A);
        assert.deepEqual(await enforceProtectedRoles(w.store, w.logs, w.entry, w.guild), [ROLE]);
        assert.deepEqual(w.removed, [[ROLE]], 'only the protected role, not the other one');
        assert.match(JSON.stringify(w.logged[0]), /Protected role blocked/);
        w.store.close();

        w = world(BOT, `${A}: /role add`);
        assert.deepEqual(await enforceProtectedRoles(w.store, w.logs, w.entry, w.guild), [ROLE], 'Vanguard acting for a staff member counts as them');
        w.store.close();

        for (const [who, why] of [[ASSIGNER, 'an assigner'], [BOT, 'Vanguard itself (restores)'], [config.ownerId, 'the bot owner (Developer)']] as const) {
            w = world(who);
            assert.deepEqual(await enforceProtectedRoles(w.store, w.logs, w.entry, w.guild), [], why);
            assert.equal(w.removed.length, 0, why);
            w.store.close();
        }

        process.env.PROTECTED_ROLES = '';
        w = world(A);
        assert.deepEqual(await enforceProtectedRoles(w.store, w.logs, w.entry, w.guild), [], 'nothing protected: nothing happens');
        w.store.close();
    } finally { process.env.PROTECTED_ROLES = saved[0] ?? ''; process.env.PROTECTED_ROLE_ASSIGNERS = saved[1] ?? ''; }
});
