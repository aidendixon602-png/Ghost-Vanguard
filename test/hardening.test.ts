import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, Collection, PermissionsBitField } from 'discord.js';
import { Store } from '../src/database/db.js';
import { config } from '../src/config.js';
import { authorize } from './helpers.js';
import { Guard } from '../src/bot/guard.js';
import { Registry } from '../src/bot/registry.js';
import { assertNotProtectedUser, checkTarget } from '../src/ui/ui.js';
import { enforceProtectedUsers } from '../src/security/protected-users.js';
import { globalAlertTarget, setGlobalAlertTarget } from '../src/security/global-alert.js';
import { assertTargetable } from '../src/security/network-ban.js';

const VIP = '111111111111111111', MOD = '222222222222222222', DEV = '333333333333333333', BOT = '999999999999999999', OWNER = '444444444444444444';
function withEnv(vars: Record<string, string>, fn: () => any) {
    const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
    Object.assign(process.env, vars);
    const done = () => { for (const [k, v] of Object.entries(saved)) process.env[k] = v ?? ''; };
    try { const r = fn(); if (r instanceof Promise) return r.finally(done); done(); return r; } catch (e) { done(); throw e; }
}

test('PROTECTED_USERS: staff cannot target them through Vanguard; Developers can', () => withEnv({ PROTECTED_USERS: VIP }, () => {
    config.developers.add(DEV);
    try {
        assert.throws(() => assertNotProtectedUser(VIP, MOD), /protected user/);
        assert.doesNotThrow(() => assertNotProtectedUser(VIP, DEV));
        assert.doesNotThrow(() => assertNotProtectedUser(MOD, MOD), 'everyone else as before');
        const m = (id: string, pos: number) => ({ id, guild: { ownerId: OWNER }, roles: { highest: { comparePositionTo: (o: any) => pos - o.pos, pos } } }) as any;
        assert.throws(() => checkTarget(m(MOD, 10), m(VIP, 1), m(BOT, 100)), /protected user/, 'even when the moderator outranks them');
        assert.throws(() => assertTargetable({ user: { id: BOT } } as any, VIP, MOD), /protected user/, 'no network bans either');
    } finally { config.developers.delete(DEV); }
}));

function world(action: AuditLogEvent, actor: string, changes: any[] = [], reason: string | null = null) {
    const store = new Store(':memory:'); const logged: any[] = []; const did: string[] = [];
    const member: any = { roles: { cache: new Map(), add: async (ids: string[]) => { did.push(`roles+${ids.join(',')}`); } }, timeout: async (v: any) => { did.push(`timeout:${v}`); } };
    const guild: any = { id: 'g', name: 'Midtown', client: { user: { id: BOT } }, roles: { cache: new Map([['r1', { editable: true }]]) },
        bans: { remove: async (id: string) => { did.push(`unban:${id}`); } }, members: { fetch: async () => member } };
    const entry: any = { action, executorId: actor, targetId: VIP, reason, changes };
    return { store, logs: { push: (_g: string, e: any) => logged.push(e.toJSON()) } as any, logged, guild, entry, did };
}

test('PROTECTED_USERS: a ban, timeout or role removal done by hand is undone and alerted; kicks are alerted', async () => withEnv({ PROTECTED_USERS: VIP }, async () => {
    config.developers.add(DEV);
    try {
        let w = world(AuditLogEvent.MemberBanAdd, MOD);
        assert.match(String(await enforceProtectedUsers(w.store, w.logs, w.entry, w.guild)), /unbanned/);
        assert.deepEqual(w.did, [`unban:${VIP}`]); assert.match(JSON.stringify(w.logged), /Protected user/);
        w = world(AuditLogEvent.MemberUpdate, MOD, [{ key: 'communication_disabled_until', new: new Date(Date.now() + 60000).toISOString() }]);
        await enforceProtectedUsers(w.store, w.logs, w.entry, w.guild); assert.deepEqual(w.did, ['timeout:null']);
        w = world(AuditLogEvent.MemberRoleUpdate, MOD, [{ key: '$remove', new: [{ id: 'r1', name: 'High Command' }] }]);
        await enforceProtectedUsers(w.store, w.logs, w.entry, w.guild); assert.deepEqual(w.did, ['roles+r1']);
        w = world(AuditLogEvent.MemberKick, MOD);
        assert.match(String(await enforceProtectedUsers(w.store, w.logs, w.entry, w.guild)), /cannot undo a kick/);
        w = world(AuditLogEvent.MemberBanAdd, BOT, [], `${MOD}: /mod ban`);
        await enforceProtectedUsers(w.store, w.logs, w.entry, w.guild); assert.deepEqual(w.did, [`unban:${VIP}`], 'through Vanguard for a staff member counts as them');
        for (const actor of [DEV, BOT]) {
            w = world(AuditLogEvent.MemberBanAdd, actor);
            assert.equal(await enforceProtectedUsers(w.store, w.logs, w.entry, w.guild), null, `${actor}: Developers and Vanguard's own anti-nuke are allowed`);
            assert.deepEqual(w.did, []);
        }
    } finally { config.developers.delete(DEV); }
}));

test('ANTINUKE_LOCK: only Developers can turn anti-nuke off or change its layers; without the lock owners still can', async () => {
    const store = new Store(':memory:'); authorize(store, 'g');
    const registry = new Registry();
    await registry.load(new URL('../src/commands', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    const guard = new Guard(store);
    const def = (name: string) => [...registry.commands.values()].find(d => (d.data as any).name === name)!;
    const can = (id: string, name: string, sub: string, perms = 0n) => {
        const d = def(name);
        const m = { id, guild: { id: 'g', ownerId: OWNER }, roles: { cache: new Collection() }, permissions: new PermissionsBitField(perms) };
        return guard.allowed({ ...d.metadata, ...d.subcommands?.[sub] } as any, 'g', id, m as any, name, `${name}/${sub}`);
    };
    config.developers.add(DEV);
    try {
        await withEnv({ ANTINUKE_LOCK: '' }, () => { assert.equal(can(OWNER, 'antinuke', 'disable'), true, 'unlocked: the owner can'); });
        await withEnv({ ANTINUKE_LOCK: 'true' }, () => {
            assert.equal(can(OWNER, 'antinuke', 'disable'), false, 'locked: not even the owner');
            assert.equal(can(OWNER, 'antinuke-plus', 'settings'), false);
            assert.equal(can(DEV, 'antinuke', 'disable'), true, 'Developers can');
            assert.equal(can(OWNER, 'antinuke', 'enable'), true, 'turning it on is never locked');
        });
    } finally { config.developers.delete(DEV); store.close(); }
});

test('GLOBAL_ALERT_CHANNEL_ID: the feed channel is fixed in .env and wins over /dev alerts', () => withEnv({ GLOBAL_ALERT_CHANNEL_ID: '555555555555555555', GLOBAL_ALERT_WARNINGS: 'true' }, () => {
    const store = new Store(':memory:');
    try {
        setGlobalAlertTarget(store, { guildId: 'old', channelId: '666666666666666666', warnings: false, by: 'x', at: 1 });
        const client: any = { channels: { cache: new Map([['555555555555555555', { guildId: 'hq' }]]) } };
        assert.deepEqual(globalAlertTarget(store, client), { guildId: 'hq', channelId: '555555555555555555', warnings: true, by: 'env', at: 0 });
        assert.equal(globalAlertTarget(store, { channels: { cache: new Map() } } as any)?.channelId, '666666666666666666', 'channel not visible: falls back to /dev alerts');
    } finally { store.close(); }
}));
