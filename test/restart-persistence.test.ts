import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorize } from './helpers.js';
import { Store } from '../src/database/db.js';
import { configureEventLog, eventLogConfig } from '../src/audit/event-log.js';
import { logChannels, setLogChannels } from '../src/audit/log-setup.js';
import { getFeature, setFeature } from '../src/features/settings.js';
import { raidState, setRaidMode } from '../src/security/raidmode.js';
import { newAccountConfig, setNewAccountConfig } from '../src/security/new-accounts.js';
import { createRecord, latestRecord } from '../src/audit/ban-log.js';
import { createBan, activeBan } from '../src/security/network-ban.js';

/**
 * Everything staff set up with a command must still be there after the bot restarts (a new
 * process opening the same database file). One test per area people rely on.
 */
const G = '500000000000000001', OWNER = '111111111111111111', U = '400000000000000001', ROLE = '900000000000000001';

test('every saved setting survives a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv-restart-'));
    const file = join(dir, 'vanguard.db');
    let store = new Store(file);
    authorize(store, G);
    await store.withAuthorized(G, async () => {
        // Anti-nuke: on/off choice, whitelist (full, per-rule, role), verification bot
        store.setAntinukeStaffDisabled(G, true);
        store.grant(G, U, 'trust', OWNER); store.grant(G, U, 'trust:mass_ban', OWNER); store.grant(G, ROLE, 'trust_role', OWNER); store.grant(G, '600000000000000001', 'bot', OWNER);
        // Server settings: log and quarantine channels
        const s = store.settings(G); s.logChannelId = '700000000000000001'; s.quarantineRoleId = '700000000000000002'; store.save(s, OWNER);
        // Staff ranks, permission roles, /role rules
        store.run("INSERT INTO staff_roles(guild_id,role_id,level) VALUES(?,?,'admin')", G, ROLE);
        store.run("INSERT INTO role_rules(guild_id,role_id,kind,by_id,at) VALUES(?,?,'allow',?,?)", G, ROLE, OWNER, 1);
        // Logging
        configureEventLog(store, G, { enabled: true, channelId: '700000000000000003', category: ['messages', false] });
        setLogChannels(store, G, { bansChannelId: '700000000000000004', excludedChannels: ['700000000000000005'], ignoreBotRoutine: false }, OWNER);
        // Feature settings (automod, welcome, appeals, warnings, report...) all use the same store
        setFeature(store, G, 'automod', { spam: false }, { spam: true }, OWNER);
        setFeature(store, G, 'welcome', { enabled: false, channelId: null as string | null }, { enabled: true, channelId: '700000000000000006' }, OWNER);
        // Raid mode and new-account rule
        setRaidMode(store, G, true, OWNER, { minAgeDays: 14, action: 'timeout', hours: 48 });
        setNewAccountConfig(store, G, OWNER, { minAgeDays: 30, action: 'kick' });
        // Command and feature switches
        store.run('INSERT INTO command_settings(guild_id,command,enabled,cooldown_ms) VALUES(?,?,?,?)', G, 'ask', 0, 9000);
        // Records: cases, notes, ban log, genreban
        store.recordCase(G, U, OWNER, 'ban', 'raid');
        store.run('INSERT INTO member_notes(guild_id,user_id,author_id,text,at) VALUES(?,?,?,?,?)', G, U, OWNER, 'watch', 1);
        createRecord(store, G, { id: U, tag: 'raider' }, { kind: 'ban', reason: 'raid', evidence: null, moderatorId: OWNER, moderatorRole: 'via-bot', approved: null, duration: 'Permanent', expiresAt: null });
    });
    createBan(store, { kind: 'hardban', user: { id: U, tag: 'raider' } as any, reason: 'threats', moderator: { id: OWNER, tag: 'dev' } as any });
    store.run("INSERT INTO bot_staff(user_id,level,by_id,at) VALUES(?,?,?,?)", '300000000000000001', 'overseer', OWNER, 1);
    store.close();

    // ---- restart ----
    store = new Store(file);
    try {
        await store.withAuthorized(G, async () => {
            assert.equal(store.antinukeStaffDisabled(G), true, 'anti-nuke off choice');
            assert.equal(store.hasGrant(G, U, 'trust'), true, 'whitelisted user');
            assert.equal(store.hasGrant(G, U, 'trust:mass_ban'), true, 'per-rule whitelist');
            assert.equal(store.hasGrant(G, ROLE, 'trust_role'), true, 'whitelisted role');
            assert.equal(store.hasGrant(G, '600000000000000001', 'bot'), true, 'verification bot');
            assert.deepEqual([store.settings(G).logChannelId, store.settings(G).quarantineRoleId], ['700000000000000001', '700000000000000002']);
            assert.equal(store.get('SELECT level FROM staff_roles WHERE guild_id=? AND role_id=?', G, ROLE)?.level, 'admin', 'staff rank role');
            assert.ok(store.get("SELECT 1 FROM role_rules WHERE guild_id=? AND role_id=? AND kind='allow'", G, ROLE), '/role allow list');
            const ev = eventLogConfig(store, G);
            assert.deepEqual([ev.enabled, ev.channelId, ev.categories.has('messages')], [true, '700000000000000003', false], 'event logging');
            assert.deepEqual(logChannels(store, G), { bansChannelId: '700000000000000004', excludedChannels: ['700000000000000005'], ignoreBotRoutine: false }, 'log channels');
            assert.equal(getFeature(store, G, 'automod', { spam: false }).spam, true, 'automod');
            assert.equal(getFeature(store, G, 'welcome', { enabled: false, channelId: null as string | null }).channelId, '700000000000000006', 'welcome');
            const raid = raidState(store, G);
            assert.deepEqual([raid.enabled, raid.minAgeDays, raid.action], [true, 14, 'timeout'], 'raid mode');
            assert.deepEqual([newAccountConfig(store, G).minAgeDays, newAccountConfig(store, G).action], [30, 'kick'], 'new-account rule');
            assert.deepEqual({ ...store.get('SELECT enabled, cooldown_ms FROM command_settings WHERE guild_id=? AND command=?', G, 'ask') }, { enabled: 0, cooldown_ms: 9000 }, 'command switch');
            assert.equal(store.get('SELECT COUNT(*) AS n FROM cases WHERE guild_id=?', G)?.n, 1, 'cases');
            assert.equal(store.get('SELECT COUNT(*) AS n FROM member_notes WHERE guild_id=?', G)?.n, 1, 'notes');
            assert.equal(latestRecord(store, G, U)?.reason, 'raid', 'ban log');
        });
        assert.equal(activeBan(store, 'hardban', U)?.reason, 'threats', 'hardban');
        assert.equal((store.db.prepare('SELECT level FROM bot_staff WHERE user_id=?').get('300000000000000001') as any)?.level, 'overseer', 'bot-wide rank');
        assert.equal(store.isAuthorized(G), true, 'server authorization');
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
