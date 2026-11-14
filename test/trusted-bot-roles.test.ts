import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, Collection, PermissionsBitField } from 'discord.js';
import { Store } from '../src/database/db.js';
import { authorize } from './helpers.js';
import { enforceProtectedRoles } from '../src/security/protected-roles.js';
import { TRUSTED_BOTS } from '../src/bot/trusted-bots.js';

const G = '123456789012345678', D = '345678901234567890', ROLE = '456789012345678901';

test('a trusted bot may change bot permission roles without Vanguard reverting it', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        store.run("INSERT INTO permission_roles(guild_id,role_id,access,by_id) VALUES(?,?,'moderator',?)", G, ROLE, D);
        const trusted = [...TRUSTED_BOTS.keys()][0];
        const cache = new Collection<string, any>([[ROLE, {}]]), calls: string[] = [];
        const member: any = { roles: { cache, remove: async (ids: string[]) => { calls.push('remove'); ids.forEach(id => cache.delete(id)); }, add: async (ids: string[]) => { calls.push('add'); ids.forEach(id => cache.set(id, {})); } } };
        const guild: any = { id: G, ownerId: 'someone-else', client: { user: { id: 'bot' } }, members: { fetch: async () => member } };
        const logs: any = { push: () => {} };
        const entry: any = { action: AuditLogEvent.MemberRoleUpdate, executorId: trusted, targetId: 'target', changes: [{ key: '$remove', new: [{ id: ROLE }] }] };
        assert.deepEqual(await enforceProtectedRoles(store, logs, entry, guild), [], 'trusted bot removal is left alone');
        assert.deepEqual(calls, []);
        cache.delete(ROLE);
        entry.executorId = '234567890123456789';
        assert.deepEqual(await enforceProtectedRoles(store, logs, entry, guild), [ROLE], 'an untrusted actor is still reverted');
        assert.deepEqual(calls, ['add'], 'the removal is undone by re-adding the role');
    } finally { store.close(); }
});
