import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection, PermissionFlagsBits } from 'discord.js';
import { Store } from '../src/database/db.js';
import { Guard } from '../src/bot/guard.js';
import { defaults } from '../src/bot/registry.js';
import { config } from '../src/config.js';
import { canStrip, panelMessage, panelOverwrites, recentActivity, recordPanelAction, revertibles, setupPanel, PANEL_CHANNEL } from '../src/ui/control-panel.js';
import { authorize } from './helpers.js';

const G = '123456789012345678', OWNER = '111111111111111111', BOT = '999999999999999999', ADMIN = '333333333333333333', MOD = '555555555555555555', DEV = '222222222222222222';
const store = () => { const s = new Store(':memory:'); authorize(s, G); return s; };

test('the panel has the five colour-coded buttons with fixed IDs, so they work after a restart', () => {
    const s = store();
    try {
        const p = panelMessage(s, G);
        const buttons = p.components[0]!.toJSON().components as any[];
        assert.deepEqual(buttons.map(b => [b.label, b.custom_id, b.style]), [
            ['Restore Roles', 'vgpanel:restore', 3], ['Strip Roles', 'vgpanel:strip', 4], ['Revert Action', 'vgpanel:revert', 4],
            ['View Logs', 'vgpanel:logs', 2], ['Refresh Panel', 'vgpanel:refresh', 2]]);
        assert.match(p.embeds[0]!.toJSON().title!, /Control Panel/);
    } finally { s.close(); }
});

test('only authorized staff can see the channel: everyone hidden, owner, security admins and admin roles allowed', () => {
    const s = store();
    try {
        s.grant(G, ADMIN, 'admin', OWNER);
        s.run("INSERT INTO permission_roles(guild_id,role_id,access,by_id) VALUES(?,?,'admin',?)", G, '700000000000000001', OWNER);
        s.run("INSERT INTO staff_roles(guild_id,role_id,level) VALUES(?,?,'headadmin')", G, '700000000000000002');
        s.run("INSERT INTO staff_roles(guild_id,role_id,level) VALUES(?,?,'moderator')", G, '700000000000000003');
        const roles = { cache: new Collection([['700000000000000001', {}], ['700000000000000002', {}], ['700000000000000003', {}]]) };
        const o = panelOverwrites(s, { id: G, ownerId: OWNER, roles } as any, BOT) as any[];
        const by = (id: string) => o.find(x => x.id === id);
        assert.deepEqual(by(G).deny, [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages], '@everyone cannot see it');
        assert.ok(by(BOT).allow.includes(PermissionFlagsBits.SendMessages));
        assert.ok(by(OWNER) && by(ADMIN) && by('700000000000000001') && by('700000000000000002'));
        assert.equal(by('700000000000000003'), undefined, 'moderators are not given access');
    } finally { s.close(); }
});

function fakeGuild() {
    const created: any[] = [], messages = new Map<string, any>();
    const channel: any = { id: '800000000000000001', name: PANEL_CHANNEL, type: ChannelType.GuildText, sets: 0,
        permissionOverwrites: { set: async () => { channel.sets++; } },
        messages: { fetch: async (id: string) => messages.get(id) ?? Promise.reject(new Error('Unknown Message')) },
        send: async (p: any) => { const m = { id: `90000000000000000${messages.size}`, edits: 0, payload: p, edit: async () => { m.edits++; } }; messages.set(m.id, m); return m; } };
    const guild: any = { id: G, ownerId: OWNER, roles: { cache: new Collection() }, members: { fetchMe: async () => ({ id: BOT }) },
        channels: { cache: new Collection<string, any>(), fetch: async (id: string) => guild.channels.cache.get(id) ?? null,
            create: async (o: any) => { created.push(o); guild.channels.cache.set(channel.id, channel); return channel; } } };
    return { guild, channel, created, messages };
}

test('/setup panel creates the channel once; running it again updates it instead of duplicating', async () => {
    const s = store();
    try {
        const { guild, channel, created, messages } = fakeGuild();
        const first = await s.withAuthorized(G, () => setupPanel(s, guild, OWNER));
        assert.equal(first.created, true); assert.equal(created.length, 1); assert.equal(messages.size, 1);
        assert.equal(created[0].name, PANEL_CHANNEL);
        const second = await s.withAuthorized(G, () => setupPanel(s, guild, OWNER));
        assert.equal(second.created, false); assert.equal(created.length, 1, 'no second channel');
        assert.equal(messages.size, 1, 'no second panel message'); assert.equal([...messages.values()][0].edits, 1, 'the panel was edited in place');
        assert.equal(channel.sets, 1, 'access was refreshed');
        messages.clear();
        const third = await s.withAuthorized(G, () => setupPanel(s, guild, OWNER));
        assert.equal(third.reposted, true, 'a deleted panel message is posted again'); assert.equal(created.length, 1);
    } finally { s.close(); }
});

test('strip respects hierarchy: never yourself, the owner, the bot, developers, people above you, or anyone above the bot', () => {
    config.developers.add(DEV);
    try {
        const pos = (n: number) => ({ comparePositionTo: (o: any) => n - o.n, n });
        const m = (id: string, n: number, manageable = true) => ({ id, manageable, roles: { highest: pos(n) } }) as any;
        const g = { ownerId: OWNER };
        assert.equal(canStrip(g, m(MOD, 5), m(ADMIN, 3), BOT), null);
        assert.match(canStrip(g, m(MOD, 5), m(MOD, 5), BOT)!, /yourself/);
        assert.match(canStrip(g, m(MOD, 5), m(OWNER, 1), BOT)!, /owner/);
        assert.match(canStrip(g, m(MOD, 5), m(DEV, 1), BOT)!, /developers/);
        assert.match(canStrip(g, m(MOD, 3), m(ADMIN, 5), BOT)!, /equal to or above yours/);
        assert.match(canStrip(g, m(MOD, 9), m(ADMIN, 5, false), BOT)!, /at or above Ghost Vanguard/);
        assert.equal(canStrip(g, m(OWNER, 1), m(ADMIN, 5), BOT), null, 'the owner can strip anyone below the bot');
        assert.match(canStrip(g, m(MOD, 5), null, BOT)!, /not in this server/);
    } finally { config.developers.delete(DEV); }
});

test('revert lists only strips still in place and bot-made local bans from the last week; every action is logged', () => {
    const s = store();
    try {
        s.readGuild(G, () => {
            s.run("INSERT INTO incidents(guild_id,actor_id,rule,at,mode,result) VALUES(?,?,?,?,?,?)", G, ADMIN, 'dangerous_grant', Date.now(), 'enforce', 'Removed 2 dangerous role(s).');
            s.run("INSERT INTO incidents(guild_id,actor_id,rule,at,mode,result) VALUES(?,?,?,?,?,?)", G, MOD, 'dangerous_grant', Date.now(), 'enforce', 'Removed 1 dangerous role(s). Undone by 1.');
            s.run('INSERT INTO backups(guild_id,user_id,roles,at,active) VALUES(?,?,?,?,1)', G, ADMIN, '["r"]', Date.now());
            s.run("INSERT INTO ban_records(guild_id,number,user_id,username,kind,reason,moderator_id,moderator_role,banned_at,status) VALUES(?,1,'444444444444444444','raider','ban','spam',?, 'via-bot',?, 'banned')", G, MOD, Date.now());
            s.run("INSERT INTO ban_records(guild_id,number,user_id,username,kind,reason,moderator_id,moderator_role,banned_at,status) VALUES(?,2,'444444444444444445','alt','hardban','raid',?, 'via-bot',?, 'banned')", G, DEV, Date.now());
        });
        const options = s.readGuild(G, () => revertibles(s, G));
        assert.deepEqual(options.map(o => o.value.split(':')[0]), ['inc', 'ban'], 'one strip still in place and one local ban; the undone strip and the hardban are left out');
        const pushed: any[] = [];
        s.readGuild(G, () => recordPanelAction(s, { push: (_g: string, e: any) => pushed.push(e.toJSON()) } as any, G, MOD, ADMIN, 'Strip Roles', 'Removed 2 dangerous role(s).'));
        const row = s.readGuild(G, () => s.get('SELECT * FROM panel_actions WHERE guild_id=?', G))!;
        assert.equal(row.staff_id, MOD); assert.equal(row.target_id, ADMIN); assert.equal(row.action, 'Strip Roles'); assert.ok(Number(row.at) > 0);
        assert.deepEqual(pushed[0].fields.map((f: any) => f.name), ['Staff', 'Target', 'When', 'Result']);
        assert.match(s.readGuild(G, () => recentActivity(s, G)), /Strip Roles\*\* · <@333333333333333333> · by <@555555555555555555>/);
    } finally { s.close(); }
});

test('panel buttons are Server Owner and Developers only: Administrator and security admins never reach them', () => {
    const s = store();
    try {
        const guard = new Guard(s);
        const policy = { ...defaults, category: 'security', access: 'security' as const };
        const member = (id: string, perms = 0n) => ({ id, guild: { id: G, ownerId: OWNER }, roles: { cache: new Map() }, permissions: { has: (p: any) => (BigInt(perms) & BigInt(p)) === BigInt(p) } }) as any;
        assert.equal(guard.allowed(policy, G, ADMIN, member(ADMIN, PermissionFlagsBits.Administrator), 'vgpanel', 'vgpanel/'), false);
        s.grant(G, ADMIN, 'admin', OWNER);
        assert.equal(guard.allowed(policy, G, ADMIN, member(ADMIN), 'vgpanel', 'vgpanel/'), false, 'a security-admin grant does not reopen the control panel');
        assert.equal(guard.allowed(policy, G, MOD, member(MOD), 'vgpanel', 'vgpanel/'), false);
        assert.equal(guard.allowed(policy, G, OWNER, member(OWNER), 'vgpanel', 'vgpanel/'), true);
    } finally { s.close(); }
});
