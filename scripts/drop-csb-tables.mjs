/**
 * Removes the leftover Community Safety Branch (CSB) tables from the database.
 *
 * Version 2.22.0 removed /csb with its Google Sheets and Trello integrations. Older databases
 * still hold the csb_records, csb_events, csb_drafts, csb_sequence and csb_sheet_updates
 * tables. Nothing reads them now.
 *
 *   npm run database:drop-csb                          preview only: shows what would be removed
 *   npm run database:drop-csb -- --confirm DROP-CSB    removes the tables
 *
 * Before removing anything, the script:
 *   - refuses to run while the bot is running (it checks the bot's database lease)
 *   - exports every CSB row to data/csb-export-<time>.json
 *   - saves a full copy of the database to data/before-drop-csb-<time>.db
 * Stop the bot first.
 */
import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

const TABLES = ['csb_sheet_updates', 'csb_events', 'csb_drafts', 'csb_sequence', 'csb_records'];
const args = process.argv.slice(2);
const confirmed = args[args.indexOf('--confirm') + 1] === 'DROP-CSB' && args.includes('--confirm');
const path = resolve(process.env.DATABASE_PATH || './data/vanguard.db');

if (!existsSync(path)) {
    console.error(`No database found at ${path}. Set DATABASE_PATH if it lives elsewhere.`);
    process.exit(1);
}

const db = new DatabaseSync(path);
try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='leases'").get()
        && db.prepare('SELECT 1 FROM leases WHERE name=? AND until>?').get('bot', Date.now())) {
        console.error('The bot is still running, or stopped less than 30 seconds ago. Stop it, wait 30 seconds, then try again.');
        process.exit(1);
    }

    const present = TABLES.filter(t => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));
    if (!present.length) {
        console.log('No CSB tables found. Nothing to do.');
        process.exit(0);
    }

    const counts = Object.fromEntries(present.map(t => [t, Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n)]));
    console.log(`Database: ${path}`);
    for (const [table, n] of Object.entries(counts))
        console.log(`  ${table}: ${n} row${n === 1 ? '' : 's'}`);

    if (!confirmed) {
        console.log('\nPreview only. Nothing was changed.');
        console.log('To export these rows, back up the database and remove the tables, run:');
        console.log('  npm run database:drop-csb -- --confirm DROP-CSB');
        process.exit(0);
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true });

    // 1. Readable export of every CSB row.
    const exportPath = join(directory, `csb-export-${stamp}.json`);
    const data = Object.fromEntries(present.map(t => [t, db.prepare(`SELECT * FROM ${t}`).all()]));
    writeFileSync(exportPath, JSON.stringify({ exportedAt: new Date().toISOString(), database: path, tables: data }, null, 2));
    chmodSync(exportPath, 0o600);
    console.log(`\nExported CSB rows to ${exportPath}`);

    // 2. Full, consistent copy of the database as it is right now.
    const backupPath = join(directory, `before-drop-csb-${stamp}.db`);
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    chmodSync(backupPath, 0o600);
    const check = new DatabaseSync(backupPath, { readOnly: true });
    try {
        if (check.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
            throw Error('The backup copy failed its integrity check. Nothing was removed.');
    } finally {
        check.close();
    }
    console.log(`Saved a full database backup to ${backupPath}`);

    // 3. Remove the tables in one transaction: all go, or none do.
    db.exec('BEGIN IMMEDIATE');
    try {
        for (const table of present)
            db.exec(`DROP TABLE IF EXISTS ${table}`);
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
    if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok')
        throw Error(`Integrity check failed after removing the tables. Restore from ${backupPath}.`);
    console.log(`Removed ${present.join(', ')}. Start the bot normally.`);
} finally {
    db.close();
}
