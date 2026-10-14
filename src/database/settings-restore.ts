import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '../errors.js';
import type { Store } from './db.js';

/**
 * Put back settings from an older database file (a daily backup DM, a downloaded data/ folder) without
 * touching anything newer. Only configuration is copied, never history: whitelists, staff ranks, permission
 * roles, command and feature switches, logging, auto-react, who-can-give rules, anti-ping, scam and new-account
 * settings. A row that exists now always wins, and whitelist entries someone changed or removed after the
 * backup was taken are left alone. Only servers that are authorized right now are touched.
 */
export const RESTORABLE: { table: string; label: string }[] = [
    { table: 'grants', label: 'whitelist entries' },
    { table: 'staff_roles', label: 'staff ranks' },
    { table: 'permission_roles', label: 'permission roles' },
    { table: 'command_settings', label: 'command switches' },
    { table: 'feature_settings', label: 'feature switches' },
    { table: 'guild_features', label: 'feature settings' },
    { table: 'event_log_config', label: 'logging settings' },
    { table: 'autoreact_users', label: 'auto-react users' },
    { table: 'role_rules', label: 'who-can-give rules' },
    { table: 'antiping_config', label: 'anti-ping settings' },
    { table: 'antiping_targets', label: 'anti-ping targets' },
    { table: 'scam_config', label: 'scam settings' },
    { table: 'scam_domains', label: 'scam domains' },
    { table: 'scam_exclusions', label: 'scam exclusions' },
    { table: 'newaccount_config', label: 'new-account settings' },
    { table: 'backup_config', label: 'backup schedule' },
    { table: 'antinuke_options', label: 'anti-nuke options' },
    { table: 'provider_config', label: 'Roblox providers' },
];
const GLOBAL = [{ table: 'bot_staff', label: 'bot staff' }];
const MAX_BYTES = 50 * 1024 * 1024;

export interface RestorePlan {
    takenAt: number | null;
    /** guild -> table -> rows to add */
    guilds: Map<string, Map<string, Record<string, unknown>[]>>;
    global: Map<string, Record<string, unknown>[]>;
    skippedChanged: number;
    skippedExpired: number;
    unknownServers: number;
    names: Map<string, string>;
}

/** Unzip if needed and open read-only; throws a clear error for anything that is not a Vanguard database. */
export function readBackup(bytes: Buffer): { db: DatabaseSync; close: () => void } {
    if (bytes.length > MAX_BYTES) throw new AppError('VALIDATION_ERROR', 'That file is over 50 MB, which is too big for a Vanguard database.');
    let raw = bytes;
    if (raw[0] === 0x1f && raw[1] === 0x8b) {
        try { raw = gunzipSync(raw, { maxOutputLength: MAX_BYTES * 4 }); } catch { throw new AppError('VALIDATION_ERROR', 'That .gz file could not be unpacked. Upload the file exactly as the bot sent it.'); }
    }
    if (raw.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000')
        throw new AppError('VALIDATION_ERROR', 'That is not a database file. Upload `vanguard.db` or a `vanguard-YYYY-MM-DD.db.gz` backup.');
    const dir = mkdtempSync(join(tmpdir(), 'vg-restore-'));
    const path = join(dir, 'source.db');
    writeFileSync(path, raw);
    let db: DatabaseSync;
    try { db = new DatabaseSync(path, { readOnly: true }); }
    catch { rmSync(dir, { recursive: true, force: true }); throw new AppError('VALIDATION_ERROR', 'That database file could not be opened.'); }
    const close = () => { try { db.close(); } catch { } rmSync(dir, { recursive: true, force: true }); };
    try {
        const ok = (db.prepare('PRAGMA integrity_check').get() as any)?.integrity_check;
        if (ok !== 'ok') throw new AppError('VALIDATION_ERROR', 'That database file is damaged (integrity check failed).');
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='grants'").get())
            throw new AppError('VALIDATION_ERROR', 'That database is not from Midtown Vanguard.');
    } catch (error) { close(); throw error; }
    return { db, close };
}

const columns = (db: { prepare(sql: string): { all(): unknown[] } }, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);
const hasTable = (db: DatabaseSync, table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);

export function planRestore(store: Store, source: DatabaseSync, now = Date.now()): RestorePlan {
    const live = store.db;
    const takenAt = hasTable(source, 'configuration_history')
        ? Number((source.prepare('SELECT MAX(at) AS at FROM configuration_history').get() as any)?.at) || null : null;
    const authorized = new Set(store.all("SELECT guild_id FROM guild_authorization WHERE state='AUTHORIZED'").map(r => String(r.guild_id)));
    const names = new Map(store.all('SELECT guild_id,name FROM guild_authorization').map(r => [String(r.guild_id), String(r.name ?? r.guild_id)]));
    const plan: RestorePlan = { takenAt, guilds: new Map(), global: new Map(), skippedChanged: 0, skippedExpired: 0, unknownServers: 0, names };
    const sourceGuilds = new Set<string>();

    const missing = (table: string, row: Record<string, unknown>, keys: string[]) =>
        !live.prepare(`SELECT 1 FROM ${table} WHERE ${keys.map(k => `${k} IS ?`).join(' AND ')}`).get(...keys.map(k => row[k] as any));
    const pkOf = (table: string) => (live.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[]).filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);

    for (const { table } of RESTORABLE) {
        if (!hasTable(source, table) || !hasTable(live as any, table)) continue;
        const shared = columns(source, table).filter(c => columns(live, table).includes(c));
        const keys = pkOf(table);
        if (!shared.includes('guild_id') || !keys.every(k => shared.includes(k))) continue;
        for (const row of source.prepare(`SELECT ${shared.join(',')} FROM ${table}`).all() as Record<string, unknown>[]) {
            const guild = String(row.guild_id);
            sourceGuilds.add(guild);
            if (!authorized.has(guild)) continue;
            if (table === 'grants') {
                if (row.expires != null && Number(row.expires) <= now) { plan.skippedExpired++; continue; }
                // Someone added, changed or removed this exact entry after the backup: their choice wins.
                const changed = takenAt != null && live.prepare("SELECT 1 FROM configuration_history WHERE guild_id=? AND component='grant' AND at>? AND (json_extract(before_json,'$.user_id')=? OR json_extract(after_json,'$.user_id')=?) AND (json_extract(before_json,'$.kind')=? OR json_extract(after_json,'$.kind')=?)")
                    .get(guild, takenAt, row.user_id as any, row.user_id as any, row.kind as any, row.kind as any);
                if (changed) { plan.skippedChanged++; continue; }
            }
            if (!missing(table, row, keys)) continue;
            const tables = plan.guilds.get(guild) ?? new Map<string, Record<string, unknown>[]>();
            tables.set(table, [...(tables.get(table) ?? []), row]);
            plan.guilds.set(guild, tables);
        }
    }
    for (const { table } of GLOBAL) {
        if (!hasTable(source, table) || !hasTable(live as any, table)) continue;
        const shared = columns(source, table).filter(c => columns(live, table).includes(c));
        const keys = pkOf(table);
        if (!keys.every(k => shared.includes(k))) continue;
        const rows = (source.prepare(`SELECT ${shared.join(',')} FROM ${table}`).all() as Record<string, unknown>[]).filter(row => missing(table, row, keys));
        if (rows.length) plan.global.set(table, rows);
    }
    plan.unknownServers = [...sourceGuilds].filter(g => !authorized.has(g)).length;
    return plan;
}

export function planSummary(plan: RestorePlan): { total: number; text: string } {
    const label = (t: string) => [...RESTORABLE, ...GLOBAL].find(r => r.table === t)?.label ?? t;
    const lines: string[] = [];
    let total = 0;
    for (const [guild, tables] of plan.guilds) {
        const parts = [...tables].map(([t, rows]) => { total += rows.length; return `${rows.length} ${label(t)}`; });
        lines.push(`**${plan.names.get(guild) ?? guild}**: ${parts.join(', ')}`);
    }
    for (const [t, rows] of plan.global) { total += rows.length; lines.push(`**Bot-wide**: ${rows.length} ${label(t)}`); }
    const notes = [
        plan.takenAt ? `Backup's newest setting change: <t:${Math.floor(plan.takenAt / 1000)}:f>.` : '',
        plan.skippedChanged ? `${plan.skippedChanged} whitelist entr${plan.skippedChanged === 1 ? 'y was' : 'ies were'} changed or removed since the backup, so left as they are now.` : '',
        plan.skippedExpired ? `${plan.skippedExpired} expired whitelist entr${plan.skippedExpired === 1 ? 'y' : 'ies'} skipped.` : '',
        plan.unknownServers ? `${plan.unknownServers} server(s) in the backup are not authorized now and were skipped.` : '',
    ].filter(Boolean);
    return { total, text: [total ? lines.join('\n') : '**Nothing to restore:** everything in that backup is already here (or was changed on purpose since).', notes.length ? `\n-# ${notes.join(' · ')}` : ''].join('\n') };
}

/** Insert the planned rows. Existing rows always win (INSERT OR IGNORE), so running it twice is harmless. */
export function applyRestore(store: Store, plan: RestorePlan, by: string): number {
    let added = 0;
    const insert = (table: string, row: Record<string, unknown>) => {
        const cols = Object.keys(row);
        const result = store.db.prepare(`INSERT OR IGNORE INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...cols.map(c => row[c] as any));
        added += Number(result.changes);
    };
    for (const [guild, tables] of plan.guilds)
        store.readGuild(guild, () => store.transaction(() => {
            for (const [table, rows] of tables) for (const row of rows) insert(table, row);
            store.history(guild, 'settings_restore', null, { rows: [...tables].reduce((n, [, r]) => n + r.length, 0), takenAt: plan.takenAt }, by);
        }));
    if (plan.global.size) store.transaction(() => { for (const [table, rows] of plan.global) for (const row of rows) insert(table, row); });
    return added;
}
