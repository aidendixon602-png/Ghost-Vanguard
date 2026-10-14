import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Store } from '../src/database/db.js';
import { applyRestore, planRestore, planSummary, readBackup } from '../src/database/settings-restore.js';
import { authorize } from './helpers.js';

test('restore settings: lost ones come back, newer ones win, removed whitelist entries stay removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vg-rs-'));
    try {
        // The old database, before the data loss.
        const old = new Store(join(dir, 'old.db')); authorize(old, 'g'); authorize(old, 'gone');
        old.grant('g', 'admin1', 'trust', 'owner');
        old.grant('g', 'mod1', 'trust:mass_ban', 'owner');
        old.grant('g', 'removedLater', 'trust', 'owner');
        old.grant('g', 'expired', 'trust', 'owner', 1);
        old.run("UPDATE grants SET expires=? WHERE user_id='expired'", Date.now() - 1000);
        old.run("INSERT INTO staff_roles(guild_id,role_id,level,by_id,at) VALUES('g','modrole','moderator','owner',1)");
        old.run("INSERT INTO staff_roles(guild_id,role_id,level,by_id,at) VALUES('g','changedrole','admin','owner',1)");
        old.run("INSERT INTO autoreact_users(guild_id,user_id,emoji,by_id,at) VALUES('g','goat','🐐','dev',1)");
        old.grant('gone', 'x', 'trust', 'owner');
        old.run("UPDATE configuration_history SET at=?", Date.now() - 3600000);
        old.close();
        const gz = gzipSync(readFileSync(join(dir, 'old.db')));

        // The live database after the loss, with some newer changes.
        const live = new Store(join(dir, 'live.db')); authorize(live, 'g');
        live.run("INSERT INTO staff_roles(guild_id,role_id,level,by_id,at) VALUES('g','changedrole','helper','owner',2)");
        live.grant('g', 'removedLater', 'trust', 'owner'); live.revokeGrant('g', 'removedLater', 'trust', 'owner');
        live.grant('g', 'newadmin', 'trust', 'owner');

        const src = readBackup(gz);
        let plan;
        try { plan = planRestore(live, src.db); } finally { src.close(); }
        const summary = planSummary(plan);
        assert.equal(summary.total, 4, 'admin1, mod1, modrole and the goat react');
        assert.match(summary.text, /2 whitelist entries, 1 staff ranks, 1 auto-react users/);
        assert.match(summary.text, /1 whitelist entry was changed or removed since the backup/);
        assert.match(summary.text, /1 expired whitelist entry skipped/);
        assert.match(summary.text, /1 server\(s\) in the backup are not authorized now/);

        assert.equal(applyRestore(live, plan, 'dev'), 4);
        assert.ok(live.hasGrant('g', 'admin1', 'trust'));
        assert.ok(live.hasGrant('g', 'mod1', 'trust:mass_ban'));
        assert.ok(!live.hasGrant('g', 'removedLater', 'trust'), 'removed on purpose after the backup: stays removed');
        assert.ok(!live.hasGrant('g', 'expired', 'trust'));
        assert.ok(live.hasGrant('g', 'newadmin', 'trust'), 'newer entries untouched');
        assert.equal(live.get("SELECT level FROM staff_roles WHERE role_id='changedrole'")!.level, 'helper', 'the current value wins');
        assert.equal(live.get("SELECT emoji FROM autoreact_users WHERE user_id='goat'")!.emoji, '🐐');
        assert.equal(live.get("SELECT 1 AS x FROM grants WHERE guild_id='gone'"), undefined, 'servers not authorized now are skipped');

        const again = readBackup(gz);
        try { assert.equal(planSummary(planRestore(live, again.db)).total, 0, 'running it twice adds nothing'); } finally { again.close(); }
        live.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('restore settings rejects files that are not Vanguard databases', () => {
    assert.throws(() => readBackup(Buffer.from('hello')), /not a database file/);
    assert.throws(() => readBackup(Buffer.from([0x1f, 0x8b, 1, 2, 3])), /could not be unpacked/);
});
