import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, Collection, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { authorize } from './helpers.js';
import { Store } from '../src/database/db.js';
import { Registry, type Definition } from '../src/bot/registry.js';
import { Guard } from '../src/bot/guard.js';
import { config } from '../src/config.js';
import { Security } from '../src/security/security.js';
import { decideRoleChange } from '../src/security/role-policy.js';
import { approveRoleChange, consumeApprovedRoleChange, pendingApprovals } from '../src/security/role-authorizations.js';
import { treeJson, indexTree } from '../src/bot/command-tree.js';
import roleCommand from '../src/commands/moderation/role.js';

/**
 * Permissions for /role and the shared checks: who can do what, protected roles, hierarchy,
 * and that approved /role changes do not set off anti-nuke while everything else still does.
 */

const G = '123456789012345678', OWNER = '111111111111111111', DEV = '222222222222222222', BOT = '999999999999999999';
const ADMIN = '333333333333333333', MANAGER = '444444444444444444', MOD = '555555555555555555', MEMBER = '666666666666666666', TARGET = '777777777777777777';

// ------------------------------------------------------------ fake roles and members

/** Roles by position: higher number = higher in the list. */
const role = (id: string, position: number, perms = 0n, extra: any = {}) => ({
    id, name: `role-${id.slice(0, 3)}`, position, managed: false, permissions: new PermissionsBitField(perms),
    comparePositionTo(other: any) { return this.position - other.position; }, ...extra,
});
const R = {
    everyone: role(G, 0), bot: role('900000000000000001', 100),
    adminRole: role('900000000000000002', 90, PermissionFlagsBits.Administrator), managerRole: role('900000000000000003', 60, PermissionFlagsBits.ManageRoles),
    modRole: role('900000000000000004', 50), helperish: role('900000000000000005', 20), cosmetic: role('900000000000000006', 10),
    banRole: role('900000000000000007', 30, PermissionFlagsBits.BanMembers), integration: role('900000000000000008', 15, 0n, { managed: true }),
    aboveBot: role('900000000000000009', 120),
};
const member = (id: string, roles: any[], perms = 0n) => {
    const cache = new Collection<string, any>(roles.map(r => [r.id, r]));
    return { id, user: { tag: `u${id.slice(0, 3)}`, displayAvatarURL: () => 'a' }, guild: { id: G, ownerId: OWNER },
        permissions: new PermissionsBitField(perms), roles: { cache, highest: roles.reduce((a, b) => (b.position > a.position ? b : a), R.everyone) } } as any;
};
const people = () => ({
    owner: member(OWNER, [R.cosmetic]), dev: member(DEV, []), me: member(BOT, [R.bot]),
    admin: member(ADMIN, [R.adminRole], PermissionFlagsBits.Administrator), manager: member(MANAGER, [R.managerRole], PermissionFlagsBits.ManageRoles),
    mod: member(MOD, [R.modRole]), plain: member(MEMBER, []), target: member(TARGET, [R.cosmetic]),
});

function setup() {
    const store = new Store(':memory:'); authorize(store, G);
    // MOD's role is configured as a Vanguard moderator staff role.
    store.run("INSERT INTO staff_roles(guild_id,role_id,level) VALUES(?,?,'moderator')", G, R.modRole.id);
    const p = people();
    const decide = (actor: any, r: any, op: 'add' | 'remove' = 'add', target: any = p.target) =>
        decideRoleChange({ store, guild: { id: G, ownerId: OWNER }, actor, target, role: r, me: p.me, op });
    return { store, p, decide };
}

// ------------------------------------------------------------ who can change which role

test('Discord can never be asked for @everyone, integration roles or roles above the bot, by anyone', () => {
    const { store, p, decide } = setup();
    config.developers.add(DEV);
    try {
        for (const actor of [p.dev, p.owner, p.admin])
            for (const r of [R.everyone, R.integration, R.aboveBot]) assert.equal(decide(actor, r).ok, false, `${actor.id} ${r.id}`);
    } finally { config.developers.delete(DEV); store.close(); }
});

test('developers manage any eligible role without Administrator; the owner can grant privileged roles directly', () => {
    const { store, p, decide } = setup();
    config.developers.add(DEV);
    try {
        assert.deepEqual(decide(p.dev, R.adminRole), { ok: true, as: 'developer', noop: undefined });
        assert.deepEqual(decide(p.owner, R.adminRole), { ok: true, as: 'owner', noop: undefined }, 'owner, even though the role is above their own highest role');
        assert.equal(decide(p.owner, R.banRole, 'remove').ok, true);
    } finally { config.developers.delete(DEV); store.close(); }
});

test('Administrator / Manage Roles: ordinary roles below them only, never privileged ones without an owner rule', () => {
    const { store, p, decide } = setup();
    try {
        assert.equal(decide(p.manager, R.cosmetic).ok, true);
        const above = decide(p.manager, R.adminRole);
        assert.equal(above.ok, false); assert.match((above as any).reason, /above your highest role/);
        const priv = decide(p.admin, R.banRole);
        assert.equal(priv.ok, false); assert.match((priv as any).reason, /protected role \(it has Ban Members\)/);
        assert.equal(decide(p.admin, R.banRole, 'remove').ok, false, 'protected on removal too');
        // The owner approves a rule for the admin's role: now allowed (still below them).
        store.run("INSERT INTO role_rules(guild_id,role_id,kind,grantor_type,grantor_id,by_id,at) VALUES(?,?,'grant','role',?,?,?)", G, R.banRole.id, R.adminRole.id, OWNER, Date.now());
        assert.equal(decide(p.admin, R.banRole).ok, true);
        assert.equal(decide(p.manager, R.banRole).ok, false, 'the rule names the admin role, not Manage Roles holders');
    } finally { store.close(); }
});

test('a Vanguard staff role counts as protected even with no Discord permissions', () => {
    const { store, p, decide } = setup();
    try {
        store.run("INSERT INTO staff_roles(guild_id,role_id,level) VALUES(?,?,'admin')", G, R.helperish.id);
        const d = decide(p.admin, R.helperish);
        assert.equal(d.ok, false); assert.match((d as any).reason, /Vanguard staff role/);
    } finally { store.close(); }
});

for (const kind of ['trust_role', 'trust_role:mass_ban'])
test(`a ${kind} role needs owner-approved delegation even without Discord permissions`, () => {
    const { store, p, decide } = setup();
    try {
        store.grant(G, R.cosmetic.id, kind, OWNER);
        assert.equal(decide(p.admin, R.cosmetic).ok, false);
        assert.equal(decide(p.admin, R.cosmetic, 'remove').ok, false);
        store.run('UPDATE grants SET expires=1 WHERE guild_id=? AND user_id=? AND kind=?', G, R.cosmetic.id, kind);
        assert.equal(decide(p.admin, R.cosmetic).ok, true, 'expired whitelist entries no longer grant privileges');
    } finally { store.close(); }
});

test('configured moderators: only allow-listed roles, and never privileged ones without a rule', () => {
    const { store, p, decide } = setup();
    try {
        const no = decide(p.mod, R.cosmetic);
        assert.equal(no.ok, false); assert.match((no as any).reason, /allow list/);
        store.run("INSERT INTO role_rules(guild_id,role_id,kind,by_id,at) VALUES(?,?,'allow',?,?)", G, R.helperish.id, OWNER, Date.now());
        assert.deepEqual(decide(p.mod, R.helperish), { ok: true, as: 'moderator', noop: undefined });
        store.run("INSERT INTO role_rules(guild_id,role_id,kind,by_id,at) VALUES(?,?,'allow',?,?)", G, R.banRole.id, OWNER, Date.now());
        assert.equal(decide(p.mod, R.banRole).ok, false, 'allow-listing a privileged role is not enough on its own');
        assert.equal(decide(p.plain, R.cosmetic).ok, false, 'ordinary members cannot use /role at all');
    } finally { store.close(); }
});

test('hierarchy: no changes to members at or above you, to the owner, or giving yourself roles', () => {
    const { store, p, decide } = setup();
    try {
        const higher = member(TARGET, [R.adminRole]);
        assert.match((decide(p.manager, R.cosmetic, 'add', higher) as any).reason, /equal to or above yours/);
        assert.match((decide(p.admin, R.cosmetic, 'add', p.owner) as any).reason, /server owner's roles/);
        const self = member(MANAGER, [R.managerRole, R.cosmetic], PermissionFlagsBits.ManageRoles);
        assert.match((decide(self, R.helperish, 'add', self) as any).reason, /cannot give yourself/);
        assert.equal(decide(self, R.cosmetic, 'remove', self).ok, true, 'taking an ordinary role off yourself is fine');
    } finally { store.close(); }
});

test('"already has it" and "does not have it" are clear no-ops', () => {
    const { store, p, decide } = setup();
    try {
        assert.match((decide(p.manager, R.cosmetic, 'add') as any).noop, /already has/);
        assert.match((decide(p.manager, R.helperish, 'remove') as any).noop, /does not have/);
    } finally { store.close(); }
});

// ------------------------------------------------------------ the command itself

function commandCall(store: Store, p: any, actorId: string, op: 'add' | 'remove', r: any, o: { failWith?: number } = {}) {
    const all: Record<string, any> = { [OWNER]: p.owner, [DEV]: p.dev, [ADMIN]: p.admin, [MANAGER]: p.manager, [MOD]: p.mod, [TARGET]: p.target, [BOT]: p.me };
    const changes: string[] = [];
    p.target.roles.add = async (role: any) => { if (o.failWith) throw { code: o.failWith, message: 'nope' }; changes.push(`add ${role.id}`); };
    p.target.roles.remove = async (role: any) => { changes.push(`remove ${role.id}`); };
    const guild: any = { id: G, ownerId: OWNER, name: 'Test',
        members: { fetch: async ({ user }: any) => { if (!all[user]) throw { code: 10007 }; return all[user]; }, fetchMe: async () => p.me },
        roles: { fetch: async () => r } };
    const pushed: any[] = [];
    const ctx: any = { store, logs: { push: (_g: string, e: any) => pushed.push(e.toJSON()) } };
    const i: any = { guildId: G, guild, user: { id: actorId }, options: { getSubcommand: () => op, getUser: () => ({ id: TARGET }), getRole: () => r } };
    return { run: () => store.withAuthorized(G, () => roleCommand.execute(ctx, i)), changes, pushed };
}

test('/role add: logged only after Discord confirms, with every required detail', async () => {
    const { store, p } = setup();
    try {
        const call = commandCall(store, p, MANAGER, 'add', R.helperish);
        assert.match(String(await call.run()), /Gave <@&900000000000000005> to <@777777777777777777>/);
        assert.deepEqual(call.changes, ['add 900000000000000005']);
        const log = call.pushed[0];
        const f = Object.fromEntries(log.fields.map((x: any) => [x.name, x.value]));
        assert.equal(log.title, 'Role Added');
        assert.match(f.Member, /777777777777777777/); assert.match(f.Role, /900000000000000005/); assert.match(f.By, /444444444444444444/);
        assert.equal(f['Server ID'], `\`${G}\``); assert.equal(f.Result, 'Confirmed by Discord'); assert.ok(log.timestamp);
        assert.equal(pendingApprovals() >= 1, true, 'the approval waits for the matching audit entry');
    } finally { store.close(); }
});

test('/role add: when Discord refuses, nothing is logged and the anti-nuke approval is withdrawn', async () => {
    const { store, p } = setup();
    try {
        const fresh = role('900000000000000010', 25);
        const before = pendingApprovals();
        const call = commandCall(store, p, MANAGER, 'add', fresh, { failWith: 50013 });
        await assert.rejects(call.run(), /Discord refused the change/);
        assert.equal(call.pushed.length, 0);
        assert.equal(pendingApprovals(), before);
    } finally { store.close(); }
});

test('/role refuses a moderator a privileged role and makes no change', async () => {
    const { store, p } = setup();
    try {
        const call = commandCall(store, p, MOD, 'add', R.banRole);
        await assert.rejects(call.run(), /allow list|protected role/);
        assert.deepEqual(call.changes, []);
    } finally { store.close(); }
});

test('/role who-can-give: staff roles are owner only and also let moderator-rank givers use them; ordinary roles open to moderators', async () => {
    const { store } = setup();
    const i = (user: string, opts: { role?: any; who?: any; remove?: boolean }) => ({ guildId: G, guild: { id: G, ownerId: OWNER }, user: { id: user },
        options: { getSubcommand: () => 'who-can-give', getRole: () => opts.role ?? null, get: (n: string) => n === 'who' ? opts.who ?? null : null, getBoolean: () => opts.remove ?? null } }) as any;
    const run = (user: string, opts: any) => store.withAuthorized(G, () => roleCommand.execute({ store } as any, i(user, opts)));
    try {
        store.grant(G, ADMIN, 'admin', OWNER); // a Head Admin-equivalent grant
        await assert.rejects(run(ADMIN, { role: R.banRole, who: { role: R.managerRole } }), /only the server owner can choose who gives it/);
        await assert.rejects(run(OWNER, { role: R.banRole }), /Pick \*\*who\*\* may give it/);
        assert.match(String(await run(OWNER, { role: R.banRole, who: { role: R.managerRole } })), /Anyone with <@&900000000000000003> can now give and take <@&900000000000000007>/);
        assert.equal(store.all("SELECT * FROM role_rules WHERE kind='grant'").length, 1, 'saved per server, so it survives restarts');
        assert.equal(store.all("SELECT * FROM role_rules WHERE kind='allow' AND role_id=?", R.banRole.id).length, 1, 'moderator-rank givers can use it too');
        assert.match(String(await run(ADMIN, { role: R.cosmetic })), /Moderators can now give and take <@&900000000000000006>/);
        const list = String(await run(OWNER, {}));
        assert.match(list, /<@&900000000000000007> → <@&900000000000000003>/);
        assert.match(list, /<@&900000000000000006> → any moderator/);
        assert.match(String(await run(OWNER, { role: R.banRole, who: { role: R.managerRole }, remove: true })), /can \*\*no longer\*\* give/);
        assert.equal(store.all('SELECT * FROM role_rules WHERE role_id=?', R.banRole.id).length, 0, 'last giver removed: moderator access to the staff role goes too');
    } finally { store.close(); }
});

// ------------------------------------------------------------ anti-nuke coordination

function antinuke() {
    const store = new Store(':memory:'); authorize(store, G);
    const s = store.settings(G); s.enabled = true; s.mode = 'observe'; store.save(s);
    const security = new Security(store, { push: () => {} } as any);
    const guild: any = { id: G, ownerId: OWNER, client: { user: { id: BOT } }, roles: { cache: new Collection() }, members: { cache: new Collection() } };
    const roleUpdate = (id: string, op: '$add' | '$remove', roleId: string, reason: string, executor = BOT) =>
        ({ id, action: AuditLogEvent.MemberRoleUpdate, targetId: TARGET, executorId: executor, reason, createdTimestamp: Date.now(), changes: [{ key: op, new: [{ id: roleId }] }] }) as any;
    return { store, security, guild, roleUpdate, incidents: () => store.all('SELECT * FROM incidents').length, counted: () => store.all("SELECT * FROM observations WHERE rule='role_grant'").length };
}

test('an approved /role change does not create an anti-nuke incident; the approval is used once', async () => {
    const { store, security, guild, roleUpdate, incidents, counted } = antinuke();
    try {
        approveRoleChange(G, TARGET, R.helperish.id, 'add');
        await security.audit(roleUpdate('1', '$add', R.helperish.id, `${MANAGER}: /role add helper`), guild);
        assert.equal(incidents(), 0);
        assert.equal(counted(), 0, 'the approved change is not counted toward Role Invite');
        await security.audit(roleUpdate('2', '$add', R.helperish.id, `${MANAGER}: /role add helper`), guild);
        assert.equal(counted(), 1, 'a second identical change without its own approval is checked normally');
    } finally { store.close(); }
});

test('no broad bypass: other roles, other members, the opposite operation and manual changes are still checked', async () => {
    const { store, security, guild, roleUpdate, counted } = antinuke();
    try {
        approveRoleChange(G, TARGET, R.helperish.id, 'add');
        await security.audit(roleUpdate('1', '$add', R.cosmetic.id, `${MANAGER}: /role add other`), guild);
        assert.equal(counted(), 1, 'a different role');
        await security.audit(roleUpdate('2', '$add', R.helperish.id, 'manual', MANAGER), guild);
        assert.equal(counted(), 2, 'a manual change is counted and does not consume the approval');
        assert.equal(consumeApprovedRoleChange(roleUpdate('3', '$add', R.helperish.id, 'x', MANAGER), guild), false, 'only entries made by Vanguard can use an approval');
        assert.equal(consumeApprovedRoleChange(roleUpdate('4', '$remove', R.helperish.id, 'x'), guild), false, 'add approval does not cover remove');
        assert.equal(consumeApprovedRoleChange(roleUpdate('5', '$add', R.helperish.id, 'x'), guild), true, 'the real one still matches');
    } finally { store.close(); }
});

test('approvals expire after 30 seconds', () => {
    const { store, guild, roleUpdate } = antinuke();
    try {
        const now = Date.now();
        approveRoleChange(G, TARGET, '900000000000000077', 'add', now);
        assert.equal(consumeApprovedRoleChange(roleUpdate('1', '$add', '900000000000000077', 'x'), guild, now + 31000), false);
    } finally { store.close(); }
});

// ------------------------------------------------------------ the shared permission checks

async function guardSetup() {
    const store = new Store(':memory:'); authorize(store, G);
    const registry = new Registry();
    await registry.load(new URL('../src/commands', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    const guard = new Guard(store);
    const find = (name: string): Definition => [...registry.commands.values()].find(d => (d.data as any).name === name)!;
    const can = (m: any, key: string) => {
        const [name, ...rest] = key.split('/');
        const def = find(name!);
        return guard.allowed({ ...def.metadata, ...def.subcommands?.[rest.join('/')] }, G, m.id, m, name, key);
    };
    return { store, registry, can };
}
const plainMember = (id: string, perms = 0n) => ({ id, guild: { id: G, ownerId: OWNER }, roles: { cache: new Map() }, permissions: new PermissionsBitField(perms) });

test('developers can use every command without Administrator or any server role', async () => {
    const { store, can } = await guardSetup();
    config.developers.add(DEV);
    try {
        for (const key of ['moderation/ban', 'moderation/unban', 'moderation/purge', 'role/add', 'role/who-can-give', 'backup/restore', 'antinuke/disable', 'trust/add', 'genreban', 'ungenreban', 'hardban', 'dev/diagnostics', 'dev/update', 'database/backup', 'logs/setup'])
            assert.equal(can(plainMember(DEV), key), true, `developer should be able to use /${key}`);
    } finally { config.developers.delete(DEV); store.close(); }
});

test('the risky tools are Developer only: Supreme Leaders, Overseers and server owners cannot use them', async () => {
    const { store, can } = await guardSetup();
    const SUPREME = '888888888888888881';
    config.supremeExtra.add(SUPREME);
    store.run("INSERT INTO bot_staff(user_id,level,by_id,at) VALUES(?,?,?,0)", MEMBER, 'overseer', OWNER);
    store.run("INSERT INTO bot_staff(user_id,level,by_id,at) VALUES(?,?,?,0)", ADMIN, 'supreme', OWNER);
    const risky = ['dev/restart', 'database/restore-settings', 'deauthserver', 'banserver', 'unbanserver', 'staff/global', 'unhardban'];
    try {
        for (const key of risky) {
            assert.equal(can(plainMember(SUPREME), key), false, `Supreme Leader (SUPREME_LEADER_IDS) must not use /${key}`);
            assert.equal(can(plainMember(ADMIN), key), false, `Supreme Leader (/setup staff global) must not use /${key}`);
            assert.equal(can(plainMember(MEMBER), key), false, `Overseer must not use /${key}`);
            assert.equal(can(plainMember(OWNER, PermissionFlagsBits.Administrator), key), false, `server owner must not use /${key}`);
        }
        for (const key of ['genreban', 'ungenreban', 'hardban', 'dev/diagnostics', 'dev/update', 'database/backup'])
            assert.equal(can(plainMember(SUPREME), key), true, `Supreme Leader can still use /${key}`);
        config.developers.add(DEV);
        for (const key of risky) assert.equal(can(plainMember(DEV), key), true, `Developer can use /${key}`);
    } finally { config.developers.delete(DEV); config.supremeExtra.delete(SUPREME); store.close(); }
});

test('the owner cannot use developer-only commands; Administrator cannot use owner-only role rules', async () => {
    const { store, can } = await guardSetup();
    try {
        for (const key of ['genreban', 'hardban', 'dev/diagnostics', 'staff/global', 'banserver', 'autoreact/add'])
            assert.equal(can(plainMember(OWNER, PermissionFlagsBits.Administrator), key), false, `owner must not use /${key}`);
        assert.equal(can(plainMember(OWNER), 'role/who-can-give'), true);
        const admin = plainMember(ADMIN, PermissionFlagsBits.Administrator);
        for (const key of ['role/who-can-give']) assert.equal(can(admin, key), false, `Administrator must not use /${key}`);
        assert.equal(can(admin, 'role/add'), true, 'but can use /role add (the handler then checks role by role)');
    } finally { store.close(); }
});

test('moderation commands need the matching Discord permission or a configured Vanguard rank', async () => {
    const { store, can } = await guardSetup();
    try {
        const cases: [string, bigint][] = [['moderation/ban', PermissionFlagsBits.BanMembers], ['moderation/unban', PermissionFlagsBits.Administrator],
            ['moderation/kick', PermissionFlagsBits.KickMembers], ['moderation/timeout', PermissionFlagsBits.ModerateMembers], ['moderation/untimeout', PermissionFlagsBits.ModerateMembers],
            ['moderation/purge', PermissionFlagsBits.ManageMessages]];
        for (const [key, perm] of cases) {
            assert.equal(can(plainMember(MEMBER), key), false, `${key} without permission`);
            assert.equal(can(plainMember(MEMBER, perm), key), true, `${key} with its permission`);
        }
        assert.equal(can(plainMember(MEMBER, PermissionFlagsBits.KickMembers), 'moderation/ban'), false, 'Kick Members does not unlock ban');
        assert.equal(can(plainMember(MEMBER, PermissionFlagsBits.BanMembers), 'moderation/unban'), false, 'Ban Members alone does not unlock unban: Admins and owners lift bans');
        assert.equal(can(plainMember(OWNER), 'moderation/unban'), true, 'the server owner can unban');
    } finally { store.close(); }
});

test('command visibility is not the security boundary: no command hides itself behind Discord permissions', async () => {
    const { store, registry } = await guardSetup();
    try {
        indexTree(registry);
        const tree = treeJson(registry);
        assert.ok(tree.some(c => c.name === 'role'), '/role is a top-level command');
        for (const c of tree) assert.ok(c.default_member_permissions == null, `/${c.name} is visible to developers without Administrator`);
    } finally { store.close(); }
});

test('/antinuke whitelist: add, remove, list, check and bots, under the clearer name', async () => {
    const { store, registry } = await guardSetup();
    try {
        indexTree(registry);
        const antinuke = treeJson(registry).find(c => c.name === 'antinuke')!;
        const group = antinuke.options.find((o: any) => o.name === 'whitelist');
        assert.ok(group, '/antinuke whitelist exists');
        assert.deepEqual(group.options.map((o: any) => o.name), ['add', 'remove', 'list', 'check', 'bots']);
        assert.ok(!antinuke.options.some((o: any) => o.name === 'trust'), 'the old name is gone');
        const trust = (await import('../src/commands/security/trust.js')).default;
        store.grant(G, TARGET, 'trust', OWNER); store.grant(G, TARGET, 'trust:mass_ban', OWNER);
        const logs: any[] = [];
        const i: any = { guildId: G, guild: { id: G, ownerId: OWNER }, user: { id: OWNER }, options: { getSubcommand: () => 'remove', getUser: () => ({ id: TARGET }), getRole: () => null } };
        const reply = await store.withAuthorized(G, () => trust.execute({ store, actor: { id: OWNER }, logs: { push: (_g: string, e: any) => logs.push(e) } } as any, i));
        assert.match(String(reply), /off the whitelist/);
        assert.equal(store.all("SELECT * FROM grants WHERE user_id=?", TARGET).length, 0, 'every whitelist permission for them is removed');
        const again = await store.withAuthorized(G, () => trust.execute({ store, actor: { id: OWNER }, logs: { push: () => {} } } as any, i));
        assert.match(String(again), /not on the whitelist/);
    } finally { store.close(); }
});

test('the reorganized command list: the expected top-level commands and groups', async () => {
    const { store, registry } = await guardSetup();
    try {
        indexTree(registry);
        const tree = treeJson(registry);
        assert.deepEqual(tree.map(c => c.name), ['antinuke', 'mod', 'security', 'setup', 'recovery', 'info', 'network', 'dev', 'help', 'verify', 'roblox', 'ask', 'role']);
        const subs = (name: string) => tree.find(c => c.name === name)!.options.map((o: any) => o.name);
        assert.deepEqual(subs('antinuke'), ['status', 'enable', 'disable', 'check', 'scan', 'settings', 'whitelist']);
        assert.deepEqual(subs('network'), ['genreban', 'ungenreban', 'hardban', 'unhardban', 'exceptions']);
        assert.ok(!subs('security').includes('mention') && !subs('security').includes('roblox-block'), 'duplicates removed');
        assert.ok(subs('setup').includes('permissions') && subs('mod').includes('notes'));
        const server = tree.find(c => c.name === 'dev')!.options.find((o: any) => o.name === 'server');
        assert.deepEqual(server.options.map((o: any) => o.name), ['authorize', 'deauthorize', 'info', 'list', 'ban', 'unban']);
        for (const c of tree) assert.ok((c.options ?? []).length <= 25, `${c.name} fits Discord's 25-option limit`);
    } finally { store.close(); }
});
