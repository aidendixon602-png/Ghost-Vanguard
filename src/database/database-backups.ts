import { backup, DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, stat, rename, unlink, writeFile, chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Store } from './db.js';
import { GUILD_SCOPED_TABLES } from './db.js';
import { config, VERSION } from '../config.js';
import { logEvent, redact } from '../errors.js';

export class DatabaseBackups {
    private busy = false;
    private nextAttempt = 0;
    private lastFailureAlert = 0;
    onFailure?: (message: string) => Promise<void>;

    constructor(readonly store: Store, readonly directory = config.databaseBackupDirectory) { }

    async create(kind = 'manual') {
        return this.store.maintenance(() => this.createInternal(kind));
    }

    private async createInternal(kind: string) {
        if (this.busy)
            throw Error('A database backup is already running.');
        this.busy = true;
        const id = randomUUID(), at = Date.now(), path = join(this.directory, `${at}-${id}.db`), temporary = path + '.partial';
        try {
            await mkdir(this.directory, { recursive: true, mode: 0o700 });
            this.store.run('INSERT INTO database_backups VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', id, at, kind, path, Number(this.store.get('PRAGMA user_version')?.user_version), VERSION, null, null, 'creating', 0, null, null);
            await backup(this.store.db, temporary, { rate: 128 });
            const check = new DatabaseSync(temporary, { readOnly: true });
            try {
                if (check.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' || check.prepare('PRAGMA foreign_key_check').all().length)
                    throw Error('Database backup integrity/foreign-key verification failed.');
                if (Number(check.prepare('PRAGMA user_version').get()?.user_version) !== 3)
                    throw Error('Database backup schema version mismatch.');
            } finally {
                check.close();
            }
            const bytes = await readFile(temporary), checksum = createHash('sha256').update(bytes).digest('hex');
            await chmod(temporary, 0o600);
            await rename(temporary, path);
            const metadata = { id, at, kind, path, databaseVersion: 3, botVersion: VERSION, size: bytes.length, checksum, status: 'verified', verified: true, expires: null };
            await writeFile(path + '.json', JSON.stringify(metadata, null, 2), { mode: 0o600 });
            this.store.run("UPDATE database_backups SET size=?,checksum=?,status='verified',verified=1 WHERE id=?", bytes.length, checksum, id);
            this.store.run('INSERT INTO database_health(id,last_backup) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET last_backup=excluded.last_backup', at);
            this.store.db.prepare('UPDATE guild_data SET last_backup=?').run(at);
            logEvent('database_backup_verified', { id, kind, size: bytes.length });
            return metadata;
        } catch (error) {
            const message = redact(error instanceof Error ? error.message : String(error));
            try {
                this.store.run("UPDATE database_backups SET status='failed',error=? WHERE id=?", message, id);
                this.store.run('INSERT INTO database_health(id,backup_failures) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET backup_failures=backup_failures+1');
            } catch { }
            await unlink(temporary).catch(() => { });
            logEvent('database_backup_failed', { id, kind, error: message });
            this.nextAttempt = Date.now() + 300000;
            if (Date.now() - this.lastFailureAlert >= 300000) {
                this.lastFailureAlert = Date.now();
                await this.onFailure?.(`Database backup failed (${id}): ${message}`).catch(() => { });
            }
            throw error;
        } finally {
            this.busy = false;
        }
    }

    async verify(id: string) {
        const row = this.store.get("SELECT * FROM database_backups WHERE id=? AND status='verified'", id);
        if (!row)
            throw Error('Verified database backup not found.');
        const digest = createHash('sha256').update(await readFile(row.path)).digest('hex');
        if (digest !== row.checksum)
            throw Error('Database backup checksum mismatch.');
        const db = new DatabaseSync(row.path, { readOnly: true });
        try {
            if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
                throw Error('Database backup integrity check failed.');
        } finally {
            db.close();
        }
        return true;
    }

    async scheduled(now = Date.now()) {
        const last = this.store.get("SELECT at FROM database_backups WHERE status='verified' AND kind IN ('scheduled','startup') ORDER BY at DESC LIMIT 1");
        if (now < this.nextAttempt || this.busy || last && now - last.at < config.databaseBackupMinutes * 60000)
            return;
        await this.create('scheduled');
        await this.retain(now);
    }

    async retain(now = Date.now()) {
        const rows = this.store.all("SELECT * FROM database_backups WHERE status='verified' AND kind!='migration' ORDER BY at DESC");
        const keep = new Set(rows.slice(0, config.backupRecent).map(r => r.id)), daily = new Set<string>(), weekly = new Set<string>();
        for (const row of rows) {
            const day = new Date(row.at).toISOString().slice(0, 10), week = String(Math.floor(row.at / (7 * 86400000)));
            if (daily.size < config.backupDaily && !daily.has(day)) {
                keep.add(row.id);
                daily.add(day);
            }
            if (weekly.size < config.backupWeekly && !weekly.has(week)) {
                keep.add(row.id);
                weekly.add(week);
            }
        }
        for (const row of rows) {
            if (keep.has(row.id)) {
                this.store.run('UPDATE database_backups SET expires=NULL WHERE id=?', row.id);
                continue;
            }
            this.store.run('UPDATE database_backups SET expires=? WHERE id=?', now, row.id);
            await unlink(row.path).catch((e: any) => {
                if (e.code !== 'ENOENT')
                    throw e;
            });
            await unlink(row.path + '.json').catch(() => { });
            this.store.run("UPDATE database_backups SET status='expired' WHERE id=?", row.id);
        }
    }

    async purgeInactive(now = Date.now()) {
        const rows = this.store.all('SELECT guild_id FROM guild_data WHERE active=0 AND retention_until<=?', now);
        if (!rows.length)
            return;
        await this.create('before-guild-cleanup');
        for (const row of rows) {
            if (this.store.get('SELECT 1 FROM leases WHERE name=? AND until>?', `recovery:${row.guild_id}`, now))
                continue;
            // Preserve authorization bans and their audit; retire only retained operational data.
            this.store.transaction(() => {
                for (const table of [...GUILD_SCOPED_TABLES.filter(table => table !== 'recovery_mappings'), 'recovery_events'])
                    this.store.run(`DELETE FROM ${table} WHERE guild_id=?`, row.guild_id);
                this.store.run('DELETE FROM recovery_mappings WHERE destination_guild=?', row.guild_id);
                this.store.run('DELETE FROM roblox_network WHERE guild_id=?', row.guild_id);
                this.store.run('DELETE FROM network_partners WHERE guild_id=? OR partner_id=?', row.guild_id, row.guild_id);
                this.store.run('UPDATE guild_data SET retention_until=NULL WHERE guild_id=?', row.guild_id);
            });
        }
    }
}
