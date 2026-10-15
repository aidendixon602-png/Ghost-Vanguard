import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { Collection, PermissionsBitField, IntentsBitField } from 'discord.js';
import { Store } from '../src/database/db.js';
import { DatabaseBackups } from '../src/database/database-backups.js';
import { ProtectionStats } from '../src/security/protection-stats.js';
import { serverInfo, botInfo } from '../src/ui/info-ui.js';
import { Registry, defaults } from '../src/bot/registry.js';
import { RULES, overrideRule } from '../src/core.js';
import { config } from '../src/config.js';
import { Guard } from '../src/bot/guard.js';
import { previewHistory, registerHistory } from '../src/ui/config-history.js';
import { authorize } from './helpers.js';

const user = '1277709272041394187';

test('old JSON configuration migrates without data loss with verified pre-migration backup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vanguard-migration-')), path = join(dir, 'bot.db');
    try {
        const old = new DatabaseSync(path);
        old.exec(`PRAGMA journal_mode=WAL; PRAGMA user_version=2;
        CREATE TABLE settings(guild_id TEXT PRIMARY KEY,json TEXT NOT NULL);
        CREATE TABLE grants(guild_id TEXT,user_id TEXT,kind TEXT,by_id TEXT,expires INTEGER,PRIMARY KEY(guild_id,user_id,kind));
        CREATE TABLE links(guild_id TEXT,user_id TEXT,roblox_id TEXT,username TEXT,synced INTEGER,PRIMARY KEY(guild_id,user_id));`);
        old.prepare('INSERT INTO settings VALUES(?,?)').run('a', JSON.stringify({ guildId: 'a', enabled: true, mode: 'enforce', logChannelId: 'log', minAge: 12, rules: { mass_ban: { count: 2, seconds: 10 } } }));
        old.prepare('INSERT INTO grants VALUES(?,?,?,?,?)').run('a', 'staff', 'admin', user, null);
        old.prepare('INSERT INTO links VALUES(?,?,?,?,?)').run('a', 'member', 'roblox-id', 'RobloxName', 100);
        old.close();
        const store = new Store(path);
        const s = store.settings('a');
        assert.equal(s.enabled, true);
        assert.equal(s.minAge, 12);
        assert.deepEqual(s.rules.mass_ban, { count: 2, seconds: 10 });
        assert.equal(store.hasGrant('a', 'staff', 'admin'), true);
        assert.equal(store.get('SELECT roblox_id FROM links WHERE guild_id=?', 'a')?.roblox_id, 'roblox-id');
        assert.equal(store.get("SELECT 1 FROM sqlite_master WHERE name='settings'"), undefined);
        assert.equal(store.get('PRAGMA user_version')?.user_version, 3);
        assert.equal(store.all('PRAGMA foreign_key_check').length, 0);
        const saved = store.get("SELECT * FROM database_backups WHERE kind='migration'")!;
        assert.equal(saved.verified, 1);
        assert.ok(saved.checksum);
        store.close();
        const restoredOld = new DatabaseSync(saved.path, { readOnly: true });
        assert.ok(restoredOld.prepare('SELECT json FROM settings').get());
        restoredOld.close();
        const reopened = new Store(path);
        assert.equal(reopened.settings('a').enabled, true);
        reopened.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('cross-guild reads and mutations are blocked; explicit authorized copy scopes remain possible', async () => {
    const s = new Store(':memory:');
    authorize(s, 'a');
    authorize(s, 'b');
    const b = s.settings('b');
    b.minAge = 99;
    s.save(b);
    await s.withAuthorized('a', async () => {
        assert.throws(() => s.settings('b'), /Cross-guild/);
        assert.throws(() => s.all('SELECT * FROM links'), /unscoped/);
        assert.throws(() => s.run('INSERT INTO links VALUES(?,?,?,?,?)', 'b', 'u', 'r', 'name', 0), /Cross-guild/);
        assert.throws(() => s.run('UPDATE guild_config SET min_age=? WHERE guild_id=?', 1, 'b'), /Cross-guild/);
        await s.withAuthorized('b', async () => {
            assert.equal(s.settings('b').minAge, 99);
        });
        assert.equal(s.settings('a').minAge, 7);
    });
    s.close();
});

test('INSERT OR REPLACE never replaces guild parent rows or destroys authorization/config', () => {
    const s = new Store(':memory:');
    authorize(s);
    const state = s.settings('g');
    state.minAge = 42;
    s.save(state);
    s.run('INSERT OR REPLACE INTO blocked_accounts VALUES(?,?,?)', 'g', 'r', 'reason');
    s.run('INSERT OR REPLACE INTO blocked_accounts VALUES(?,?,?)', 'g', 'r', 'new reason');
    assert.equal(s.isAuthorized('g'), true);
    assert.equal(s.settings('g').minAge, 42);
    assert.equal(s.all('PRAGMA foreign_key_check').length, 0);
    s.close();
});

test('database backups preserve WAL data, verify checksum, and detect corruption', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vanguard-backup-')), s = new Store(join(dir, 'live.db'));
    authorize(s);
    try {
        const setting = s.settings('g');
        setting.minAge = 21;
        s.save(setting, user);
        const backups = new DatabaseBackups(s, join(dir, 'backups')), backup = await backups.create('manual');
        assert.equal(await backups.verify(backup.id), true);
        const restored = new DatabaseSync(backup.path, { readOnly: true });
        assert.equal(restored.prepare('SELECT min_age FROM guild_config WHERE guild_id=?').get('g')?.min_age, 21);
        restored.close();
        writeFileSync(backup.path, Buffer.from('corrupt'));
        await assert.rejects(backups.verify(backup.id), /checksum mismatch/);
        assert.equal(s.health().last_backup, backup.at);
    } finally {
        s.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('backup retention keeps recent/daily/weekly generations and reports failures to developer hook', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vanguard-retention-')), s = new Store(':memory:');
    const saved = [config.backupRecent, config.backupDaily, config.backupWeekly];
    config.backupRecent = 1;
    config.backupDaily = 1;
    config.backupWeekly = 1;
    try {
        const backups = new DatabaseBackups(s, join(dir, 'backups')), old = await backups.create(), latest = await backups.create();
        s.run('UPDATE database_backups SET at=? WHERE id=?', 0, old.id);
        await backups.retain();
        assert.equal(s.get('SELECT status FROM database_backups WHERE id=?', old.id)?.status, 'expired');
        assert.equal(s.get('SELECT status FROM database_backups WHERE id=?', latest.id)?.status, 'verified');
        const file = join(dir, 'blocked');
        writeFileSync(file, 'x');
        let alerted = false;
        const failing = new DatabaseBackups(s, file);
        failing.onFailure = async () => {
            alerted = true;
        };
        await assert.rejects(failing.create());
        assert.equal(alerted, true);
        assert.equal(s.health().backup_failures, 1);
    } finally {
        [config.backupRecent, config.backupDaily, config.backupWeekly] = saved as [number, number, number];
        s.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('guild departure retains configuration and rejoin clears retention state', () => {
    const s = new Store(':memory:');
    authorize(s);
    const settings = s.settings('g');
    settings.minAge = 33;
    s.save(settings);
    s.markGuild('g', 'Guild', false, 100);
    assert.equal(s.get('SELECT active FROM guild_data WHERE guild_id=?', 'g')?.active, 0);
    assert.equal(s.settings('g').minAge, 33);
    s.markGuild('g', 'Guild renamed', true, 200);
    assert.equal(s.get('SELECT retention_until FROM guild_data WHERE guild_id=?', 'g')?.retention_until, null);
    assert.equal(s.settings('g').minAge, 33);
    s.close();
});

test('real protection statistics deduplicate Discord/Roblox users and exclude unprotected guilds', () => {
    const s = new Store(':memory:');
    for (const id of ['a', 'b', 'off']) {
        authorize(s, id);
        const state = s.settings(id);
        state.enabled = id !== 'off';
        s.save(state);
    }
    s.run('INSERT INTO links VALUES(?,?,?,?,?)', 'a', 'u1', 'r1', 'name', 0);
    s.run('INSERT INTO links VALUES(?,?,?,?,?)', 'b', 'u2', 'r1', 'name', 0);
    const g = (id: string, ids: string[], total = ids.length) => ({ id, memberCount: total, members: { cache: new Collection(ids.map(id => [id, { id }])) } });
    const client: any = { guilds: { cache: new Collection([['a', g('a', ['u1', 'shared'])], ['b', g('b', ['u2', 'shared'])], ['off', g('off', ['irrelevant'])]]) } };
    const stats = new ProtectionStats(client, s);
    assert.deepEqual({ ...stats.get(), refreshedAt: 0 }, { guilds: 2, users: 3, robloxUsers: 1, complete: true, refreshedAt: 0 });
    client.guilds.cache.get('b').memberCount = 100;
    stats.invalidate();
    assert.equal(stats.get().complete, false);
    assert.equal(stats.get().users, 3);
    s.close();
});

test('anti-nuke rule editors are removed and legacy saved limits are ignored', async () => {
    const store = new Store(':memory:');
    authorize(store);
    const settings = store.settings('g');
    settings.rules.mass_ban = { count: 10, seconds: 60, enabled: false };
    settings.ruleDefaults = { count: 50, seconds: 300 };
    store.save(settings);
    const registry = new Registry();
    await registry.load();
    assert.equal(registry.commands.has('1:antinuke-rule'), false);
    assert.equal(registry.components.some(c => c.prefix === 'ruleui:'), false);
    const state = store.settings('g');
    for (const rule of RULES) assert.deepEqual(overrideRule(rule, state.rules, state.ruleDefaults), rule);
    store.close();
});

test('role grants, feature switches, and command cooldown settings are enforced', async () => {
    const s = new Store(':memory:');
    authorize(s);
    s.run('INSERT INTO permission_roles VALUES(?,?,?,?)', 'g', 'staff', 'admin', user);
    const member: any = { id: 'person', guild: { id: 'g', ownerId: 'owner' }, roles: { cache: new Collection([['staff', {}]]) }, permissions: new PermissionsBitField() };
    const guard = new Guard(s);
    assert.equal(guard.allowed({ ...defaults, access: 'security' }, 'g', 'person', member), true);
    assert.equal(guard.allowed({ ...defaults, access: 'owner' }, 'g', 'person', member), false);
    s.run('INSERT INTO feature_settings VALUES(?,?,?)', 'g', 'moderation', 0);
    const i: any = { inCachedGuild: () => true, guildId: 'g', user: { id: 'person' }, member, guild: { id: 'g', members: { me: { permissions: new PermissionsBitField() } } } };
    await assert.rejects(guard.check(i, { ...defaults, category: 'moderation', access: 'security' }, 'moderation/ban'), /disabled/);
    s.close();
});

test('server information spans four valid pages and bot information uses configured Discord identity', () => {
    const s = new Store(':memory:');
    authorize(s);
    const members = new Collection([['u', { user: { bot: false } }]]);
    const guild: any = { id: 'g', name: 'Guild', ownerId: user, createdTimestamp: Date.now(), memberCount: 1, premiumTier: 0, premiumSubscriptionCount: 0, preferredLocale: 'en-US', verificationLevel: 0, explicitContentFilter: 0, afkTimeout: 300, afkChannelId: null, rulesChannelId: null, systemChannelId: null, features: [], roles: { cache: new Collection() }, channels: { cache: new Collection() }, members: { cache: members, me: { joinedTimestamp: Date.now() } }, emojis: { cache: new Collection() }, stickers: { cache: new Collection() } };
    const client: any = { guilds: { cache: new Collection([['g', guild]]) }, isReady: () => true, user: { displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' }, options: { intents: new IntentsBitField(0) } };
    const ctx: any = { store: s, client, registry: { commands: new Map() } };
    for (let p = 0; p < 4; p++) {
        const page = serverInfo(ctx, guild, user, p);
        assert.ok(page.embeds[0]!.toJSON().fields!.length);
        assert.equal(page.components[0]!.toJSON().components.length, 2);
    }
    const owner = config.ownerId;
    try {
        config.ownerId = '333333333333333333';
        assert.match(botInfo(ctx).toJSON().fields![0]!.value, /333333333333333333/);
        config.ownerId = '';
        assert.equal(botInfo(ctx).toJSON().fields![0]!.value, 'Owner not configured.');
    } finally { config.ownerId = owner; s.close(); }
});

test('offline restore verifies backup, requires confirmation, and restores prior guild configuration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vanguard-offline-')), path = join(dir, 'live.db'), directory = join(dir, 'backups');
    let s: Store | undefined = new Store(path);
    authorize(s);
    try {
        const before = s.settings('g');
        before.minAge = 44;
        s.save(before);
        const b = await new DatabaseBackups(s, directory).create();
        before.minAge = 99;
        s.save(before);
        s.close();
        s = undefined;
        const env = { ...process.env, DATABASE_PATH: path, DATABASE_BACKUP_DIRECTORY: directory };
        const rejected = spawnSync(process.execPath, ['scripts/restore-database.mjs', '--id', b.id], { env, encoding: 'utf8' });
        assert.notEqual(rejected.status, 0);
        const restored = spawnSync(process.execPath, ['scripts/restore-database.mjs', '--id', b.id, '--confirm', `RESTORE-${b.id}`], { env, encoding: 'utf8' });
        assert.equal(restored.status, 0, restored.stderr);
        s = new Store(path);
        assert.equal(s.settings('g').minAge, 44);
    } finally {
        s?.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('configuration rollback requires confirmation, verified backup, and keeps its own audit history', async () => {
    const store = new Store(':memory:');
    authorize(store);
    const state = store.settings('g');
    state.minAge = 24;
    store.save(state, user);
    const entry = store.get("SELECT * FROM configuration_history WHERE guild_id=? AND component='settings' ORDER BY id DESC LIMIT 1", 'g')!;
    const registry = new Registry();
    registerHistory(registry);
    let backups = 0;
    const ctx: any = { store, confirmations: new Map(), logs: { push: () => { } }, assertActive: () => store.assertAuthorized('g'), databaseBackups: { create: async () => {
                backups++;
                throw Error('backup failed');
            } } };
    const i: any = { guildId: 'g', guild: { roles: { fetch: async () => null } }, user: { id: user }, editReply: async () => { } };
    await previewHistory(ctx, i, entry.id);
    let key = [...ctx.confirmations.keys()][0];
    const control = registry.components[0]!;
    await assert.rejects(control.execute(ctx, { ...i, customId: `history:apply:${key}` }), /backup failed/);
    assert.equal(store.settings('g').minAge, 24);
    ctx.databaseBackups.create = async () => {
        backups++;
    };
    await previewHistory(ctx, i, entry.id);
    key = [...ctx.confirmations.keys()][0];
    await control.execute(ctx, { ...i, customId: `history:apply:${key}` });
    assert.equal(store.settings('g').minAge, 7);
    assert.equal(backups, 2);
    assert.equal(store.get("SELECT COUNT(*) AS n FROM configuration_history WHERE guild_id=? AND component='settings'", 'g')?.n, 2);
    store.close();
});

test('configured command cooldown applies to guarded actions', async () => {
    const store = new Store(':memory:');
    authorize(store);
    store.run('INSERT INTO command_settings VALUES(?,?,?,?)', 'g', 'snapshot', 1, 10000);
    const actor: any = { id: 'owner', guild: { id: 'g', ownerId: 'owner' }, roles: { cache: new Collection() }, permissions: new PermissionsBitField() };
    const i: any = { inCachedGuild: () => true, guildId: 'g', user: { id: 'owner' }, member: actor, guild: { members: { me: { permissions: new PermissionsBitField() } } } };
    const guard = new Guard(store);
    await guard.check(i, { ...defaults, access: 'security' }, 'snapshot/create');
    await assert.rejects(guard.check(i, { ...defaults, access: 'security' }, 'snapshot/create'), /Wait 10 seconds/);
    store.close();
});
