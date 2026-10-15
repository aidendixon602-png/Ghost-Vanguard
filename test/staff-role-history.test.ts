import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { Store } from '../src/database/db.js';
import { Registry } from '../src/bot/registry.js';
import { previewHistory, registerHistory } from '../src/ui/config-history.js';
import staff from '../src/commands/configuration/staff.js';
import guildConfig from '../src/commands/configuration/guild-config.js';
import { authorize } from './helpers.js';

function fixture() {
    const store = new Store(':memory:'); authorize(store);
    const actor = { id: 'owner', guild: { id: 'g', ownerId: 'owner' }, roles: { cache: new Collection() } };
    let backups = 0;
    const ctx: any = { store, actor, confirmations: new Map(), logs: { push: () => {} }, assertActive: () => store.assertAuthorized('g'),
        databaseBackups: { create: async () => { backups++; } } };
    const i: any = { guildId: 'g', guild: actor.guild, user: { id: 'owner' }, editReply: async () => {} };
    const registry = new Registry(); registerHistory(registry);
    const rollback = async (id: number) => {
        await previewHistory(ctx, i, id);
        await registry.components[0]!.execute(ctx, { ...i, customId: `history:apply:${[...ctx.confirmations.keys()].at(-1)}` });
    };
    const change = (command: typeof staff, rank: string) => command.execute(ctx, { ...i, options: {
        getSubcommand: () => command === staff ? 'role' : 'permission-role',
        getRole: () => ({ id: 'role', managed: false }), getString: () => rank,
    } });
    const latest = () => store.get('SELECT * FROM configuration_history WHERE guild_id=? ORDER BY id DESC LIMIT 1', 'g')!;
    return { store, ctx, i, change, rollback, latest, backups: () => backups };
}

for (const command of [staff, guildConfig])
for (const existing of ['none', 'staff', 'legacy'] as const)
test(`${command.data.name} role history restores ${existing} access and supports undoing the rollback`, async () => {
    const f = fixture();
    try {
        if (existing === 'staff') f.store.run("INSERT INTO staff_roles VALUES('g','role','helper','previous',123)");
        if (existing === 'legacy') f.store.run("INSERT INTO permission_roles VALUES('g','role','admin','previous')");
        const beforeStaff = f.store.get("SELECT * FROM staff_roles WHERE guild_id='g' AND role_id='role'") ?? null;
        const beforeLegacy = f.store.get("SELECT * FROM permission_roles WHERE guild_id='g' AND role_id='role'") ?? null;
        await f.change(command, 'moderator');
        const entry = f.latest();
        assert.equal(entry.component, 'staff-role:role');
        assert.equal(JSON.parse(entry.after_json).role_id, 'role');
        assert.equal(f.store.get("SELECT * FROM permission_roles WHERE guild_id='g' AND role_id='role'"), undefined, 'replacement removes older access');
        await f.rollback(entry.id);
        assert.deepEqual(f.store.get("SELECT * FROM staff_roles WHERE guild_id='g' AND role_id='role'") ?? null, beforeStaff);
        assert.deepEqual(f.store.get("SELECT * FROM permission_roles WHERE guild_id='g' AND role_id='role'") ?? null, beforeLegacy);
        await f.rollback(f.latest().id);
        assert.equal(f.store.get("SELECT level FROM staff_roles WHERE guild_id='g' AND role_id='role'")?.level, 'moderator');
        assert.equal(f.backups(), 2);
    } finally { f.store.close(); }
});

for (const command of [staff, guildConfig])
test(`${command.data.name} role removal is restorable`, async () => {
    const f = fixture();
    try {
        f.store.run("INSERT INTO staff_roles VALUES('g','role','admin','previous',123)");
        await f.change(command, command === staff ? 'none' : 'remove');
        assert.equal(f.store.get("SELECT 1 FROM staff_roles WHERE guild_id='g' AND role_id='role'"), undefined);
        await f.rollback(f.latest().id);
        assert.equal(f.store.get("SELECT level FROM staff_roles WHERE guild_id='g' AND role_id='role'")?.level, 'admin');
    } finally { f.store.close(); }
});

test('staff-role rollback rechecks hierarchy after the backup and preserves access on backup failure', async () => {
    const f = fixture();
    try {
        await f.change(staff, 'admin');
        const entry = f.latest();
        f.ctx.databaseBackups.create = async () => { throw Error('backup failed'); };
        await assert.rejects(f.rollback(entry.id), /backup failed/);
        assert.equal(f.store.get("SELECT level FROM staff_roles WHERE guild_id='g' AND role_id='role'")?.level, 'admin');
        f.ctx.databaseBackups.create = async () => {
            f.ctx.actor.guild.ownerId = 'new-owner';
            f.store.run("INSERT INTO staff_roles VALUES('g','actor','admin','previous',123)");
            f.ctx.actor.roles.cache.set('actor', {});
        };
        await assert.rejects(f.rollback(entry.id), /above Admin/);
        assert.equal(f.store.get("SELECT level FROM staff_roles WHERE guild_id='g' AND role_id='role'")?.level, 'admin');
    } finally { f.store.close(); }
});

test('incomplete older role history and cross-guild snapshots cannot change access', async () => {
    const f = fixture();
    try {
        for (const component of ['permission-role', 'staff/role']) {
            f.store.history('g', component, { level: 'helper' }, { level: 'admin' }, 'owner');
            await assert.rejects(previewHistory(f.ctx, f.i, f.latest().id), /older staff-role history/);
        }
        f.store.history('g', 'staff-role:role', { guild_id: 'other', role_id: 'role', staff: null, legacy: null }, null, 'owner');
        await assert.rejects(f.rollback(f.latest().id), /identity|Guild mismatch/);
        assert.equal(f.backups(), 0);
    } finally { f.store.close(); }
});
