import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { Store } from '../src/database/db.js';
import { Registry, defaults } from '../src/bot/registry.js';
import { Guard } from '../src/bot/guard.js';
import { config } from '../src/config.js';
import { helpCategories, accessLabel } from '../src/ui/help-ui.js';
import { confirmDanger, registerDangerConfirm } from '../src/ui/danger-ui.js';
import { previewHistory, registerHistory } from '../src/ui/config-history.js';
import { changeTrust, registerAntinukePanel } from '../src/ui/antinuke-panel.js';
import { clearTrust, saveTrust, registerTrustPanel } from '../src/ui/trust-panel.js';
import { registerControlPanel } from '../src/ui/control-panel.js';
import { registerIncidentControls } from '../src/ui/incident-ui.js';
import { canApproveBot, quarantineNewBot, registerBotQuarantineControls } from '../src/features/antinuke-plus.js';
import guildConfig from '../src/commands/configuration/guild-config.js';
import { authorize } from './helpers.js';

const G = '111111111111111111', OWNER = '222222222222222222', DEV = '333333333333333333', STAFF = '444444444444444444';
const registry = new Registry(); await registry.load();
registerAntinukePanel(registry); registerTrustPanel(registry); registerBotQuarantineControls(registry);

function fixture(user = OWNER) {
    const store = new Store(':memory:'); authorize(store, G);
    const guild: any = { id: G, ownerId: OWNER, roles: { cache: new Collection() }, members: { me: { permissions: { has: () => true } } } };
    const actor: any = { id: user, guild, permissions: new PermissionsBitField(), roles: { cache: new Collection() } };
    guild.members.fetch = async () => actor;
    let reply: any;
    const i: any = { guildId: G, guild, user: { id: user }, member: actor, inCachedGuild: () => true, editReply: async (p: any) => { reply = p; } };
    const ctx: any = { store, actor, registry, logs: { push: () => {} }, confirmations: new Map(), lifecycle: { isReady: () => true }, assertActive: () => store.assertAuthorized(G) };
    return { store, guild, actor, i, ctx, reply: () => reply };
}

const commandKeys = [
    'antinuke/status', 'antinuke/enable', 'antinuke/disable', 'antinuke/check', 'enable', 'disable',
    'antinuke-plus/scan', 'antinuke-plus/settings', 'trust/add', 'trust/remove', 'trust/list', 'trust/check', 'trust/bots',
    'security/config', 'security/quarantine', 'security/release', 'logs/setup',
];

test('only actual owners and configured developers pass anti-nuke commands and component permissions', () => {
    const f = fixture(); const oldOwner = config.ownerId; const hadDev = config.developers.has(DEV);
    try {
        config.developers.add(DEV); config.ownerId = '555555555555555555';
        f.store.run('INSERT INTO staff_roles(guild_id,role_id,level) VALUES(?,?,?)', G, 'head', 'headadmin');
        f.store.run('INSERT INTO permission_roles VALUES(?,?,?,?)', G, 'legacy', 'admin', OWNER);
        f.store.grant(G, 'grant-admin', 'admin', OWNER); f.store.grant(G, 'whitelisted', 'trust', OWNER);
        for (const level of ['botmanager', 'overseer', 'supreme']) f.store.db.prepare('INSERT INTO bot_staff(user_id,level) VALUES(?,?)').run(level, level);
        const profiles: [string, bigint, string[], boolean][] = [
            [OWNER, 0n, [], true], [DEV, 0n, [], true], [config.ownerId, 0n, [], true],
            [STAFF, PermissionFlagsBits.Administrator, [], false], ['head', 0n, ['head'], false],
            ['legacy', 0n, ['legacy'], false], ['grant-admin', 0n, [], false], ['whitelisted', 0n, [], false],
            ['botmanager', 0n, [], false], ['overseer', 0n, [], false], ['supreme', 0n, [], false],
        ];
        const guard = new Guard(f.store);
        for (const [id, permissions, roles, expected] of profiles) {
            const actor: any = { id, guild: f.guild, permissions: new PermissionsBitField(permissions), roles: { cache: new Collection(roles.map(r => [r, {}])) } };
            for (const key of commandKeys) {
                const [name, sub] = key.split('/'), def = registry.commands.get(`1:${name}`)!;
                assert.equal(guard.allowed({ ...def.metadata, ...def.subcommands?.[sub ?? ''] }, G, id, actor, name, key), expected, `${id}: ${key}`);
            }
            for (const control of registry.components) {
                const root = control.prefix.split(':')[0]!;
                assert.equal(guard.allowed(control.metadata, G, id, actor, root, `${root}/`), expected, `${id}: ${control.prefix}`);
            }
            const incidents = new Registry(); registerIncidentControls(incidents);
            for (const control of incidents.components.filter(c => c.prefix.startsWith('incident:')))
                assert.equal(guard.allowed(control.metadata, G, id, actor, 'incident', 'incident/'), expected, `${id}: ${control.prefix}`);
        }
        const head: any = { id: STAFF, guild: f.guild, permissions: new PermissionsBitField(), roles: { cache: new Collection([['head', {}]]) } };
        assert.equal(guard.allowed({ ...defaults, access: 'security', category: 'moderation' }, G, STAFF, head, 'moderation', 'moderation/ban'), true, 'ordinary moderation remains available');
        const foreignOwner = { ...head, id: OWNER, guild: { id: 'other', ownerId: OWNER } };
        assert.equal(guard.allowed(defaults, G, OWNER, foreignOwner, 'antinuke', 'antinuke/status'), false, 'ownership must apply to this guild');
    } finally { config.ownerId = oldOwner; if (!hadDev) config.developers.delete(DEV); f.store.close(); }
});

test('help hides anti-nuke from Head Admins and labels owner/developer access correctly', () => {
    const f = fixture(STAFF);
    try {
        f.store.grant(G, STAFF, 'admin', OWNER);
        assert.equal(helpCategories(f.ctx, G, STAFF).some(g => g.key === 'antinuke'), false);
        f.ctx.actor = { ...f.actor, id: OWNER };
        const section = helpCategories(f.ctx, G, OWNER).find(g => g.key === 'antinuke');
        assert.ok(section?.lines.length);
        assert.ok(section.lines.every(line => line.includes('Server owner or Developer')));
        assert.equal(accessLabel(defaults, 'trust/add'), 'Server owner or Developer');
    } finally { f.store.close(); }
});

test('a former owner cannot confirm a pending anti-nuke action after ownership changes', async () => {
    const f = fixture(); const r = new Registry(); registerDangerConfirm(r);
    try {
        f.ctx.policy = registry.commands.get('1:antinuke')!.metadata; f.ctx.actionKey = 'antinuke/disable';
        let ran = 0;
        await confirmDanger(f.ctx, f.i, { title: 'Disable', summary: 'Disable anti-nuke', consequences: [], label: 'Disable', reversal: 'Enable', run: async () => { ran++; } });
        f.i.customId = f.reply().components[0].components[0].data.custom_id;
        f.guild.ownerId = STAFF;
        await assert.rejects(r.components[0]!.execute(f.ctx, f.i), /Only the current server owner/);
        assert.equal(ran, 0);
    } finally { f.store.close(); }
});

test('old whitelist and held-bot controls recheck the current owner', async () => {
    const f = fixture();
    try {
        const guard = new Guard(f.store); f.guild.ownerId = STAFF;
        for (const control of registry.components) {
            const root = control.prefix.split(':')[0]!;
            await assert.rejects(guard.check(f.i, control.metadata, `${root}/`, false, true), /Only the current server owner/);
        }
    } finally { f.store.close(); }
});

test('Head Admins cannot add, clear, or remove whitelist grants through helpers', () => {
    const f = fixture(STAFF);
    try {
        f.store.grant(G, STAFF, 'admin', OWNER); f.store.grant(G, 'target', 'trust', OWNER);
        for (const work of [() => changeTrust(f.ctx, G, 'target', false, true), () => changeTrust(f.ctx, G, 'target', false, false),
            () => saveTrust(f.ctx, G, 'target', false, ['all'], 0), () => clearTrust(f.ctx, G, 'target', false)])
            assert.throws(work, /Only the current server owner/);
        assert.equal(f.store.hasGrant(G, 'target', 'trust'), true);
    } finally { f.store.close(); }
});

test('anti-nuke command switches require the actual owner or developer even for bot-wide staff', async () => {
    const f = fixture(STAFF);
    try {
        f.store.db.prepare('INSERT INTO bot_staff(user_id,level) VALUES(?,?)').run(STAFF, 'supreme');
        f.i.options = { getSubcommand: () => 'command', getString: () => 'antinuke', getBoolean: () => false, getInteger: () => 0 };
        await assert.rejects(guildConfig.execute(f.ctx, f.i), /Only the current server owner/);
        assert.equal(f.store.get('SELECT 1 FROM command_settings WHERE guild_id=?', G), undefined);
        f.i.user.id = OWNER;
        await guildConfig.execute(f.ctx, f.i);
        assert.equal(f.store.get('SELECT enabled FROM command_settings WHERE guild_id=? AND command=?', G, 'antinuke')?.enabled, 0);
    } finally { f.store.close(); }
});

test('anti-nuke configuration and trust history cannot bypass the owner restriction', async () => {
    const f = fixture(STAFF);
    try {
        f.store.db.prepare('INSERT INTO bot_staff(user_id,level) VALUES(?,?)').run(STAFF, 'supreme');
        for (const [component, previous] of [['settings', { ...f.store.settings(G), enabled: false }], ['grant', { guild_id: G, user_id: 'target', kind: 'trust_role:mass_ban' }], ['command:antinuke', { guild_id: G, command: 'antinuke', enabled: 0 }], ['feature/antinukeplus', { botQuarantine: false }]] as const) {
            f.store.history(G, component, previous, null, OWNER);
            const row = f.store.get('SELECT id FROM configuration_history WHERE guild_id=? ORDER BY id DESC LIMIT 1', G)!;
            await assert.rejects(previewHistory(f.ctx, f.i, row.id), /Only the current server owner/);
        }
    } finally { f.store.close(); }
});

for (const duringBackup of [false, true])
test(`anti-nuke rollback rejects ownership transfer ${duringBackup ? 'during backup' : 'before confirmation'}`, async () => {
    const f = fixture(); const r = new Registry(); registerHistory(r);
    try {
        const settings = f.store.settings(G); f.store.history(G, 'settings', { ...settings, enabled: true }, settings, OWNER);
        const row = f.store.get('SELECT id FROM configuration_history WHERE guild_id=? ORDER BY id DESC LIMIT 1', G)!;
        f.ctx.databaseBackups = { create: async () => { if (duringBackup) f.guild.ownerId = STAFF; } };
        await previewHistory(f.ctx, f.i, row.id);
        f.i.customId = `history:apply:${[...f.ctx.confirmations.keys()][0]}`;
        if (!duringBackup) f.guild.ownerId = STAFF;
        await assert.rejects(r.components[0]!.execute(f.ctx, f.i), /Only the current server owner/);
        assert.equal(f.store.settings(G).enabled, false);
    } finally { f.store.close(); }
});

test('control-panel strip and quarantine restoration are owner/developer only', async () => {
    const f = fixture(STAFF); const r = new Registry(); registerControlPanel(r);
    try {
        f.store.run('INSERT INTO backups VALUES(?,?,?,?,?)', G, DEV, '["staff-role"]', Date.now(), 1);
        for (const [customId, values] of [['vgpanel:strip', []], ['vgpanel:pick:strip', [DEV]], ['vgpanel:pick:restore', [DEV]]] as const)
            await assert.rejects(r.components[0]!.execute(f.ctx, { ...f.i, customId, values }), /Only the current server owner/);
        assert.ok(f.store.get('SELECT 1 FROM backups WHERE guild_id=? AND user_id=? AND active=1', G, DEV));
    } finally { f.store.close(); }
});

test('configured developers can approve held bots; Supreme Leader status cannot approve or auto-approve', async () => {
    const f = fixture(); const hadDev = config.developers.has(DEV), hadSupreme = config.supremeExtra.has(STAFF);
    try {
        config.developers.add(DEV); config.supremeExtra.add(STAFF);
        assert.equal(canApproveBot({ user: DEV, ownerId: OWNER }), null);
        assert.match(canApproveBot({ user: STAFF, ownerId: OWNER })!, /Only the current server owner/);
        const settings = f.store.settings(G); settings.enabled = true; settings.mode = 'enforce'; f.store.save(settings);
        let permissions = PermissionFlagsBits.Administrator;
        const bot: any = { id: '666666666666666666', user: { bot: true }, roles: { botRole: {
            editable: true, get permissions() { return new PermissionsBitField(permissions); }, setPermissions: async (v: bigint) => { permissions = v; },
        } }, guild: { ...f.guild, fetchAuditLogs: async () => ({ entries: new Collection([['entry', { targetId: '666666666666666666', executorId: STAFF }]]) }) } };
        await quarantineNewBot(f.store, f.ctx.logs, bot);
        assert.equal(permissions, 0n);
        assert.ok(f.store.get('SELECT value FROM runtime_meta WHERE key=?', `botq:${G}:${bot.id}`));
    } finally { if (!hadDev) config.developers.delete(DEV); if (!hadSupreme) config.supremeExtra.delete(STAFF); f.store.close(); }
});
