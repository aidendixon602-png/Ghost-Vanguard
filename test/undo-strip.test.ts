import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, Collection, PermissionFlagsBits } from 'discord.js';
import { Store } from '../src/database/db.js';
import { Security } from '../src/security/security.js';
import { config } from '../src/config.js';
import { undoPlan } from '../src/ui/incident-ui.js';
import { authorize } from './helpers.js';

const DEV = '1277709272041394187';

function setup() {
    const store = new Store(':memory:'); authorize(store);
    const s = store.settings('g'); s.enabled = true; s.mode = 'enforce'; store.save(s);
    const pushed: { embed: any; rows: any[] }[] = [];
    const security = new Security(store, { push: (_g: string, embed: any, rows: any[] = []) => { pushed.push({ embed, rows }); } } as any);
    return { store, security, pushed };
}

test('a strip that removed roles gets an Undo strip button; other punishments do not', async () => {
    const { store, security, pushed } = setup();
    try {
        const guild: any = { id: 'g', ownerId: 'owner', client: { user: { id: 'vanguard' } }, roles: { cache: new Collection() }, members: { cache: new Collection(), fetch: async () => null } };
        security.punish = async () => 'Removed 2 dangerous role(s). No dangerous guild permissions remain.';
        security.revert = async () => 'Removed the newly granted permissions from role x.';
        await security.audit({ id: 'a', executorId: 'actor', targetId: 'role', action: AuditLogEvent.RoleUpdate, createdTimestamp: Date.now(), changes: [{ key: 'permissions', old: '0', new: String(PermissionFlagsBits.Administrator) }] } as any, guild);
        const ids = pushed.at(-1)!.rows.flatMap((r: any) => r.toJSON().components.map((c: any) => c.custom_id));
        assert.ok(ids.some((id: string) => /^incident:undo:\d+$/.test(id)), 'Undo strip offered');
        security.punish = async () => 'Banned the executor.';
        for (let n = 0; n < 5; n++) await security.audit({ id: 'b' + n, executorId: 'banner', targetId: 't' + n, action: AuditLogEvent.MemberBanAdd, createdTimestamp: Date.now() } as any, guild);
        const banIds = pushed.at(-1)!.rows.flatMap((r: any) => r.toJSON().components.map((c: any) => c.custom_id));
        assert.ok(!banIds.some((id: string) => id.startsWith('incident:undo:')), 'no undo button for a ban');
    } finally { store.close(); }
});

test('only the owner or a developer can undo, only once, and only when roles were removed', () => {
    const { store } = setup();
    config.developers.add(DEV);
    try {
        const add = (result: string, actor = 'actor') => { store.run('INSERT INTO incidents(guild_id,actor_id,rule,at,mode,result) VALUES(?,?,?,?,?,?)', 'g', actor, 'dangerous_grant', Date.now(), 'enforce', result); return Number(store.get('SELECT MAX(id) AS id FROM incidents')!.id); };
        const strip = add('Removed 2 dangerous role(s). No dangerous guild permissions remain. Reverts: 1 completed, 0 failed, 0 skipped.');
        store.run('INSERT INTO backups(guild_id,user_id,roles,at,active) VALUES(?,?,?,?,1)', 'g', 'actor', '["r1","r2"]', Date.now());
        assert.throws(() => undoPlan(store, 'g', strip, 'someadmin', 'owner'), /Only the server owner or a developer/);
        assert.deepEqual(undoPlan(store, 'g', strip, 'owner', 'owner'), { actor: 'actor', rule: 'dangerous_grant', roles: 2 });
        assert.equal(undoPlan(store, 'g', strip, DEV, 'owner').actor, 'actor');
        store.run('UPDATE incidents SET result=result || ? WHERE id=?', ` Undone by ${DEV}.`, strip);
        assert.throws(() => undoPlan(store, 'g', strip, 'owner', 'owner'), /already undone/);
        assert.throws(() => undoPlan(store, 'g', add('Executor is above the bot or cannot be managed; containment unavailable.'), 'owner', 'owner'), /did not remove any roles/);
        assert.throws(() => undoPlan(store, 'g', add('Removed 1 dangerous role(s).', 'gone'), 'owner', 'owner'), /saved roles are gone/);
        assert.throws(() => undoPlan(store, 'g', 9999, 'owner', 'owner'), /no longer exists/);
    } finally { config.developers.delete(DEV); store.close(); }
});

test('undoing gives every saved role back and ends the quarantine so they are not stripped again', async () => {
    const { store, security } = setup();
    try {
        store.run('INSERT INTO backups(guild_id,user_id,roles,at,active) VALUES(?,?,?,?,1)', 'g', 'actor', '["staff","admin"]', Date.now());
        let added: string[] = [];
        const role = (id: string, bits: bigint) => ({ id, managed: false, editable: true, permissions: { bitfield: bits } });
        const guild: any = { id: 'g', roles: { cache: new Collection([['staff', role('staff', 0n)], ['admin', role('admin', PermissionFlagsBits.Administrator)]]), fetch: async () => null },
            members: { fetch: async () => ({ roles: { cache: new Collection(), add: async (ids: string[]) => { added = ids; }, remove: async () => {} } }) } };
        const result = await security.release(guild, 'actor', true);
        assert.deepEqual(added.sort(), ['admin', 'staff'], 'admin roles come back too: the owner confirmed it was a false alarm');
        assert.match(result, /Restored 2 role/);
        assert.equal(store.get('SELECT 1 FROM backups WHERE guild_id=? AND user_id=? AND active=1', 'g', 'actor'), undefined, 'quarantine ended');
    } finally { store.close(); }
});
