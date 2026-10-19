import test from 'node:test';
import assert from 'node:assert/strict';
import { startupSummary } from '../src/console-ui.js';

test('startup console panel clearly reports online state and module status', () => {
    const lines = startupSummary({ version: '3.0.0', tag: 'Ghost Vanguard#5397', servers: 10, commands: 68, commandsUpdated: false,
        integrations: { RoVer: false, Bloxlink: false, AI: true }, health: 'http://0.0.0.0:9576/healthz' });
    const text = lines.join('\n');
    assert.match(text, /GHOST VANGUARD/);
    assert.match(text, /SYSTEM ONLINE/);
    assert.match(text, /10 connected/);
    assert.match(text, /68 registered.*up to date/);
    assert.match(text, /RoVer off.*Bloxlink off.*AI ON/);
    assert.match(text, /healthz/);
    assert.ok(lines.some(line => line.startsWith('  ╭')));
    assert.ok(lines.some(line => line.startsWith('  ╰')));
});
