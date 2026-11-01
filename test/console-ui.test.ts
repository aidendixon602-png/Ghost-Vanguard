import test from 'node:test';
import assert from 'node:assert/strict';
import { startupSummary } from '../src/console-ui.js';

test('startup console panel clearly reports online state and module status', () => {
    const rawLines = startupSummary({ version: '3.0.0', tag: 'Ghost Vanguard#5397', servers: 10, commands: 68, commandsUpdated: false,
        verification: 'Roblox profile code', integrations: { 'AI moderation': true }, health: 'http://0.0.0.0:9576/healthz' });
    const lines = rawLines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ''));
    const text = lines.join('\n');
    assert.match(text, /(MIDTOWN|GHOST) VANGUARD/);
    assert.match(text, /SYSTEM ONLINE/);
    assert.match(text, /10 connected/);
    assert.match(text, /68 registered.*up to date/);
    assert.match(text, /Verification\s+Roblox profile code/);
    assert.match(text, /AI moderation ON/);
    assert.match(text, /healthz/);
    assert.doesNotMatch(text, /[╭╮╰╯│]/);
});

test('startup status preserves long addresses and reports no servers or disabled AI', () => {
    const health = `http://${'long-hostname'.repeat(8)}:7475/healthz`;
    const text = startupSummary({ version: '3.0.0', tag: 'Bot', servers: 0, commands: 1, commandsUpdated: true,
        verification: 'Roblox profile code', integrations: { 'AI moderation': false }, health }).join('\n');
    assert.ok(text.includes(health));
    assert.match(text, /not in any servers yet/);
    assert.match(text, /updated on Discord/);
    assert.match(text, /AI moderation.*off/);
});
