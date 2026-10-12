import { readFile, writeFile, copyFile } from 'node:fs/promises';
// Run from the bot folder. Preserve all existing settings and never print secrets.
let text = '';
try { text = await readFile('.env', 'utf8'); await copyFile('.env', `.env.before-scam-${Date.now()}.bak`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
text = /^MESSAGE_CONTENT_ENABLED\s*=/m.test(text)
    ? text.replace(/^MESSAGE_CONTENT_ENABLED\s*=.*$/gm, 'MESSAGE_CONTENT_ENABLED=true')
    : text.replace(/\s*$/, '\n') + 'MESSAGE_CONTENT_ENABLED=true\n';
await writeFile('.env', text, { mode: 0o600 });
console.log('MESSAGE_CONTENT_ENABLED=true saved. Existing settings were preserved.');
console.log('Before starting, enable Message Content Intent in Discord Developer Portal → Bot.');
console.log('For Wispbyte, set MESSAGE_CONTENT_ENABLED=true in panel variables too if the panel supplies it.');
console.log('Restart: authorized servers set up scam protection automatically. Saved disables and reporting exclusions are retained.');
