import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { statSync } from 'node:fs';
import { verifiedMigrationBackup, normalizeDatabase } from './database-migrations.js';
import { config } from '../config.js';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError, redact } from '../errors.js';
/**
 * Every table holding per-guild rows. Scope triggers and the cross-guild read check are
 * both built from this one list, and test/schema.test.ts fails if a table with a guild
 * column is missing from it, so a new table cannot quietly escape the guard.
 */
export const GUILD_SCOPED_TABLES = ['scam_config', 'scam_domains', 'scam_images', 'scam_exclusions', 'scam_events', 'antinuke_presets', 'antinuke_event_payloads', 'antiping_config', 'antiping_targets', 'antinuke_options', 'event_log_config', 'event_log', 'lockdowns', 'lockdown_overwrites', 'lockdown_notices', 'guild_config', 'antinuke_rules', 'antinuke_defaults', 'provider_config', 'permission_roles', 'command_settings', 'feature_settings', 'backup_config', 'configuration_history', 'grants', 'observations', 'incidents', 'backups', 'cases', 'links', 'blocked_accounts', 'snapshots', 'snapshot_metadata', 'recovery_mappings', 'recovery_history', 'outbox', 'member_notes', 'tempbans', 'raidmode', 'newaccount_config', 'staff_roles', 'guild_features', 'appeals', 'duty_sessions', 'autoreact_users', 'ban_records', 'role_rules'];
/** Tables carrying a guild column that are intentionally not scope-guarded. */
// roblox_network is shared on purpose: servers that opt in share their Roblox blacklist with each other.
export const UNSCOPED_GUILD_TABLES = ['guild_data', 'guild_authorization', 'server_bans', 'authorization_events', 'recovery_events', 'leases', 'roblox_network', 'network_partners', 'network_ban_results'];
const SCOPED_TABLE_PATTERN = new RegExp(`\\b(${[...GUILD_SCOPED_TABLES, 'recovery_events'].join('|')})\\b`, 'i');
export class Store {
    db;
    path;
    queryFailures = 0;
    transactions = 0;
    active = new AsyncLocalStorage();
    constructor(path) {
        if (path !== ':memory:')
            mkdirSync(dirname(path), { recursive: true });
        this.path = path;
        this.db = new DatabaseSync(path);
        const leaseUntil = () => this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='leases'").get()
            ? Number(this.db.prepare('SELECT until FROM leases WHERE name=?').get('bot')?.until ?? 0) : 0;
        // A run that was just stopped leaves its lease for up to 30s. Wait it out once; a live instance keeps renewing it.
        const first = leaseUntil();
        if (first > Date.now()) {
            const wait = Math.min(first - Date.now() + 1000, 35_000);
            console.log(`Waiting ${Math.ceil(wait / 1000)}s for the previous Vanguard run to release the database...`);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
        }
        if (leaseUntil() > Date.now()) {
            this.db.close();
            throw Error('Another Vanguard instance holds the database lease. Stop it before migrating.');
        }
        const migrationBackup = verifiedMigrationBackup(this.db, path);
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS settings (guild_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS grants (guild_id TEXT, user_id TEXT, kind TEXT, by_id TEXT, expires INTEGER,
        PRIMARY KEY(guild_id,user_id,kind));
      CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY, guild_id TEXT, actor_id TEXT, rule TEXT, target_id TEXT, at INTEGER);
      CREATE TABLE IF NOT EXISTS antinuke_event_payloads (guild_id TEXT NOT NULL REFERENCES guild_data(guild_id) ON DELETE CASCADE, id TEXT NOT NULL REFERENCES observations(id) ON DELETE CASCADE, json TEXT NOT NULL, PRIMARY KEY(guild_id,id));
      CREATE INDEX IF NOT EXISTS observations_window ON observations(guild_id,actor_id,rule,at);
      CREATE TABLE IF NOT EXISTS incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT, actor_id TEXT, rule TEXT, at INTEGER, mode TEXT, result TEXT);
      CREATE INDEX IF NOT EXISTS incident_window ON incidents(guild_id,actor_id,rule,at);
      CREATE TABLE IF NOT EXISTS backups (guild_id TEXT, user_id TEXT, roles TEXT, at INTEGER, active INTEGER DEFAULT 1, PRIMARY KEY(guild_id,user_id));
      CREATE TABLE IF NOT EXISTS cases (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT, user_id TEXT, moderator_id TEXT, action TEXT, reason TEXT, at INTEGER);
      CREATE TABLE IF NOT EXISTS links (guild_id TEXT, user_id TEXT, roblox_id TEXT, username TEXT, synced INTEGER, PRIMARY KEY(guild_id,user_id));
      CREATE INDEX IF NOT EXISTS links_refresh ON links(synced);
      CREATE TABLE IF NOT EXISTS blocked_accounts (guild_id TEXT, roblox_id TEXT, reason TEXT, PRIMARY KEY(guild_id,roblox_id));
      CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT, by_id TEXT, at INTEGER, json TEXT);
      CREATE TABLE IF NOT EXISTS snapshot_metadata (
        snapshot_id INTEGER PRIMARY KEY REFERENCES snapshots(id) ON DELETE CASCADE,
        guild_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('snapshot','backup','copy')), source_guild TEXT);
      CREATE TABLE IF NOT EXISTS recovery_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, actor_id TEXT NOT NULL,
        event TEXT NOT NULL, snapshot_id INTEGER, at INTEGER NOT NULL, detail TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS recovery_events_guild ON recovery_events(guild_id,at);
      CREATE TABLE IF NOT EXISTS recovery_mappings (
        destination_guild TEXT NOT NULL, source_guild TEXT NOT NULL, kind TEXT NOT NULL,
        source_id TEXT NOT NULL, destination_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(destination_guild,source_guild,kind,source_id),
        UNIQUE(destination_guild,source_guild,kind,destination_id));
      CREATE TABLE IF NOT EXISTS recovery_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, source_guild TEXT NOT NULL,
        snapshot_id INTEGER NOT NULL, actor_id TEXT NOT NULL, backup_id INTEGER, at INTEGER NOT NULL, report TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT, channel_id TEXT, json TEXT, attempts INTEGER DEFAULT 0, next_at INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY, owner TEXT, until INTEGER);
      CREATE TABLE IF NOT EXISTS guild_authorization (
        guild_id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('PENDING_AUTHORIZATION','AUTHORIZED','DEAUTHORIZED','EXPIRED','BANNED')),
        joined_at INTEGER NOT NULL, deadline INTEGER, authorized_by TEXT, authorized_at INTEGER,
        removed_by TEXT, removed_at INTEGER, version TEXT, config_version INTEGER, generation INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS server_bans (guild_id TEXT PRIMARY KEY, name TEXT NOT NULL, reason TEXT NOT NULL, banned_by TEXT NOT NULL, at INTEGER NOT NULL);
      -- Developer bans across every authorized server (/network genreban, /network hardban). Rows are never deleted:
      -- a revoked ban keeps who revoked it and why. At most one active ban per user and type.
      CREATE TABLE IF NOT EXISTS network_bans (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK(kind IN ('genreban','hardban')),
        user_id TEXT NOT NULL, username TEXT, reason TEXT NOT NULL, evidence TEXT, evidence_file TEXT,
        moderator_id TEXT NOT NULL, moderator_name TEXT, created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
        revoked_by TEXT, revoked_by_name TEXT, revoked_at INTEGER, revoke_reason TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS network_bans_one_active ON network_bans(kind, user_id) WHERE status='active';
      CREATE INDEX IF NOT EXISTS network_bans_user ON network_bans(user_id);
      -- What happened in each server for each network ban: the affected-servers record.
      CREATE TABLE IF NOT EXISTS network_ban_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ban_id INTEGER NOT NULL REFERENCES network_bans(id),
        guild_id TEXT NOT NULL, guild_name TEXT, action TEXT NOT NULL, outcome TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS network_ban_results_ban ON network_ban_results(ban_id, id);
      CREATE TABLE IF NOT EXISTS authorization_events (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, state TEXT NOT NULL, actor TEXT, at INTEGER NOT NULL, detail TEXT);
      CREATE TABLE IF NOT EXISTS runtime_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
        try {
            normalizeDatabase(this.db);
        }
        catch (error) {
            if (path !== ':memory:')
                writeFileSync(path + '.migration-failure.json', JSON.stringify({ at: Date.now(), status: 'failed', message: redact(error instanceof Error ? error.message : String(error)), backup: migrationBackup?.path ?? null }), { mode: 0o600 });
            this.db.close();
            throw new AppError('DATABASE_ERROR', 'Database migration failed. Startup stopped; the pre-migration backup is preserved. Review the migration failure record beside the database.', { cause: error });
        }
        if (path !== ':memory:' && existsSync(path + '.migration-failure.json')) {
            this.db.prepare('INSERT INTO database_health(id,migration_failures) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET migration_failures=migration_failures+1').run();
            renameSync(path + '.migration-failure.json', path + '.migration-failure-recovered-' + Date.now() + '.json');
        }
        if (!this.db.prepare('PRAGMA table_info(snapshot_metadata)').all().some(c => c.name === 'purpose'))
            this.db.exec("ALTER TABLE snapshot_metadata ADD COLUMN purpose TEXT NOT NULL DEFAULT 'manual'");
        this.db.exec('DROP TABLE IF EXISTS settings; CREATE TABLE IF NOT EXISTS antinuke_defaults (guild_id TEXT PRIMARY KEY REFERENCES guild_data(guild_id) ON DELETE CASCADE, count INTEGER NOT NULL CHECK(count BETWEEN 1 AND 100), seconds INTEGER NOT NULL CHECK(seconds BETWEEN 1 AND 300));');
        this.db.exec(`CREATE TABLE IF NOT EXISTS antiping_config (
          guild_id TEXT PRIMARY KEY REFERENCES guild_data(guild_id) ON DELETE CASCADE,
          enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), rule_id TEXT);
          CREATE TABLE IF NOT EXISTS antiping_targets (
          guild_id TEXT NOT NULL REFERENCES guild_data(guild_id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('role','user','bypass')), target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 17 AND 20 AND target_id NOT GLOB '*[^0-9]*'),
          PRIMARY KEY(guild_id,kind,target_id));`);
        this.db.exec(`CREATE TABLE IF NOT EXISTS scam_config (guild_id TEXT PRIMARY KEY REFERENCES guild_data(guild_id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 0, vision INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS scam_domains (guild_id TEXT REFERENCES guild_data(guild_id) ON DELETE CASCADE, domain TEXT NOT NULL, PRIMARY KEY(guild_id,domain));
        CREATE TABLE IF NOT EXISTS scam_images (guild_id TEXT REFERENCES guild_data(guild_id) ON DELETE CASCADE, id TEXT NOT NULL, name TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(guild_id,id));
        CREATE TABLE IF NOT EXISTS scam_exclusions (guild_id TEXT REFERENCES guild_data(guild_id) ON DELETE CASCADE, channel_id TEXT NOT NULL, PRIMARY KEY(guild_id,channel_id));
        CREATE TABLE IF NOT EXISTS scam_events (guild_id TEXT REFERENCES guild_data(guild_id) ON DELETE CASCADE, message_id TEXT NOT NULL, revision TEXT NOT NULL, user_id TEXT NOT NULL, at INTEGER NOT NULL, confirmed INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(guild_id,message_id,revision));`);
        this.db.exec(`CREATE TABLE IF NOT EXISTS antinuke_presets (guild_id TEXT NOT NULL REFERENCES guild_data(guild_id) ON DELETE CASCADE, name TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(guild_id,name));
        CREATE TABLE IF NOT EXISTS antinuke_options (
          guild_id TEXT PRIMARY KEY REFERENCES guild_data(guild_id) ON DELETE CASCADE,
          kick_bots INTEGER NOT NULL DEFAULT 0 CHECK(kick_bots IN (0,1)));`);
        // 2.11: staff can switch the fixed anti-nuke preset off; that choice survives restarts.
        if (!this.db.prepare('PRAGMA table_info(antinuke_options)').all().some((c) => c.name === 'staff_disabled'))
            this.db.exec('ALTER TABLE antinuke_options ADD COLUMN staff_disabled INTEGER NOT NULL DEFAULT 0 CHECK(staff_disabled IN (0,1))');
        this.db.exec(`CREATE TABLE IF NOT EXISTS event_log_config (
          guild_id TEXT PRIMARY KEY REFERENCES guild_data(guild_id) ON DELETE CASCADE,
          enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
          channel_id TEXT,
          categories TEXT NOT NULL DEFAULT 'moderation,members,roles,channels,server,messages');
        CREATE TABLE IF NOT EXISTS event_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL REFERENCES guild_data(guild_id) ON DELETE CASCADE,
          at INTEGER NOT NULL, category TEXT NOT NULL, action TEXT NOT NULL,
          actor_id TEXT, target_id TEXT, target TEXT, summary TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS event_log_guild_at ON event_log(guild_id, at);`);
        // Moderation cases also keep the target's username at the time and any evidence (2.22).
        const caseColumns = new Set(this.db.prepare('PRAGMA table_info(cases)').all().map((c) => c.name));
        if (!caseColumns.has('username'))
            this.db.exec('ALTER TABLE cases ADD COLUMN username TEXT');
        if (!caseColumns.has('evidence'))
            this.db.exec('ALTER TABLE cases ADD COLUMN evidence TEXT');
        this.db.exec(`CREATE TABLE IF NOT EXISTS lockdowns (
          guild_id TEXT PRIMARY KEY REFERENCES guild_data(guild_id) ON DELETE CASCADE,
          started_by TEXT NOT NULL, started_at INTEGER NOT NULL, reason TEXT, message TEXT,
          channel_count INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS lockdown_overwrites (
          guild_id TEXT NOT NULL REFERENCES guild_data(guild_id) ON DELETE CASCADE,
          channel_id TEXT NOT NULL, target_id TEXT NOT NULL, target_type INTEGER NOT NULL,
          existed INTEGER NOT NULL, allow TEXT NOT NULL, deny TEXT NOT NULL, bits TEXT NOT NULL,
          PRIMARY KEY(guild_id, channel_id, target_id));
        CREATE TABLE IF NOT EXISTS lockdown_notices (
          guild_id TEXT NOT NULL REFERENCES guild_data(guild_id) ON DELETE CASCADE,
          channel_id TEXT NOT NULL, message_id TEXT NOT NULL,
          PRIMARY KEY(guild_id, channel_id));`);
        if (migrationBackup)
            this.db.prepare('INSERT OR IGNORE INTO database_backups VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(migrationBackup.id, migrationBackup.createdAt, 'migration', migrationBackup.path, migrationBackup.databaseVersion, migrationBackup.botVersion, migrationBackup.size, migrationBackup.checksum, 'verified', 1, null, null);
        // 2.13: staff notes, temporary bans and raid mode.
        this.db.exec(`CREATE TABLE IF NOT EXISTS member_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL REFERENCES guild_data(guild_id) ON DELETE CASCADE, number INTEGER, user_id TEXT NOT NULL, author_id TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS member_notes_user ON member_notes(guild_id, user_id);
            CREATE TABLE IF NOT EXISTS tempbans (guild_id TEXT NOT NULL REFERENCES guild_data(guild_id) ON DELETE CASCADE, user_id TEXT NOT NULL, until INTEGER NOT NULL, moderator_id TEXT NOT NULL, reason TEXT NOT NULL, case_number INTEGER, PRIMARY KEY(guild_id, user_id));
            CREATE TABLE IF NOT EXISTS staff_roles (guild_id TEXT NOT NULL REFERENCES guild_data(guild_id) ON DELETE CASCADE, role_id TEXT NOT NULL, level TEXT NOT NULL CHECK(level IN ('helper','moderator','admin','headadmin')), by_id TEXT, at INTEGER, PRIMARY KEY(guild_id, role_id));
            CREATE TABLE IF NOT EXISTS bot_staff (user_id TEXT PRIMARY KEY, level TEXT NOT NULL CHECK(level IN ('botmanager','overseer','supreme')), by_id TEXT, at INTEGER);
            CREATE TABLE IF NOT EXISTS newaccount_config (guild_id TEXT PRIMARY KEY REFERENCES guild_data(guild_id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 1, min_age_days INTEGER NOT NULL DEFAULT 7 CHECK(min_age_days BETWEEN 1 AND 90), action TEXT NOT NULL DEFAULT 'hold' CHECK(action IN ('hold','kick','alert')), by_id TEXT);
            CREATE TABLE IF NOT EXISTS raidmode (guild_id TEXT PRIMARY KEY REFERENCES guild_data(guild_id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 0, min_age_days INTEGER NOT NULL DEFAULT 7, action TEXT NOT NULL DEFAULT 'kick' CHECK(action IN ('kick','timeout')), until INTEGER, by_id TEXT, handled INTEGER NOT NULL DEFAULT 0);`);
        // 2.18: per-server feature settings (automod, welcome, appeals, duty...), ban appeals and duty shifts.
        this.db.exec(`CREATE TABLE IF NOT EXISTS guild_features (guild_id TEXT NOT NULL REFERENCES guild_data(guild_id) ON DELETE CASCADE, key TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(guild_id, key));
            CREATE TABLE IF NOT EXISTS appeals (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL REFERENCES guild_data(guild_id) ON DELETE CASCADE, user_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','denied')), at INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER, message_id TEXT);
            CREATE INDEX IF NOT EXISTS appeals_user ON appeals(guild_id, user_id);
            CREATE TABLE IF NOT EXISTS duty_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL REFERENCES guild_data(guild_id) ON DELETE CASCADE, user_id TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER, ended_by TEXT);
            CREATE INDEX IF NOT EXISTS duty_open ON duty_sessions(guild_id, user_id, end);
            CREATE TABLE IF NOT EXISTS roblox_network (roblox_id TEXT NOT NULL, guild_id TEXT NOT NULL, reason TEXT, at INTEGER NOT NULL, source_user TEXT, PRIMARY KEY(roblox_id, guild_id));
            CREATE TABLE IF NOT EXISTS network_partners (guild_id TEXT NOT NULL, partner_id TEXT NOT NULL, by_id TEXT, at INTEGER, PRIMARY KEY(guild_id, partner_id));`);
        // 2.23: developer-managed automatic reactions to chosen members' messages.
        // 2.24: ban log records (one row per ban, updated in place on unban / reban) and outbox timestamps.
        this.db.exec(`CREATE TABLE IF NOT EXISTS ban_records (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL REFERENCES guild_data(guild_id) ON DELETE CASCADE, number INTEGER NOT NULL,
            user_id TEXT NOT NULL, username TEXT, avatar_url TEXT, kind TEXT NOT NULL, reason TEXT, evidence TEXT, moderator_id TEXT, moderator_role TEXT NOT NULL, approved TEXT, duration TEXT, expires_at INTEGER,
            banned_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('banned','unbanned','expired')), status_by TEXT, status_by_role TEXT, status_at INTEGER, status_reason TEXT, history TEXT NOT NULL DEFAULT '[]',
            channel_id TEXT, message_id TEXT);
            CREATE UNIQUE INDEX IF NOT EXISTS ban_records_number ON ban_records(guild_id, number);
            CREATE INDEX IF NOT EXISTS ban_records_user ON ban_records(guild_id, user_id, status);`);
        if (!this.db.prepare('PRAGMA table_info(outbox)').all().some((c) => c.name === 'created_at'))
            this.db.exec('ALTER TABLE outbox ADD COLUMN created_at INTEGER');
        // 2.26.2: which genreban/hardban (e.g. HB-00005) a ban record belongs to, if any.
        if (!this.db.prepare('PRAGMA table_info(ban_records)').all().some((c) => c.name === 'network_record'))
            this.db.exec('ALTER TABLE ban_records ADD COLUMN network_record TEXT');
        // 2.25: /role rules. kind 'allow': configured moderators may give/take the role.
        // kind 'grant': owner-approved rule letting a role or user grant a privileged role.
        this.db.exec(`CREATE TABLE IF NOT EXISTS role_rules (guild_id TEXT NOT NULL REFERENCES guild_data(guild_id) ON DELETE CASCADE, role_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('allow','grant')), grantor_type TEXT NOT NULL DEFAULT '' CHECK(grantor_type IN ('','role','user')), grantor_id TEXT NOT NULL DEFAULT '',
            by_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(guild_id, role_id, kind, grantor_type, grantor_id));`);
        this.db.exec(`CREATE TABLE IF NOT EXISTS autoreact_users (guild_id TEXT NOT NULL REFERENCES guild_data(guild_id) ON DELETE CASCADE, user_id TEXT NOT NULL, emoji TEXT NOT NULL, by_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(guild_id, user_id));`);
        // 2.16.3: Supreme Leader can be given by command, so bot_staff accepts 'supreme'. Rebuild older tables (no rows lost).
        if (!String(this.db.prepare("SELECT sql FROM sqlite_master WHERE name='bot_staff'").get()?.sql ?? '').includes("'supreme'"))
            this.db.exec(`BEGIN; CREATE TABLE bot_staff_new (user_id TEXT PRIMARY KEY, level TEXT NOT NULL CHECK(level IN ('botmanager','overseer','supreme')), by_id TEXT, at INTEGER);
                INSERT INTO bot_staff_new SELECT user_id,level,by_id,at FROM bot_staff; DROP TABLE bot_staff; ALTER TABLE bot_staff_new RENAME TO bot_staff; COMMIT;`);
        this.db.function('check_scope', (id) => {
            const current = this.active.getStore();
            if (current && String(id) !== current.guild)
                throw Error('Cross-guild database mutation was blocked.');
            return 1;
        });
        const tables = [...GUILD_SCOPED_TABLES];
        for (const table of tables) {
            const col = table === 'recovery_mappings' ? 'destination_guild' : 'guild_id';
            this.db.exec(`DROP TRIGGER IF EXISTS scope_${table}_insert; CREATE TRIGGER scope_${table}_insert BEFORE INSERT ON ${table} BEGIN SELECT check_scope(NEW.${col}); INSERT INTO guild_data(guild_id) SELECT NEW.${col} WHERE NOT EXISTS(SELECT 1 FROM guild_data WHERE guild_id=NEW.${col}); END;
              CREATE TRIGGER IF NOT EXISTS scope_${table}_update BEFORE UPDATE ON ${table} BEGIN SELECT check_scope(OLD.${col}); SELECT check_scope(NEW.${col}); END;
              CREATE TRIGGER IF NOT EXISTS scope_${table}_delete BEFORE DELETE ON ${table} BEGIN SELECT check_scope(OLD.${col}); END;`);
        }
        this.db.exec('CREATE TRIGGER IF NOT EXISTS scope_guild_data_update BEFORE UPDATE ON guild_data BEGIN SELECT check_scope(OLD.guild_id); SELECT check_scope(NEW.guild_id); END;');
        for (const table of ['guild_authorization', 'server_bans', 'authorization_events', 'recovery_events'])
            this.db.exec(`DROP TRIGGER IF EXISTS parent_${table}_insert; CREATE TRIGGER parent_${table}_insert BEFORE INSERT ON ${table} BEGIN INSERT INTO guild_data(guild_id) SELECT NEW.guild_id WHERE NOT EXISTS(SELECT 1 FROM guild_data WHERE guild_id=NEW.guild_id); END;`);
        // Runs after check_scope is registered: existing databases have scope triggers on snapshots.
        // 2.12: snapshot numbers are per server (#1, #2, ...). The next number is the server's highest
        // remaining number + 1, so deleting everything starts again at #1. Internal row IDs are unchanged.
        // Same per-server numbering for moderation cases (2.13) and staff notes.
        for (const table of ['snapshots', 'cases', 'member_notes']) {
            if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === 'number')) {
                this.db.exec(`ALTER TABLE ${table} ADD COLUMN number INTEGER;
                    UPDATE ${table} SET number=(SELECT COUNT(*) FROM ${table} o WHERE o.guild_id IS ${table}.guild_id AND o.id<=${table}.id);`);
            }
            this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${table}_guild_number ON ${table}(guild_id, number);
                CREATE TRIGGER IF NOT EXISTS ${table}_assign_number AFTER INSERT ON ${table} WHEN NEW.number IS NULL BEGIN
                    UPDATE ${table} SET number=(SELECT COALESCE(MAX(number),0)+1 FROM ${table} WHERE guild_id IS NEW.guild_id) WHERE id=NEW.id;
                END;`);
        }
    }
    checkRead(sql, args) {
        const active = this.active.getStore();
        if (!active || !SCOPED_TABLE_PATTERN.test(sql))
            return;
        const match = /\b(?:\w+\.)?(?:guild_id|destination_guild)\s*=\s*\?/i.exec(sql);
        if (!match || args[(sql.slice(0, match.index).match(/\?/g) ?? []).length] !== active.guild)
            throw new AppError('DATABASE_ERROR', 'Cross-guild or unscoped database read was blocked.');
        this.assertAuthorized(active.guild);
    }
    readGuild(guild, fn) {
        const current = this.active.getStore();
        if (current)
            this.assertAuthorized(current.guild);
        if (current && current.guild !== guild && !this.isAuthorized(guild))
            throw new AppError('AUTHORIZATION_ERROR', 'The destination server is not authorized.');
        return this.active.run({ guild, generation: this.authorization(guild)?.generation ?? 0 }, fn);
    }
    get(sql, ...args) {
        this.checkRead(sql, args);
        try {
            return this.db.prepare(sql).get(...args);
        }
        catch (error) {
            this.queryFailures++;
            throw error;
        }
    }
    all(sql, ...args) {
        this.checkRead(sql, args);
        try {
            return this.db.prepare(sql).all(...args);
        }
        catch (error) {
            this.queryFailures++;
            throw error;
        }
    }
    run(sql, ...args) {
        const active = this.active.getStore();
        if (active)
            this.assertAuthorized(active.guild);
        try {
            return this.db.prepare(sql).run(...args);
        }
        catch (error) {
            this.queryFailures++;
            throw error;
        }
    }
    settings(guildId) {
        const row = this.get('SELECT * FROM guild_config WHERE guild_id=?', guildId);
        const settings = row ? { guildId, authorized: false, enabled: !!row.enabled, mode: row.mode,
            logChannelId: row.log_channel_id, quarantineRoleId: row.quarantine_role_id, verifiedRoleId: row.verified_role_id,
            minAge: row.min_age, revokeOnUnlink: !!row.revoke_on_unlink, syncOnJoin: !!row.sync_on_join, blockBanned: !!row.block_banned, nickname: !!row.nickname, rules: {} }
            : { guildId, authorized: false, enabled: false, mode: 'observe', logChannelId: null, quarantineRoleId: null, verifiedRoleId: null, minAge: 7, revokeOnUnlink: true, syncOnJoin: true, blockBanned: true, nickname: true, rules: {} };
        settings.rules = Object.fromEntries(this.all('SELECT rule,enabled,count,seconds FROM antinuke_rules WHERE guild_id=?', guildId).map(r => [r.rule, { count: r.count, seconds: r.seconds, ...(r.enabled ? {} : { enabled: false }) }]));
        const global = this.get('SELECT count,seconds FROM antinuke_defaults WHERE guild_id=?', guildId);
        if (global)
            settings.ruleDefaults = { count: global.count, seconds: global.seconds };
        settings.authorized = this.isAuthorized(guildId);
        return settings;
    }
    authorization(guildId) {
        return this.get('SELECT * FROM guild_authorization WHERE guild_id=?', guildId);
    }
    isAuthorized(guildId) {
        return this.authorization(guildId)?.state === 'AUTHORIZED' && !this.get('SELECT 1 FROM server_bans WHERE guild_id=?', guildId);
    }
    assertAuthorized(guildId) {
        const active = this.active.getStore();
        if (!this.isAuthorized(guildId) || active && (active.guild !== guildId || active.generation !== this.authorization(guildId)?.generation))
            throw new AppError('AUTHORIZATION_ERROR', 'This server requires developer authorization with /dev server authorize.');
    }
    withAuthorized(guildId, fn) {
        const current = this.active.getStore();
        if (current)
            this.assertAuthorized(current.guild);
        if (!this.isAuthorized(guildId))
            throw new AppError('AUTHORIZATION_ERROR', 'This server requires developer authorization with /dev server authorize.');
        return this.active.run({ guild: guildId, generation: this.authorization(guildId).generation }, fn);
    }
    transaction(fn) {
        if (this.transactions)
            return fn();
        this.transactions++;
        try {
            this.db.exec('BEGIN IMMEDIATE');
        }
        catch (error) {
            this.transactions--;
            throw error;
        }
        try {
            const result = fn();
            this.db.exec('COMMIT');
            return result;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
        finally {
            this.transactions--;
        }
    }
    auditAuthorization(guildId, state, actor, detail = '') {
        this.history(guildId, 'authorization', null, { ...this.authorization(guildId), detail }, actor ?? 'system');
        this.run('INSERT INTO authorization_events(guild_id,state,actor,at,detail) VALUES(?,?,?,?,?)', guildId, state, actor, Date.now(), detail);
    }
    clearTemporary(guildId) {
        for (const table of ['observations', 'outbox'])
            this.run(`DELETE FROM ${table} WHERE guild_id=?`, guildId);
    }
    maintenance(fn) {
        return this.active.exit(fn);
    }
    history(guild, component, before, after, actor = 'system') {
        if (JSON.stringify(before) === JSON.stringify(after))
            return;
        this.run('INSERT INTO configuration_history(guild_id,component,actor_id,at,before_json,after_json) VALUES(?,?,?,?,?,?)', guild, component, actor, Date.now(), before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after));
    }
    save(s, actor = 'system') {
        if (this.active.getStore())
            this.assertAuthorized(s.guildId);
        const previous = this.settings(s.guildId);
        this.transaction(() => {
            this.run('INSERT OR IGNORE INTO guild_data(guild_id) VALUES(?)', s.guildId);
            this.run('INSERT INTO guild_config VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET enabled=excluded.enabled,mode=excluded.mode,log_channel_id=excluded.log_channel_id,quarantine_role_id=excluded.quarantine_role_id,verified_role_id=excluded.verified_role_id,min_age=excluded.min_age,revoke_on_unlink=excluded.revoke_on_unlink,sync_on_join=excluded.sync_on_join,block_banned=excluded.block_banned,nickname=excluded.nickname', s.guildId, Number(s.enabled), s.mode, s.logChannelId, s.quarantineRoleId, s.verifiedRoleId, s.minAge, Number(s.revokeOnUnlink), Number(s.syncOnJoin), Number(s.blockBanned), Number(s.nickname));
            this.run('DELETE FROM antinuke_rules WHERE guild_id=?', s.guildId);
            for (const [key, r] of Object.entries(s.rules))
                this.run('INSERT INTO antinuke_rules VALUES(?,?,?,?,?)', s.guildId, key, r.enabled === false ? 0 : 1, r.count, r.seconds);
            if (s.ruleDefaults)
                this.run('INSERT INTO antinuke_defaults VALUES(?,?,?) ON CONFLICT(guild_id) DO UPDATE SET count=excluded.count,seconds=excluded.seconds', s.guildId, s.ruleDefaults.count, s.ruleDefaults.seconds);
            else
                this.run('DELETE FROM antinuke_defaults WHERE guild_id=?', s.guildId);
            this.history(s.guildId, 'settings', previous, s, actor);
            this.run('UPDATE guild_data SET last_sync=? WHERE guild_id=?', Date.now(), s.guildId);
        });
    }
    health() {
        try {
            const integrity = this.get('PRAGMA quick_check')?.quick_check === 'ok';
            this.run('INSERT INTO database_health(id,checked_at,status,query_failures) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at,status=excluded.status,query_failures=excluded.query_failures', Date.now(), integrity ? 'connected' : 'corrupt', this.queryFailures);
            return { ...this.get('SELECT * FROM database_health WHERE id=1'), connected: integrity, databaseVersion: Number(this.get('PRAGMA user_version')?.user_version), storageBytes: this.path === ':memory:' ? 0 : statSync(this.path).size };
        }
        catch {
            return { connected: false, status: 'disconnected', query_failures: this.queryFailures };
        }
    }
    markGuild(guild, name, active, now = Date.now()) {
        this.run('INSERT INTO guild_data(guild_id,name,active,inactive_at,retention_until,last_sync) VALUES(?,?,?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET name=excluded.name,active=excluded.active,inactive_at=excluded.inactive_at,retention_until=excluded.retention_until,last_sync=excluded.last_sync', guild, name, Number(active), active ? null : now, active ? null : now + config.guildRetentionDays * 86400000, now);
    }
    revokeGrant(guild, user, kind, actor) {
        const before = this.get('SELECT * FROM grants WHERE guild_id=? AND user_id=? AND kind=?', guild, user, kind) ?? null;
        this.transaction(() => {
            this.run('DELETE FROM grants WHERE guild_id=? AND user_id=? AND kind=?', guild, user, kind);
            this.history(guild, 'grant', before, null, actor);
        });
    }
    /** Whether anti-nuke containment removes an offending bot from the server instead of only stripping its roles. */
    kickBots(guildId) {
        return !!this.get('SELECT kick_bots FROM antinuke_options WHERE guild_id=?', guildId)?.kick_bots;
    }
    setKickBots(guildId, enabled) {
        this.run('INSERT INTO antinuke_options(guild_id,kick_bots) VALUES(?,?) ON CONFLICT(guild_id) DO UPDATE SET kick_bots=excluded.kick_bots', guildId, enabled ? 1 : 0);
    }
    /** True when staff used /antinuke disable; automatic startup protection then leaves anti-nuke off. */
    antinukeStaffDisabled(guildId) {
        return !!this.get('SELECT staff_disabled FROM antinuke_options WHERE guild_id=?', guildId)?.staff_disabled;
    }
    setAntinukeStaffDisabled(guildId, disabled) {
        this.run('INSERT INTO antinuke_options(guild_id,staff_disabled) VALUES(?,?) ON CONFLICT(guild_id) DO UPDATE SET staff_disabled=excluded.staff_disabled', guildId, disabled ? 1 : 0);
    }
    hasGrant(guildId, userId, kind, now = Date.now()) {
        return !!this.get('SELECT 1 FROM grants WHERE guild_id=? AND user_id=? AND kind=? AND (expires IS NULL OR expires>?)', guildId, userId, kind, now);
    }
    grant(guildId, userId, kind, by, hours) {
        const before = this.get('SELECT * FROM grants WHERE guild_id=? AND user_id=? AND kind=?', guildId, userId, kind) ?? null;
        this.run('INSERT INTO grants VALUES (?,?,?,?,?) ON CONFLICT(guild_id,user_id,kind) DO UPDATE SET by_id=excluded.by_id,expires=excluded.expires', guildId, userId, kind, by, hours ? Date.now() + hours * 3600000 : null);
        this.history(guildId, 'grant', before, this.get('SELECT * FROM grants WHERE guild_id=? AND user_id=? AND kind=?', guildId, userId, kind), by);
    }
    observe(id, guildId, actor, rule, target, at = Date.now()) {
        return this.run('INSERT OR IGNORE INTO observations VALUES (?,?,?,?,?,?)', id, guildId, actor, rule, target, at).changes > 0;
    }
    count(guildId, actor, rule, since) {
        return Number(this.get('SELECT COUNT(*) AS n FROM observations WHERE guild_id=? AND actor_id=? AND rule=? AND at>=?', guildId, actor, rule, since)?.n ?? 0);
    }
    incident(guildId, actor, rule, mode, result) {
        return Number(this.run('INSERT INTO incidents(guild_id,actor_id,rule,at,mode,result) VALUES(?,?,?,?,?,?)', guildId, actor, rule, Date.now(), mode, result).lastInsertRowid);
    }
    /** Record a moderation case and return its per-server case number. */
    recordCase(guildId, userId, moderator, action, reason, details = {}) {
        const id = Number(this.run('INSERT INTO cases(guild_id,user_id,moderator_id,action,reason,at,username,evidence) VALUES(?,?,?,?,?,?,?,?)', guildId, userId, moderator, action, reason, Date.now(), details.username ?? null, details.evidence ?? null).lastInsertRowid);
        return Number(this.get('SELECT number FROM cases WHERE guild_id=? AND id=?', guildId, id)?.number ?? id);
    }
    acquireLease(name, owner, now = Date.now()) {
        this.run('INSERT INTO leases VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,until=excluded.until WHERE leases.until<? OR leases.owner=?', name, owner, now + 30000, now, owner);
        return this.get('SELECT owner FROM leases WHERE name=?', name)?.owner === owner;
    }
    cleanup(now = Date.now()) {
        this.run('DELETE FROM observations WHERE at<?', now - 7 * 86400000);
        this.run('DELETE FROM scam_events WHERE at<?', now - 30 * 86400000);
        this.run('DELETE FROM event_log WHERE at<?', now - 30 * 86400000);
        this.run('DELETE FROM grants WHERE expires IS NOT NULL AND expires<=?', now);
        // Recovery snapshots and rollback backups are retained until explicitly removed.
        // Never delete a snapshot underneath a running restoration.
    }
    close() {
        this.db.close();
    }
}
