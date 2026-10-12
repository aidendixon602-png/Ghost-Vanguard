import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, statSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { VERSION } from '../config.js';
import { createHash, randomUUID } from 'node:crypto';

export const DB_VERSION = 3;

export function verifiedMigrationBackup(db: DatabaseSync, path: string) {
    if (path === ':memory:' || !existsSync(path) || statSync(path).size === 0 || Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0) >= DB_VERSION)
        return null;
    const directory = join(dirname(path), 'database-backups');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, `migration-${Date.now()}-${randomUUID()}.db`);
    db.prepare('VACUUM INTO ?').run(file);
    const check = new DatabaseSync(file, { readOnly: true });
    try {
        if (check.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
            throw Error('Pre-migration backup failed integrity verification.');
    } finally {
        check.close();
    }
    chmodSync(file, 0o600);
    const metadata = { id: randomUUID(), createdAt: Date.now(), path: file, kind: 'migration', size: statSync(file).size, checksum: createHash('sha256').update(readFileSync(file)).digest('hex'), verified: true, databaseVersion: Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0), status: 'verified', botVersion: VERSION };
    writeFileSync(file + '.json', JSON.stringify(metadata, null, 2), { mode: 0o600 });
    return metadata;
}

export function normalizeDatabase(db: DatabaseSync) {
    if (Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0) >= DB_VERSION)
        return;
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
    try {
        db.exec(`CREATE TABLE IF NOT EXISTS guild_data (
          guild_id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
          inactive_at INTEGER, retention_until INTEGER, last_sync INTEGER, last_backup INTEGER,
          config_version INTEGER NOT NULL DEFAULT 3);
        CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, at INTEGER NOT NULL, status TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS guild_config (
          guild_id TEXT PRIMARY KEY REFERENCES guild_data(guild_id) ON DELETE CASCADE,
          enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), mode TEXT NOT NULL DEFAULT 'observe' CHECK(mode IN ('observe','enforce')),
          log_channel_id TEXT, quarantine_role_id TEXT, verified_role_id TEXT, min_age INTEGER NOT NULL DEFAULT 7 CHECK(min_age BETWEEN 0 AND 3650),
          revoke_on_unlink INTEGER NOT NULL DEFAULT 1 CHECK(revoke_on_unlink IN (0,1)), sync_on_join INTEGER NOT NULL DEFAULT 1 CHECK(sync_on_join IN (0,1)),
          block_banned INTEGER NOT NULL DEFAULT 1 CHECK(block_banned IN (0,1)), nickname INTEGER NOT NULL DEFAULT 1 CHECK(nickname IN (0,1)));
        CREATE TABLE IF NOT EXISTS antinuke_rules (
          guild_id TEXT REFERENCES guild_data(guild_id) ON DELETE CASCADE, rule TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), count INTEGER NOT NULL CHECK(count BETWEEN 1 AND 100),
          seconds INTEGER NOT NULL CHECK(seconds BETWEEN 1 AND 300), PRIMARY KEY(guild_id,rule));
        CREATE TABLE IF NOT EXISTS provider_config (
          guild_id TEXT REFERENCES guild_data(guild_id) ON DELETE CASCADE, provider TEXT CHECK(provider IN ('rover','bloxlink')),
          enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), PRIMARY KEY(guild_id,provider));
        CREATE TABLE IF NOT EXISTS permission_roles (
          guild_id TEXT REFERENCES guild_data(guild_id) ON DELETE CASCADE, role_id TEXT NOT NULL, access TEXT NOT NULL CHECK(access IN ('admin','moderator')),
          by_id TEXT NOT NULL, PRIMARY KEY(guild_id,role_id));
        CREATE TABLE IF NOT EXISTS command_settings (
          guild_id TEXT REFERENCES guild_data(guild_id) ON DELETE CASCADE, command TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), cooldown_ms INTEGER NOT NULL DEFAULT 1500 CHECK(cooldown_ms BETWEEN 0 AND 3600000), PRIMARY KEY(guild_id,command));
        CREATE TABLE IF NOT EXISTS feature_settings (
          guild_id TEXT REFERENCES guild_data(guild_id) ON DELETE CASCADE, feature TEXT NOT NULL CHECK(feature IN ('moderation','verification','ai','snapshots')),
          enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), PRIMARY KEY(guild_id,feature));
        CREATE TABLE IF NOT EXISTS backup_config (
          guild_id TEXT PRIMARY KEY REFERENCES guild_data(guild_id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
          interval_hours INTEGER NOT NULL DEFAULT 24 CHECK(interval_hours BETWEEN 1 AND 168), retention_count INTEGER NOT NULL DEFAULT 30 CHECK(retention_count BETWEEN 1 AND 1000), last_at INTEGER);
        CREATE TABLE IF NOT EXISTS configuration_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL REFERENCES guild_data(guild_id) ON DELETE CASCADE,
          component TEXT NOT NULL, actor_id TEXT NOT NULL, at INTEGER NOT NULL, before_json TEXT, after_json TEXT);
        CREATE INDEX IF NOT EXISTS history_guild ON configuration_history(guild_id,id);
        CREATE TABLE IF NOT EXISTS database_backups (
          id TEXT PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
          database_version INTEGER NOT NULL, bot_version TEXT NOT NULL, size INTEGER, checksum TEXT,
          status TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0, expires INTEGER, error TEXT);
        CREATE TABLE IF NOT EXISTS database_health (id INTEGER PRIMARY KEY CHECK(id=1), checked_at INTEGER, status TEXT, query_failures INTEGER NOT NULL DEFAULT 0, backup_failures INTEGER NOT NULL DEFAULT 0, migration_failures INTEGER NOT NULL DEFAULT 0, last_backup INTEGER);`);
        const scoped = ['grants', 'observations', 'incidents', 'backups', 'cases', 'links', 'blocked_accounts', 'snapshots', 'snapshot_metadata', 'recovery_events', 'recovery_mappings', 'recovery_history', 'outbox', 'guild_authorization', 'server_bans', 'authorization_events'];
        for (const table of scoped) {
            const column = table === 'recovery_mappings' ? 'destination_guild' : 'guild_id';
            db.exec(`INSERT OR IGNORE INTO guild_data(guild_id) SELECT DISTINCT ${column} FROM ${table} WHERE ${column} IS NOT NULL;`);
        }
        const legacy = db.prepare('SELECT guild_id,json FROM settings').all();
        const configInsert = db.prepare('INSERT OR REPLACE INTO guild_config VALUES(?,?,?,?,?,?,?,?,?,?,?)');
        for (const row of legacy) {
            const s = JSON.parse(String(row.json)), id = String(row.guild_id);
            db.prepare('INSERT OR IGNORE INTO guild_data(guild_id) VALUES(?)').run(id);
            configInsert.run(id, Number(!!s.enabled), s.mode ?? 'observe', s.logChannelId ?? null, s.quarantineRoleId ?? null, s.verifiedRoleId ?? null, s.minAge ?? 7, Number(s.revokeOnUnlink !== false), Number(s.syncOnJoin !== false), Number(s.blockBanned !== false), Number(s.nickname !== false));
            for (const [key, r] of Object.entries(s.rules ?? {}) as [string, any][])
                db.prepare('INSERT OR REPLACE INTO antinuke_rules VALUES(?,?,?,?,?)').run(id, key, Number(r.enabled !== false), r.count, r.seconds);
        }
        // Rebuild existing tables with real guild foreign keys; retain all original columns/indexes.
        for (const table of scoped) {
            const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)!;
            const column = table === 'recovery_mappings' ? 'destination_guild' : 'guild_id';
            const original = String(row.sql);
            if (original.includes(`REFERENCES guild_data`))
                continue;
            const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(table);
            const name = `migration_${table}`;
            const schema = original.replace(new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?["\\x60]?${table}["\\x60]?`, 'i'), `CREATE TABLE ${name}`).replace(new RegExp(`\\b${column} TEXT(?! REFERENCES)`, 'i'), `${column} TEXT REFERENCES guild_data(guild_id) ON DELETE CASCADE`);
            db.exec(schema);
            db.exec(`INSERT INTO ${name} SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${name} RENAME TO ${table};`);
            for (const index of indexes)
                db.exec(String(index.sql));
        }
        db.exec("DROP TABLE settings; UPDATE guild_data SET name=COALESCE((SELECT name FROM guild_authorization a WHERE a.guild_id=guild_data.guild_id),name); INSERT OR REPLACE INTO schema_migrations VALUES(3,strftime('%s','now')*1000,'complete'); PRAGMA user_version=3;");
        if (db.prepare('PRAGMA foreign_key_check').all().length)
            throw Error('Migration foreign-key validation failed.');
        db.exec('COMMIT; PRAGMA foreign_keys=ON;');
    } catch (error) {
        db.exec('ROLLBACK; PRAGMA foreign_keys=ON;');
        throw error;
    }
}
