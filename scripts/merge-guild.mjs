/**
 * Midtown Vanguard: copy ONE server's settings and history from one database into another.
 *
 *   node merge-guild.mjs --bot <bot folder> --from <folder with source vanguard.db>
 *                        --into <folder with target vanguard.db> --guild <server ID> --out <new file>
 *
 * Neither input is changed. Both are copied to a temporary folder (with any -wal/-shm files,
 * so recent writes are included), brought up to the bot's current schema, and the result is
 * written to --out as one self-contained file.
 *
 * Everything the target database held for that server is replaced by the source's copy.
 * Every other server, and all bot-wide data (genrebans, hardbans, global staff), is kept
 * exactly as it is in the target.
 */
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const bot = resolve(opt('bot') ?? '.'), from = opt('from'), into = opt('into'), guild = opt('guild'), out = opt('out');
const fail = message => { console.error(`ERROR: ${message}`); process.exit(1); };
if (!from || !into || !guild || !out) fail('Usage: --bot <bot folder> --from <folder> --into <folder> --guild <server ID> --out <file>');
if (!/^\d{17,20}$/.test(guild)) fail(`"${guild}" is not a Discord server ID.`);
if (!existsSync(join(bot, 'dist', 'database', 'db.js'))) fail(`No Midtown Vanguard build in ${bot} (dist\\database\\db.js is missing).`);
if (existsSync(out)) fail(`${out} already exists. Pick a new output name so nothing is overwritten.`);

// Tables that only hold short-lived working state, or rows tied to bot-wide records.
const SKIP = new Set(['antinuke_event_payloads', 'observations', 'outbox', 'network_ban_results', 'leases']);
// Columns that point at a snapshot's row ID, which changes when the snapshot is copied.
const SNAPSHOT_REFS = { snapshot_metadata: ['snapshot_id'], recovery_history: ['snapshot_id', 'backup_id'], recovery_events: ['snapshot_id'] };

const work = mkdtempSync(join(tmpdir(), 'mv-merge-'));
function stage(folder, name) {
    const dir = resolve(folder), db = join(dir, 'vanguard.db');
    if (!existsSync(db)) stop(`No vanguard.db in ${dir}.`);
    const copy = join(work, name + '.db');
    copyFileSync(db, copy);
    for (const suffix of ['-wal', '-shm']) if (existsSync(db + suffix)) copyFileSync(db + suffix, copy + suffix);
    // A copy is never "in use", whatever its saved lock says.
    const raw = new DatabaseSync(copy);
    try {
        if (raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='leases'").get()) raw.exec('DELETE FROM leases');
        raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { raw.close(); }
    return copy;
}

let ok = false;
const stop = message => { throw new Error(message); };
try {
    const source = stage(from, 'source'), target = stage(into, 'target');
    // Bring both copies up to this bot version's tables and columns.
    const { Store } = await import(pathToFileURL(join(bot, 'dist', 'database', 'db.js')).href);
    for (const file of [source, target]) new Store(file).close();

    const src = new DatabaseSync(source, { readOnly: true });
    const dst = new DatabaseSync(target);
    // The bot's own scope guard is not needed here: rows are matched to the server explicitly.
    dst.function('check_scope', (_id) => null);
    dst.exec('PRAGMA foreign_keys=ON');

    const has = (db, sql, ...p) => db.prepare(sql).get(...p);
    const auth = has(src, 'SELECT state,name FROM guild_authorization WHERE guild_id=?', guild);
    if (!auth) stop(`Server ${guild} is not in the source database. Check the ID and the --from folder.`);
    console.log(`Server: ${auth.name ?? guild} (${guild}) - state in source: ${auth.state}`);
    const before = has(dst, 'SELECT state FROM guild_authorization WHERE guild_id=?', guild);
    console.log(before ? `Target already knows this server (state: ${before.state}); its copy will be replaced.` : 'Target does not know this server yet; it will be added.');

    const tables = src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
    const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all();
    const keyOf = t => {
        const names = cols(dst, t).map(c => c.name);
        return t === 'recovery_mappings' ? 'destination_guild' : names.includes('guild_id') ? 'guild_id' : null;
    };
    const copyable = tables.filter(t => !SKIP.has(t) && has(dst, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", t) && keyOf(t));
    // Parents first: guild_data, authorization, snapshots before the rows that point at them.
    const order = ['guild_data', 'guild_authorization', 'snapshots'];
    copyable.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b));

    const counts = [];
    dst.exec('BEGIN IMMEDIATE');
    try {
        // Remove the target's old rows for this server (children before parents).
        for (const t of [...copyable].reverse().concat([...SKIP].filter(t => t !== 'leases' && t !== 'network_ban_results' && keyOf(t))))
            dst.prepare(`DELETE FROM ${t} WHERE ${keyOf(t)}=?`).run(guild);
        const snapshotIds = new Map();
        for (const t of copyable) {
            const key = keyOf(t);
            const shared = cols(src, t).map(c => c.name).filter(n => cols(dst, t).some(c => c.name === n));
            const auto = /AUTOINCREMENT/i.test(has(dst, "SELECT sql FROM sqlite_master WHERE name=?", t).sql);
            const insertCols = auto ? shared.filter(n => n !== 'id') : shared;
            const rows = src.prepare(`SELECT * FROM ${t} WHERE ${key}=? ${auto ? 'ORDER BY id' : ''}`).all(guild);
            if (!rows.length) continue;
            const insert = dst.prepare(`INSERT INTO ${t}(${insertCols.join(',')}) VALUES(${insertCols.map(() => '?').join(',')})`);
            const notNull = new Set(cols(dst, t).filter(c => c.notnull).map(c => c.name));
            let copied = 0;
            rows: for (const row of rows) {
                for (const ref of SNAPSHOT_REFS[t] ?? [])
                    if (row[ref] != null) {
                        if (snapshotIds.has(Number(row[ref]))) row[ref] = snapshotIds.get(Number(row[ref]));
                        // Points at a snapshot that belongs to another server: keep the row only if the link is optional.
                        else if (notNull.has(ref)) continue rows;
                        else row[ref] = null;
                    }
                copied++;
                const result = insert.run(...insertCols.map(n => row[n] ?? null));
                if (t === 'snapshots') snapshotIds.set(Number(row.id), Number(result.lastInsertRowid));
            }
            counts.push(`${t}: ${copied}`);
        }
        const fk = dst.prepare('PRAGMA foreign_key_check').all();
        if (fk.length) throw new Error(`Foreign-key check failed: ${JSON.stringify(fk.slice(0, 3))}`);
        dst.exec('COMMIT');
    } catch (error) {
        dst.exec('ROLLBACK');
        throw error;
    }
    if (dst.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Integrity check failed on the merged copy.');
    dst.exec(`VACUUM INTO '${resolve(out).replace(/'/g, "''")}'`);
    src.close(); dst.close();

    // Final proof: the bot itself can open the result, and the server is authorized there.
    const check = new Store(resolve(out));
    const state = check.authorization(guild)?.state;
    const servers = check.all("SELECT COUNT(*) AS n FROM guild_authorization WHERE state='AUTHORIZED'")[0].n;
    check.close();
    for (const suffix of ['-wal', '-shm']) rmSync(resolve(out) + suffix, { force: true });
    console.log(`Copied: ${counts.join(' - ') || 'nothing'}`);
    console.log(`Merged database written: ${resolve(out)} (${Math.round(statSync(resolve(out)).size / 1024)} KB)`);
    console.log(`In the merged database: ${guild} is ${state}; ${servers} server(s) authorized in total.`);
    ok = true;
} catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
    rmSync(resolve(out), { force: true });
    process.exitCode = 1;
} finally {
    rmSync(work, { recursive: true, force: true });
    if (ok) console.log('Neither input database was changed.');
}
