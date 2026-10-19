import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export function updatePreflight(project, env = process.env, now = Date.now()) {
    let configured = env.DATABASE_PATH;
    if (!configured && existsSync(resolve(project,'.env'))) {
        const line = readFileSync(resolve(project,'.env'),'utf8').match(/^\s*(?:export\s+)?DATABASE_PATH\s*=\s*(.*)$/m)?.[1]?.trim();
        if (line) configured = /^['"]/.test(line) ? line.slice(1,line.lastIndexOf(line[0])) : line.split(/\s+#/)[0].trim();
    }
    const path = resolve(project, configured || './data/vanguard.db');
    if (!existsSync(path)) return;
    const db = new DatabaseSync(path,{readOnly:true});
    try {
        const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='leases'").get();
        if (exists && db.prepare('SELECT 1 FROM leases WHERE name=? AND until>?').get('bot',now))
            throw new Error('Vanguard is running or its 30-second startup lease has not expired. Stop the bot, wait 30 seconds, then rerun this updater. No project files were changed.');
    } finally {db.close();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
    try {updatePreflight(resolve(process.argv[2]||process.cwd()));console.log('Update preflight passed.');}
    catch(error) {console.error(error instanceof Error && error.message.includes('Vanguard is running') ? error.message : 'Cannot verify that the database is idle. Stop Vanguard and check database access before retrying. No project files were changed.');process.exitCode=1;}
}
