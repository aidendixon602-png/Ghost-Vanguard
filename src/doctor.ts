import { existsSync } from 'node:fs';
import { config, validateConfig } from './config.js';
import { Store } from './database/db.js';
import { Registry } from './bot/registry.js';

const registry = new Registry();

await registry.load();
console.log(`Midtown Vanguard doctor · Node ${process.version}`);
console.log(`.env present: ${existsSync('.env')}`);

const errors = validateConfig();

for (const error of errors)
    console.error(`FIX: ${error}`);

console.log(`Commands defined: ${registry.commands.size}`);
console.log(`RoVer key configured: ${!!config.roverKey}; Bloxlink key configured: ${!!config.bloxlinkKey}`);
console.log(`AI enabled: ${config.aiEnabled}; OpenAI key configured: ${!!config.openaiKey}`);

try {
    const store = new Store(config.dbPath);
    console.log(`Database check: ${store.get('PRAGMA quick_check')?.quick_check}`);
    console.log(`Authorized servers: ${store.all("SELECT guild_id FROM guild_authorization WHERE state='AUTHORIZED'").length}`);
    store.close();
} catch {
    console.error('FIX: Cannot open SQLite database. Check DATABASE_PATH and folder write permissions.');
    errors.push('database');
}

console.log('No credentials or live API requests were used by this diagnostic.');
process.exitCode = errors.length ? 1 : 0;
