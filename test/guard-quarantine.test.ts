import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import { Store } from '../src/database/db.js';
import { Guard } from '../src/bot/guard.js';
import { defaults } from '../src/bot/registry.js';
import { authorize } from './helpers.js';

test('active quarantine blocks Vanguard command access even when staff privileges remain', async () => {
    const store = new Store(':memory:'); authorize(store, 'g'); store.save(store.settings('g'));
    const actor: any = { id: 'staff', roles: { cache: new Map() }, permissions: new PermissionsBitField(PermissionsBitField.All) };
    const guild: any = { id: 'g', ownerId: 'owner', members: { fetch: async () => actor, me: { permissions: { has: () => true } } } };
    actor.guild = guild;
    const guard = new Guard(store), policy = { ...defaults, category: 'moderation' };
    try {
        store.grant('g', actor.id, 'admin', 'owner');
        assert.equal(guard.allowed(policy, 'g', actor.id, actor, 'moderation/ban'), true);
        store.run('INSERT INTO backups VALUES(?,?,?,?,?)', 'g', actor.id, '[]', 1, 1);
        assert.equal(guard.allowed(policy, 'g', actor.id, actor, 'moderation/ban'), false);
        await assert.rejects(guard.check({ inCachedGuild: () => true, guild, guildId: 'g', user: { id: actor.id }, member: actor } as any, policy, 'moderation/ban', false, true), /quarantined/i);
        assert.equal(guard.allowed({ ...policy, requiresAuthorization: false }, 'g', actor.id, actor, 'help'), true);
        store.run('UPDATE backups SET active=0 WHERE guild_id=? AND user_id=?', 'g', actor.id);
        assert.equal(guard.allowed(policy, 'g', actor.id, actor, 'moderation/ban'), true);
    } finally { store.close(); }
});

test('a stale quarantine record cannot lock the current server owner out', () => {
    const store = new Store(':memory:'); authorize(store, 'g'); store.save(store.settings('g'));
    const actor: any = { id: 'owner', guild: { id: 'g', ownerId: 'owner' }, roles: { cache: new Map() }, permissions: new PermissionsBitField(0n) };
    try {
        store.run('INSERT INTO backups VALUES(?,?,?,?,?)', 'g', actor.id, '[]', 1, 1);
        assert.equal(new Guard(store).allowed(defaults, 'g', actor.id, actor, 'security'), true);
    } finally { store.close(); }
});
