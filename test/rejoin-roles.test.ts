import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { authorize } from './helpers.js';
import { Store } from '../src/database/db.js';
import { KEEP_MS, onRejoin, restoreRoles, restoreSummary, saveLeftRoles, savedRoles } from '../src/features/rejoin-roles.js';
import { pendingApprovals } from '../src/security/role-authorizations.js';

const G = '123456789012345678', OWNER = '111111111111111111', BOT = '999999999999999999', MANAGER = '444444444444444444', USER = '777777777777777777';
const role = (id: string, position: number, perms = 0n, extra: any = {}) => ({
    id, name: `role-${id.slice(-3)}`, position, managed: false, permissions: new PermissionsBitField(perms),
    comparePositionTo(other: any) { return this.position - other.position; }, ...extra,
});
const R = {
    everyone: role(G, 0), bot: role('900000000000000001', 100), manager: role('900000000000000003', 60, PermissionFlagsBits.ManageRoles),
    member: role('900000000000000010', 10), level: role('900000000000000011', 12), staff: role('900000000000000012', 40, PermissionFlagsBits.BanMembers),
    integration: role('900000000000000013', 15, 0n, { managed: true }), deleted: role('900000000000000014', 5),
};
const member = (id: string, roles: any[], perms = 0n, extra: any = {}) => {
    const cache = new Collection<string, any>(roles.map(r => [r.id, r]));
    return { id, user: { tag: `u${id.slice(-3)}`, bot: false, displayAvatarURL: () => '' }, guild: { id: G }, permissions: new PermissionsBitField(perms),
        roles: { cache, highest: roles.reduce((a, b) => (b.position > a.position ? b : a), R.everyone), add: async (ids: string[]) => { added.push(...ids); } }, ...extra } as any;
};
let added: string[] = [];

function world(store: Store) {
    const live = new Collection<string, any>([R.everyone, R.bot, R.manager, R.member, R.level, R.staff, R.integration].map(r => [r.id, r]));
    const people = new Map<string, any>([[OWNER, member(OWNER, [])], [MANAGER, member(MANAGER, [R.manager], PermissionFlagsBits.ManageRoles)], [BOT, member(BOT, [R.bot])], [USER, member(USER, [])]]);
    const guild: any = { id: G, ownerId: OWNER, roles: { cache: live, fetch: async (id: string) => live.get(id) ?? null },
        members: { fetch: async ({ user }: any) => { const m = people.get(user); if (!m) throw new Error('Unknown Member'); return m; }, fetchMe: async () => people.get(BOT) } };
    return { guild, people, store };
}

test('roles are saved on leave (not bots, not integration roles, not @everyone) and kept for 90 days', () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const leaving = member(USER, [R.everyone, R.member, R.staff, R.integration]); leaving.guild = { id: G };
        saveLeftRoles(store, leaving);
        assert.deepEqual(savedRoles(store, G, USER)!.roles, [R.member.id, R.staff.id]);
        const bot = member('888888888888888888', [R.member]); bot.user.bot = true; bot.guild = { id: G };
        saveLeftRoles(store, bot);
        assert.equal(savedRoles(store, G, '888888888888888888'), null);
        assert.equal(savedRoles(store, G, USER, Date.now() + KEEP_MS + 1000), null, 'forgotten after 90 days');
    } finally { store.close(); }
});

test('rejoin posts a card with a Restore roles button', () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild } = world(store);
        saveLeftRoles(store, Object.assign(member(USER, [R.member, R.level]), { guild: { id: G } }));
        const posts: any[] = [];
        onRejoin(store, { push: (_g: string, e: any, rows: any[]) => posts.push({ e: e.toJSON(), rows }) } as any, Object.assign(member(USER, []), { guild }));
        assert.equal(posts.length, 1);
        assert.equal(posts[0].e.title, 'Member Rejoined');
        assert.match(posts[0].e.description, /had \*\*2\*\* role/);
        assert.equal(posts[0].rows[0].toJSON().components[0].custom_id, `rejoin:restore:${USER}`);
    } finally { store.close(); }
});

test('Restore roles gives back only what the presser may give; the owner can finish the rest', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild, people } = world(store);
        saveLeftRoles(store, Object.assign(member(USER, [R.member, R.level, R.staff, R.deleted]), { guild: { id: G } }));
        added = [];
        const first = await restoreRoles(store, guild, MANAGER, USER);
        assert.deepEqual(added.sort(), [R.member.id, R.level.id].sort(), 'a Manage Roles admin restores ordinary roles');
        assert.ok(first.skipped.some(s => s.id === R.staff.id), 'the Ban Members staff role is protected');
        assert.ok(first.skipped.some(s => s.id === R.deleted.id && s.reason === 'the role was deleted'));
        assert.equal(pendingApprovals() >= 2, true, 'anti-nuke was told these additions are approved');
        assert.match(restoreSummary(USER, first), /Gave <@777777777777777777> back \*\*2\*\* role/);
        assert.ok(savedRoles(store, G, USER), 'kept, because a protected role is still missing');

        people.get(USER)!.roles.cache.set(R.member.id, R.member); people.get(USER)!.roles.cache.set(R.level.id, R.level);
        added = [];
        const owner = await restoreRoles(store, guild, OWNER, USER);
        assert.deepEqual(added, [R.staff.id], 'the owner gives back the staff role');
        assert.equal(owner.already, 2);
        assert.equal(savedRoles(store, G, USER), null, 'done: record cleared');
        await assert.rejects(restoreRoles(store, guild, OWNER, USER), /No saved roles/);
    } finally { store.close(); }
});

test('someone without role permissions cannot restore anything', async () => {
    const store = new Store(':memory:'); authorize(store, G);
    try {
        const { guild, people } = world(store);
        people.set('555555555555555555', member('555555555555555555', []));
        saveLeftRoles(store, Object.assign(member(USER, [R.member]), { guild: { id: G } }));
        added = [];
        await assert.rejects(restoreRoles(store, guild, '555555555555555555', USER), /Nothing could be restored/);
        assert.deepEqual(added, []);
    } finally { store.close(); }
});
