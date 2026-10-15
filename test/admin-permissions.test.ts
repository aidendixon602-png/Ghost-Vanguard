import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { authorize } from './helpers.js';
import { Store } from '../src/database/db.js';
import { Registry, type Definition } from '../src/bot/registry.js';
import { Guard } from '../src/bot/guard.js';
import { config } from '../src/config.js';
// Explicit test owner; production has no built-in privileged account.
config.ownerId = '1277709272041394187';
import { rankOf, RANKS } from '../src/bot/ranks.js';

/**
 * Who can use what. Discord Administrators manage their own server without a Vanguard
 * role; developer-only, cross-server and protection-weakening actions stay restricted.
 */

const G = '123456789012345678', OWNER = '111111111111111111', DEV = '222222222222222222';

async function setup() {
    const store = new Store(':memory:');
    authorize(store, G);
    const registry = new Registry();
    await registry.load(new URL('../src/commands', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    const guard = new Guard(store);
    const find = (name: string): Definition => [...registry.commands.values()].find(d => (d.data as any).name === name)!;
    /** Can this member use "/command sub"? Uses the same check as a real interaction. */
    const can = (member: any, key: string) => {
        const [name, ...rest] = key.split('/');
        const def = find(name!);
        assert.ok(def, `no such command ${name}`);
        const policy = { ...def.metadata, ...def.subcommands?.[rest.join('/')] };
        return guard.allowed(policy, G, member.id, member, name, key);
    };
    return { store, can };
}

const member = (id: string, perms: bigint, roles: string[] = []) => ({
    id, guild: { id: G, ownerId: OWNER },
    roles: { cache: new Map(roles.map(r => [r, { id: r, name: r }])) },
    permissions: new PermissionsBitField(perms),
});

const ADMIN_CAN = [
    'moderation/ban', 'moderation/unban', 'moderation/kick', 'moderation/timeout', 'moderation/warn', 'moderation/history',
    'case/view', 'case/search', 'case/recent', 'case/reason', 'warnings/status',
    'security/status', 'security/incidents', 'guild-config/feature', 'guild-config/command', 'guild-config/provider',
    'logs/status', 'logs/enable', 'logs/category',
    'backup/create', 'backup/list', 'snapshot/create', 'snapshot/list', 'config-history/list',
    'health', 'automod/spam', 'welcome/setup', 'raidmode/on', 'lockdown', 'perm/list', 'staff/report',
];
const ADMIN_CANNOT = [
    // developer-only and cross-server
    'dev/diagnostics', 'autoreact/add', 'autoreact/remove', 'autoreact/list', 'genreban', 'ungenreban', 'hardban', 'unhardban', 'banserver', 'authserver', 'copylayout', 'staff/global', 'roblox/partner', 'roblox/network',
    // destructive restoration and deleting recovery points or records
    'backup/restore', 'snapshot/restore', 'config-history/restore', 'backup/delete', 'snapshot/delete', 'snapshot/cleanup', 'case/delete',
    // Anti-nuke access is owner/developer only, including read-only anti-nuke commands.
    'antinuke/status', 'antinuke/enable', 'antinuke/rules', 'antinuke/check', 'trust/list', 'antinuke-plus/scan', 'security/config', 'security/quarantine', 'logs/setup',
    // switching protection off or exempting people
    'antinuke/disable', 'disable', 'antinuke-plus/settings', 'trust/add', 'trust/remove', 'trust/bots', 'security/release', 'emergency/start', 'emergency/stop',
    // granting permissions
    'security/admin', 'staff/role', 'guild-config/permission-role',
];

test('a Discord Administrator manages their own server with no Vanguard role', async () => {
    const { store, can } = await setup();
    const admin = member('333333333333333333', PermissionFlagsBits.Administrator);
    for (const key of ADMIN_CAN) assert.equal(can(admin, key), true, `Administrator should be able to use /${key}`);
    store.close();
});

test('Administrator alone never unlocks developer, cross-server, destructive or protection-weakening commands', async () => {
    const { store, can } = await setup();
    const admin = member('333333333333333333', PermissionFlagsBits.Administrator);
    for (const key of ADMIN_CANNOT) assert.equal(can(admin, key), false, `Administrator must NOT be able to use /${key}`);
    store.close();
});

test('the server owner can do the restricted server actions, but nothing developer-only', async () => {
    const { store, can } = await setup();
    const owner = member(OWNER, PermissionFlagsBits.Administrator);
    for (const key of ['backup/restore', 'snapshot/restore', 'antinuke/disable', 'trust/add', 'staff/role', 'guild-config/permission-role', 'case/delete'])
        assert.equal(can(owner, key), true, `owner should be able to use /${key}`);
    for (const key of ['dev/diagnostics', 'genreban', 'hardban', 'banserver', 'staff/global'])
        assert.equal(can(owner, key), false, `owner must NOT be able to use /${key}`);
    store.close();
});

test('an explicit security-admin grant still unlocks restricted server actions', async () => {
    const { store, can } = await setup();
    const head = member('444444444444444444', 0n);
    store.grant(G, head.id, 'admin', OWNER);
    assert.equal(can(head, 'backup/restore'), true);
    assert.equal(can(head, 'antinuke/disable'), false, 'security-admin grants cannot delegate anti-nuke');
    assert.equal(can(head, 'genreban'), false);
    store.close();
});

test('regular members get public commands only, and a role NAMED admin grants nothing', async () => {
    const { store, can } = await setup();
    const plain = member('555555555555555555', 0n);
    const fakeAdmin = member('666666666666666666', 0n, ['Admin', 'Administrator']);
    for (const m of [plain, fakeAdmin]) {
        for (const key of ['help', 'ping', 'userinfo', 'server-info']) assert.equal(can(m, key), true, `/${key} is public`);
        for (const key of ['moderation/ban', 'security/config', 'antinuke/status', 'backup/create', 'guild-config/feature', 'genreban'])
            assert.equal(can(m, key), false, `/${key} must be refused`);
    }
    store.close();
});

test('developers keep developer commands; server permissions never grant them', async () => {
    const { store, can } = await setup();
    config.developers.add(DEV);
    try {
        assert.equal(can(member(DEV, 0n), 'genreban'), true);
        assert.equal(can(member(DEV, 0n), 'dev/diagnostics'), true);
        assert.equal(can(member(DEV, 0n), 'autoreact/add'), true);
        assert.equal(can(member('777777777777777777', PermissionFlagsBits.Administrator), 'dev/diagnostics'), false);
        assert.equal(can(member(config.ownerId, 0n), 'staff/global'), true, 'the bot owner (a Developer) keeps bot-wide rank management');
    } finally { config.developers.delete(DEV); }
    store.close();
});

test('rank checks inside buttons ignore Administrator for restricted actions', async () => {
    const { store } = await setup();
    const admin: any = member('333333333333333333', PermissionFlagsBits.Administrator);
    assert.equal(rankOf(store, G, admin.id, admin), RANKS.headadmin, 'Administrator counts as Head Admin for everyday actions');
    assert.equal(rankOf(store, G, admin.id, admin, 'moderation/ban'), RANKS.headadmin);
    assert.equal(rankOf(store, G, admin.id, admin, 'botq'), 0, 'approving a quarantined bot needs explicit rank');
    assert.equal(rankOf(store, G, admin.id, admin, 'emergency'), 0, 'emergency controls need explicit rank');
    assert.equal(rankOf(store, null, admin.id, admin), 0, 'no server, no Administrator rank');
    store.close();
});
