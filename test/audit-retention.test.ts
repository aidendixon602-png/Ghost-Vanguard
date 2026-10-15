import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/database/db.js';
import { DatabaseBackups } from '../src/database/database-backups.js';
import { authorize } from './helpers.js';

test('inactive guild retention removes newer operational tables while preserving active guild data and authorization', async () => {
    const store = new Store(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'vg-retention-'));
    try {
        for (const guild of ['inactive', 'active']) {
            authorize(store, guild);
            store.save(store.settings(guild));
            store.run("INSERT INTO staff_roles(guild_id,role_id,level) VALUES(?,?,'admin')", guild, 'staff');
            store.run('INSERT INTO member_notes(guild_id,user_id,author_id,text,at) VALUES(?,?,?,?,?)', guild, 'u', 'a', 'private note', 1);
            store.run('INSERT INTO tempbans VALUES(?,?,?,?,?,?)', guild, 'u', 100, 'a', 'reason', 1);
            store.run('INSERT INTO left_roles VALUES(?,?,?,?)', guild, 'u', '["staff"]', 1);
            store.run('INSERT INTO scam_config VALUES(?,1,0)', guild);
            store.run('INSERT INTO scam_domains VALUES(?,?)', guild, 'bad.example');
        }
        store.markGuild('inactive', 'Inactive', false, 1);
        const due = Number(store.get('SELECT retention_until FROM guild_data WHERE guild_id=?', 'inactive')!.retention_until);
        await new DatabaseBackups(store, dir).purgeInactive(due + 1);
        for (const table of ['staff_roles', 'member_notes', 'tempbans', 'left_roles', 'scam_config', 'scam_domains']) {
            assert.equal(store.get(`SELECT COUNT(*) AS n FROM ${table} WHERE guild_id=?`, 'inactive')!.n, 0, table);
            assert.equal(store.get(`SELECT COUNT(*) AS n FROM ${table} WHERE guild_id=?`, 'active')!.n, 1, table);
        }
        assert.equal(store.isAuthorized('inactive'), true, 'authorization records survive operational retention');
        assert.equal(store.get("SELECT COUNT(*) AS n FROM database_backups WHERE status='verified'")!.n, 1);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
