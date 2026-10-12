import { authorize } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/database/db.js';

test('new servers default unauthorized, disabled, observe, with strict verification settings', () => {
    const s = new Store(':memory:');
    const state = s.settings('guild');
    assert.equal(state.authorized, false);
    assert.equal(state.enabled, false);
    assert.equal(state.mode, 'observe');
    assert.equal(state.minAge, 7);
    assert.equal(state.revokeOnUnlink, true);
    assert.equal(state.blockBanned, true);
    s.close();
});

test('settings survive reopening the real SQLite database and stay guild scoped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vanguard-test-')), path = join(dir, 'bot.db');
    try {
        const a = new Store(path);
        authorize(a, 'a');
        const settings = a.settings('a');
        settings.authorized = true;
        a.save(settings);
        a.close();
        const b = new Store(path);
        assert.equal(b.settings('a').authorized, true);
        assert.equal(b.settings('b').authorized, false);
        b.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('security admin access does not create anti-nuke bypass', () => {
    const s = new Store(':memory:');
    s.grant('g', 'u', 'admin', 'owner');
    assert.equal(s.hasGrant('g', 'u', 'admin'), true);
    assert.equal(s.hasGrant('g', 'u', 'trust'), false);
    assert.equal(s.hasGrant('other', 'u', 'admin'), false);
    s.close();
});

test('temporary trust expires and cleanup removes expired grants', () => {
    const s = new Store(':memory:');
    s.grant('g', 'u', 'trust', 'owner', 1);
    assert.equal(s.hasGrant('g', 'u', 'trust', Date.now() + 2 * 3600000), false);
    s.cleanup(Date.now() + 2 * 3600000);
    assert.equal(s.all('SELECT * FROM grants').length, 0);
    s.close();
});

test('audit observations deduplicate by event ID and count per actor, guild, rule and time', () => {
    const s = new Store(':memory:');
    assert.equal(s.observe('1', 'g', 'u', 'mass_ban', 'x', 1000), true);
    assert.equal(s.observe('1', 'g', 'u', 'mass_ban', 'x', 1000), false);
    s.observe('2', 'g', 'v', 'mass_ban', 'x', 1000);
    s.observe('3', 'other', 'u', 'mass_ban', 'x', 1000);
    s.observe('4', 'g', 'u', 'role_delete', 'x', 1000);
    assert.equal(s.count('g', 'u', 'mass_ban', 900), 1);
    assert.equal(s.count('g', 'u', 'mass_ban', 1001), 0);
    s.close();
});

test('process lease excludes concurrent instances and permits expired takeover', () => {
    const s = new Store(':memory:');
    assert.equal(s.acquireLease('bot', 'a', 0), true);
    assert.equal(s.acquireLease('bot', 'b', 1), false);
    assert.equal(s.acquireLease('bot', 'a', 100), true);
    assert.equal(s.acquireLease('bot', 'b', 30101), true);
    assert.equal(s.acquireLease('bot', 'a', 30102), false);
    s.close();
});

test('cleanup preserves recovery snapshots and rollback backups per guild', () => {
    const s = new Store(':memory:');
    for (let n = 0; n < 12; n++)
        s.run('INSERT INTO snapshots(guild_id,by_id,at,json) VALUES(?,?,?,?)', 'g', 'u', n, '{}');
    s.run('INSERT INTO snapshots(guild_id,by_id,at,json) VALUES(?,?,?,?)', 'other', 'u', 1, '{}');
    s.cleanup();
    assert.equal(s.all('SELECT * FROM snapshots WHERE guild_id=?', 'g').length, 12);
    assert.equal(s.all('SELECT * FROM snapshots WHERE guild_id=?', 'other').length, 1);
    s.close();
});
