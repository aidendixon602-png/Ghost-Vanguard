import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Collection } from 'discord.js';
import { Store } from '../src/database/db.js';
import { DatabaseBackups } from '../src/database/database-backups.js';
import { getFeature, setFeature } from '../src/features/settings.js';
import { LOCK_SCHEDULE_DEFAULTS, runSchedules, SCHEDULE_REASON } from '../src/features/schedules.js';
import { TEXT_LOCK } from '../src/security/lockdown.js';
import roblox from '../src/commands/roblox/roblox.js';
import { authorize } from './helpers.js';

for (const failure of ['lock acquisition', 'before recording'] as const)
test(`scheduled lockdown retries after failure ${failure}`, async () => {
    const store = new Store(':memory:'); authorize(store);
    try {
        setFeature(store, 'g', 'lockschedule', LOCK_SCHEDULE_DEFAULTS, { enabled: true });
        let attempts = 0;
        const guild: any = { id: 'g', ownerId: 'owner', client: { user: { id: 'bot' } },
            members: { cache: new Collection() }, channels: { cache: new Collection() } };
        if (failure === 'before recording') Object.defineProperty(guild.channels, 'cache', { configurable: true, get: () => { throw Error('channel cache unavailable'); } });
        const d: any = { store, logs: { push: () => {} }, ready: () => true,
            client: { user: { id: 'bot' }, guilds: { cache: new Collection([['g', guild]]) } },
            locks: { busy: () => false, run: async (_ids: string[], fn: () => Promise<unknown>) => { attempts++; if (attempts === 1 && failure === 'lock acquisition') throw Error('busy'); return fn(); } } };
        const now = Date.UTC(2026, 0, 1, 1);
        await runSchedules(d, now);
        assert.equal(getFeature(store, 'g', 'lockschedule', LOCK_SCHEDULE_DEFAULTS).lockedBySchedule, false);
        Object.defineProperty(guild.channels, 'cache', { value: new Collection() });
        await runSchedules(d, now + 60000);
        assert.equal(attempts, 2);
        assert.equal(store.get("SELECT reason FROM lockdowns WHERE guild_id='g'")?.reason, SCHEDULE_REASON);
        assert.equal(getFeature(store, 'g', 'lockschedule', LOCK_SCHEDULE_DEFAULTS).lockedBySchedule, true);
    } finally { store.close(); }
});

test('quiet hours retain ownership and retry channels that fail to unlock', async () => {
    const store = new Store(':memory:'); authorize(store);
    try {
        setFeature(store, 'g', 'lockschedule', LOCK_SCHEDULE_DEFAULTS, { enabled: true, lockedBySchedule: true });
        store.run('INSERT INTO lockdowns(guild_id,started_by,started_at,reason,message) VALUES(?,?,?,?,?)', 'g', 'bot', 1, SCHEDULE_REASON, 'quiet hours');
        store.run('INSERT INTO lockdown_overwrites VALUES(?,?,?,?,?,?,?,?)', 'g', 'channel', 'g', 0, 0, '0', '0', String(TEXT_LOCK));
        let attempts = 0;
        const channel = { permissionOverwrites: { cache: new Collection([['g', { id: 'g', type: 0, allow: { bitfield: 0n }, deny: { bitfield: TEXT_LOCK } }]]),
            set: async () => { if (++attempts === 1) throw Error('Discord unavailable'); } } };
        const guild = { id: 'g', channels: { cache: new Collection([['channel', channel]]) } };
        const d: any = { store, logs: { push: () => {} }, ready: () => true,
            client: { user: { id: 'bot' }, guilds: { cache: new Collection([['g', guild]]) } }, locks: { busy: () => false, run: async (_ids: string[], fn: () => Promise<unknown>) => fn() } };
        const now = Date.UTC(2026, 0, 1, 12);
        await runSchedules(d, now);
        assert.equal(getFeature(store, 'g', 'lockschedule', LOCK_SCHEDULE_DEFAULTS).lockedBySchedule, true);
        assert.ok(store.get("SELECT 1 FROM lockdowns WHERE guild_id='g'"));
        await runSchedules(d, now + 60000);
        assert.equal(attempts, 2);
        assert.equal(getFeature(store, 'g', 'lockschedule', LOCK_SCHEDULE_DEFAULTS).lockedBySchedule, false);
        assert.equal(store.get("SELECT 1 FROM lockdowns WHERE guild_id='g'"), undefined);
    } finally { store.close(); }
});

test('enabling Roblox sharing excludes temporary bans and removes previously shared copies', async () => {
    const store = new Store(':memory:'); authorize(store); authorize(store, 'other');
    try {
        const temporary = '111111111111111111', permanent = '222222222222222222';
        store.run('INSERT INTO tempbans(guild_id,user_id,until,reason,moderator_id) VALUES(?,?,?,?,?)', 'g', temporary, Date.now() + 60000, 'temporary', 'owner');
        for (const [id, reason] of [['123', `Linked Discord account banned: ${temporary}`], ['456', `Linked Discord account banned: ${permanent}`], ['789', 'Manual blacklist']])
            store.run('INSERT INTO blocked_accounts VALUES(?,?,?)', 'g', id, reason);
        for (const guild of ['g', 'other']) store.run('INSERT INTO roblox_network(roblox_id,guild_id,reason,at,source_user) VALUES(?,?,?,?,?)', '123', guild, 'Banned member', 1, temporary);
        const ctx: any = { store, logs: { push: () => {} } };
        const i: any = { guildId: 'g', user: { id: 'owner' }, client: { guilds: { cache: new Collection() } }, options: { getSubcommand: () => 'network', getBoolean: () => true } };
        await roblox.execute(ctx, i);
        assert.deepEqual(store.all("SELECT roblox_id FROM roblox_network WHERE guild_id='g' ORDER BY roblox_id").map(r => r.roblox_id), ['456', '789']);
        assert.ok(store.get("SELECT 1 FROM roblox_network WHERE guild_id='other' AND roblox_id='123'"), 'other server records are preserved');
        assert.ok(store.get("SELECT 1 FROM blocked_accounts WHERE guild_id='g' AND roblox_id='123'"), 'the temporary ban remains locally blocked');
    } finally { store.close(); }
});

for (const mode of ['missing', 'corrupt', 'running'] as const)
test(`manual database restore handles a ${mode} live database`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vg-manual-restore-'));
    const path = join(dir, 'live/vanguard.db'), directory = join(dir, 'backups');
    let store: Store | undefined;
    try {
        store = new Store(path); authorize(store);
        const settings = store.settings('g'); settings.minAge = 44; store.save(settings);
        const backup = await new DatabaseBackups(store, directory).create();
        if (mode === 'running') store.run("INSERT OR REPLACE INTO leases(name,owner,until) VALUES('bot','active',?)", Date.now() + 60000);
        store.close(); store = undefined;
        if (mode === 'missing') for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
        if (mode === 'corrupt') writeFileSync(path, 'corrupted database');
        const restore = (extra: string[] = []) => spawnSync(process.execPath, ['scripts/restore-database.mjs', '--id', backup.id, '--confirm', `RESTORE-${backup.id}`, ...extra], {
            encoding: 'utf8', env: { ...process.env, DATABASE_PATH: path, DATABASE_BACKUP_DIRECTORY: directory },
        });
        const result = restore();
        if (mode === 'running') {
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /still running/);
            assert.notEqual(restore(['--allow-corrupt']).status, 0, 'the corruption override never bypasses an active lease');
            return;
        }
        if (mode === 'corrupt') {
            assert.notEqual(result.status, 0, 'unreadable files still need an explicit override');
            const allowed = restore(['--allow-corrupt']);
            assert.equal(allowed.status, 0, allowed.stderr);
        } else assert.equal(result.status, 0, result.stderr);
        store = new Store(path);
        assert.equal(store.settings('g').minAge, 44);
        assert.equal(store.get("SELECT 1 FROM leases WHERE name='bot'"), undefined);
        if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
    } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});
