// Regenerates docs/commands.md and docs/ranks.md from the live command definitions: npm run docs
import { writeFileSync } from 'node:fs';
import { Registry } from '../src/bot/registry.js';
import { commandsDoc, ranksDoc } from '../src/ui/command-docs.js';
const r = new Registry(); await r.load();
writeFileSync('docs/commands.md', commandsDoc(r));
writeFileSync('docs/ranks.md', ranksDoc(r));
console.log('docs/commands.md and docs/ranks.md written');
