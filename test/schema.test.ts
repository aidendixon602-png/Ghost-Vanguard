import test from 'node:test';
import assert from 'node:assert/strict';
import { authorize } from './helpers.js';
import { Store, GUILD_SCOPED_TABLES, UNSCOPED_GUILD_TABLES } from '../src/database/db.js';

/**
 * The cross-guild guard is only as good as its table list. These tests read the live
 * schema, so adding a table with a guild column without registering it fails here
 * rather than leaking another guild's rows in production.
 */

function tablesWithGuildColumn(store: Store): string[] {
    const names = store.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map(r => String(r.name));
    return names.filter(name => store.all(`PRAGMA table_info(${name})`).some(c => ['guild_id', 'destination_guild'].includes(String(c.name))));
}

test('every table with a guild column is either scoped or explicitly exempt', () => {
    const store = new Store(':memory:');
    const known = new Set<string>([...GUILD_SCOPED_TABLES, ...UNSCOPED_GUILD_TABLES]);
    const unregistered = tablesWithGuildColumn(store).filter(name => !known.has(name));
    assert.deepEqual(unregistered, [],
        `These tables carry a guild column but are not in GUILD_SCOPED_TABLES or UNSCOPED_GUILD_TABLES in src/database/db.ts. Add them to one list or the other:\n  ${unregistered.join('\n  ')}`);
    store.close();
});

test('every scoped table actually exists and has its three triggers', () => {
    const store = new Store(':memory:');
    const triggers = new Set(store.all("SELECT name FROM sqlite_master WHERE type='trigger'").map(r => String(r.name)));
    const existing = new Set(store.all("SELECT name FROM sqlite_master WHERE type='table'").map(r => String(r.name)));
    for (const table of GUILD_SCOPED_TABLES) {
        assert.ok(existing.has(table), `${table} is listed as scoped but does not exist`);
        for (const action of ['insert', 'update', 'delete'])
            assert.ok(triggers.has(`scope_${table}_${action}`), `${table} is missing its ${action} scope trigger`);
    }
    store.close();
});

test('a read without a guild predicate is refused for every scoped table', () => {
    const store = new Store(':memory:');
    authorize(store, '111111111111111111');
    for (const table of GUILD_SCOPED_TABLES)
        assert.throws(
            () => store.readGuild('111111111111111111', () => store.all(`SELECT * FROM ${table} LIMIT 1`)),
            /Cross-guild or unscoped database read/, `${table} allowed an unscoped read`);
    store.close();
});

test('a read scoped to another guild is refused for every scoped table', () => {
    const store = new Store(':memory:');
    authorize(store, '111111111111111111');
    const column = (table: string) => table === 'recovery_mappings' ? 'destination_guild' : 'guild_id';
    for (const table of GUILD_SCOPED_TABLES)
        assert.throws(
            () => store.readGuild('111111111111111111', () => store.all(`SELECT * FROM ${table} WHERE ${column(table)}=?`, '999999999999999999')),
            /Cross-guild or unscoped database read/, `${table} allowed a read for another guild`);
    store.close();
});
