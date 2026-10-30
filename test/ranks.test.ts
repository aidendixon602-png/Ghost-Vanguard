import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionsBitField } from 'discord.js';
import { Store } from '../src/database/db.js';
import { authorize } from './helpers.js';
import { config } from '../src/config.js';
import { Guard } from '../src/bot/guard.js';
import { defaults } from '../src/bot/registry.js';
import { RANKS, rankOf, requiredRank } from '../src/bot/ranks.js';
import staff from '../src/commands/configuration/staff.js';

const G = 'g';
// Nothing is built in: BOT_OWNER_ID is whatever the deployment sets, so these tests set it.
config.ownerId = '1277709272041394187';
const member = (id: string, roles: string[] = [], owner = 'owner') => ({ id, guild: { id: G, ownerId: owner }, roles: { cache: new Collection(roles.map(r => [r, {}])) }, permissions: new PermissionsBitField() }) as any;
function setup() {
    const store = new Store(':memory:'); authorize(store, G); store.save(store.settings(G));
    for (const [role, level] of [['r-help', 'helper'], ['r-mod', 'moderator'], ['r-admin', 'admin'], ['r-head', 'headadmin']])
        store.run('INSERT INTO staff_roles(guild_id,role_id,level) VALUES(?,?,?)', G, role, level);
    return store;
}

test('rank comes from BOT_OWNER, developers, bot-wide staff, server owner, staff roles and older access settings', () => {
    const store = setup(), dev = '723456789012345678'; config.developers.add(dev);
    try {
        assert.equal(rankOf(store, G, config.ownerId, member(config.ownerId)), RANKS.developer, 'the bot owner is a Developer, the top rank');
        assert.equal(rankOf(store, G, dev, member(dev)), RANKS.developer);
        store.db.prepare("INSERT INTO bot_staff(user_id,level) VALUES('ov','overseer'),('bm','botmanager')").run();
        assert.equal(rankOf(store, G, 'ov', member('ov')), RANKS.overseer);
        assert.equal(rankOf(store, 'other', 'bm', null), RANKS.botmanager, 'bot-wide ranks apply in every server');
        assert.equal(rankOf(store, G, 'owner', member('owner')), RANKS.owner);
        assert.equal(rankOf(store, G, 'x', member('x', ['r-help', 'r-admin'])), RANKS.admin, 'highest role wins');
        assert.equal(rankOf(store, G, 'nobody', member('nobody')), 0);
        store.grant(G, 'old', 'admin', 'owner'); assert.equal(rankOf(store, G, 'old', member('old')), RANKS.headadmin, 'old security admins = Head Admin');
        store.run("INSERT INTO permission_roles VALUES(?,?,?,?)", G, 'legacy-mod', 'moderator', 'owner');
        assert.equal(rankOf(store, G, 'lm', member('lm', ['legacy-mod'])), RANKS.moderator);
    } finally { config.developers.delete(dev); store.close(); }
});

test('each rank opens exactly its commands, without needing Discord permissions', () => {
    const store = setup(), guard = new Guard(store);
    const can = (roles: string[], key: string, policy: any = {}) => guard.allowed({ ...defaults, access: 'security', developerOnly: false, requiredPermissions: [PermissionsBitField.Flags.BanMembers], ...policy }, G, 'u', member('u', roles), undefined, key);
    assert.equal(can(['r-help'], 'moderation/warn'), true); assert.equal(can(['r-help'], 'moderation/timeout'), true);
    assert.equal(can(['r-help'], 'moderation/ban'), false, 'helpers cannot ban');
    assert.equal(can(['r-mod'], 'moderation/ban'), true, 'moderators can ban without Discord Ban Members');
    assert.equal(can(['r-mod'], 'raidmode/on'), false); assert.equal(can(['r-admin'], 'raidmode/on'), true);
    assert.equal(can(['r-admin'], 'antinuke/status'), false); assert.equal(can(['r-head'], 'antinuke/status'), true);
    assert.equal(can(['r-head'], 'dev/status', { developerOnly: true }), false, 'server ranks never reach bot tools');
    store.db.prepare("INSERT INTO bot_staff(user_id,level) VALUES('u','botmanager')").run();
    assert.equal(can([], 'dev/status', { developerOnly: true }), true, 'Bot Manager: bot status');
    assert.equal(can([], 'dev/inspect', { developerOnly: true }), false);
    assert.equal(can([], 'moderation/ban'), true, 'bot-wide ranks include everything below');
    store.db.prepare("UPDATE bot_staff SET level='overseer'").run();
    assert.equal(can([], 'dev/inspect', { developerOnly: true }), true); assert.equal(can([], 'database/status', { developerOnly: true }), false);
    store.run('INSERT INTO feature_settings VALUES(?,?,?)', G, 'moderation', 0);
    assert.equal(guard.allowed({ ...defaults, category: 'moderation' }, G, 'u', member('u'), 'moderation', 'moderation/ban'), false, 'switched-off features stay off for every rank');
    assert.equal(requiredRank('help/'), undefined, 'everyday commands are not rank-gated');
    assert.equal(requiredRank('roblox/bloxlink-sync'), RANKS.admin, 'running Bloxlink role updates is Admin-only');
    store.close();
});

test('/staff: you can only hand out ranks below your own; bot-wide ranks are Developer only', async () => {
    const store = setup();
    const run = (actor: any, sub: string, o: any) => staff.execute({ store, actor, logs: { push: () => {} } } as any, { guildId: G, user: { id: actor.id }, guild: { ownerId: 'owner', members: { fetch: async () => member('t') } },
        options: { getSubcommand: () => sub, getRole: () => ({ id: o.role ?? 'new-role', managed: false }), getString: () => o.rank, getUser: () => o.user ?? null } } as any);
    const head = member('h', ['r-head']);
    assert.match(await run(head, 'role', { rank: 'admin' }) as string, /now \*\*Admin\*\*/);
    await assert.rejects(run(head, 'role', { rank: 'headadmin', role: 'other' }), /above Head Admin/);
    await assert.rejects(run(head, 'role', { rank: 'none', role: 'r-head' }), /above Head Admin/, 'cannot demote your own level');
    assert.match(await run(member('owner'), 'role', { rank: 'headadmin', role: 'other' }) as string, /Head Admin/, 'server owner can make Head Admins');
    await assert.rejects(run(member('a', ['r-admin']), 'role', { rank: 'helper', role: 'x' }), /Head Admins and above/);
    await assert.rejects(run(member('owner'), 'global', { rank: 'overseer', user: { id: 'z', bot: false } }), /Only a Developer/, 'owning a server never unlocks bot-wide ranks');
    assert.match(await run(member(config.ownerId!), 'global', { rank: 'overseer', user: { id: 'z', bot: false } }) as string, /Overseer\*\* in every server/);
    assert.equal(rankOf(store, 'anywhere', 'z', null), RANKS.overseer);
    // Server Owner = whoever owns the Discord server: above Supreme Leader there, but no bot-wide tools.
    store.run("INSERT INTO bot_staff(user_id,level,by_id,at) VALUES('sl','supreme','x',0)");
    assert.equal(rankOf(store, G, 'owner', member('owner')), RANKS.owner);
    assert.ok(RANKS.developer > RANKS.owner && RANKS.owner > RANKS.supreme, 'Developer > Server Owner > Supreme Leader');
    assert.ok(rankOf(store, G, 'owner', member('owner')) > rankOf(store, G, 'sl', member('sl')), 'the server owner outranks a Supreme Leader in their server');
    assert.equal(rankOf(store, 'other', 'owner', member('owner', [], 'someone-else')), 0, 'only in the server they own');
    for (const key of ['dev/diagnostics', 'genreban', 'database/backup', 'authserver', 'staff/global'])
        assert.equal(rankOf(store, G, 'owner', member('owner'), key), 0, `owning a server never unlocks /${key}`);
    assert.equal(rankOf(store, G, 'sl', member('sl'), 'genreban'), RANKS.supreme, 'bot ranks still count for bot-wide tools');
    await assert.rejects(run(member('sl'), 'global', { rank: 'overseer', user: { id: 'y', bot: false } }), /Only a Developer/, 'Supreme Leaders cannot hand out bot-wide ranks');
    const list = await run(head, 'list', {}) as string;
    assert.match(list, /Supreme Leader: .*<@sl>/); assert.match(list, /Server Owner: <@owner>/);
    for (const re of [/Overseer: <@z>/, /Head Admin: .*<@&r-head>/, /Head Admin: .*<@&other>/, /\nAdmin: .*<@&new-role>/, /Moderator: <@&r-mod>/, /Helper: <@&r-help>/]) assert.match(list, re);
    store.close();
});
