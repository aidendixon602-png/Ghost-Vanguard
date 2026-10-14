import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Registry } from '../src/bot/registry.js';
import { commandsDoc, ranksDoc } from '../src/ui/command-docs.js';

test('docs/commands.md and docs/ranks.md match the commands the bot really has (run `npm run docs` after changing commands)', async () => {
    const r = new Registry(); await r.load(new URL('../src/commands', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    assert.equal(readFileSync(new URL('../docs/commands.md', import.meta.url), 'utf8'), commandsDoc(r), 'docs/commands.md is out of date: run npm run docs');
    assert.equal(readFileSync(new URL('../docs/ranks.md', import.meta.url), 'utf8'), ranksDoc(r), 'docs/ranks.md is out of date: run npm run docs');
});

test('owner-only actions stay owner-only even for Head Admins', async () => {
    const { requiredRank, RANKS } = await import('../src/bot/ranks.js');
    assert.equal(requiredRank('security/admin'), RANKS.owner);
    assert.equal(requiredRank('config-history/restore'), RANKS.owner);
    assert.ok(requiredRank('security/status')! < RANKS.owner, 'the rest of /security is unchanged');
});
