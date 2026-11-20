import test from 'node:test';
import assert from 'node:assert/strict';
import { readableDuration, startupSummary } from '../src/console-ui.js';

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

test('startup banner shows startup time, authorized servers, members, data and runtime', () => {
    const text = startupSummary({ version: '3.2.1', tag: 'Ghost Vanguard#5397', servers: 9, authorized: 9, members: 12345,
        commands: 68, commandsUpdated: false, verification: 'Roblox profile code',
        integrations: { 'AI moderation': false, Rover: true, Bloxlink: false, Heartbeat: false },
        database: '4.7 MB · data/vanguard.db', backups: 'every 60 min · data/database-backups',
        dashboard: 'http://127.0.0.1:7475/ · token required', health: 'http://127.0.0.1:7475/healthz',
        runtime: 'Node v24.22.2 · 128 MB · API 42 ms', startedInMs: 4200 }).map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
    assert.match(text, /SYSTEM ONLINE.*ready in 4\.2 s/);
    assert.match(text, /Servers\s+9 connected.*9 authorized/);
    assert.match(text, /Members\s+12,345 across authorized servers/);
    assert.match(text, /Rover ON/);
    assert.match(text, /Database\s+4\.7 MB · data\/vanguard\.db/);
    assert.match(text, /Backups\s+every 60 min · data\/database-backups/);
    assert.match(text, /Dashboard\s+http:\/\/127\.0\.0\.1:7475\/ · token required/);
    assert.match(text, /Runtime\s+Node v24\.22\.2 · 128 MB · API 42 ms/);
});

test('startup banner flags servers that are connected but not authorized, and hides empty rows', () => {
    const text = startupSummary({ version: '3.2.1', tag: 'Bot', servers: 9, authorized: 7, members: 0,
        commands: 68, commandsUpdated: false, verification: 'Roblox profile code',
        integrations: { 'AI moderation': false }, health: 'http://127.0.0.1:7475/healthz' }).map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n');
    assert.match(text, /Servers\s+9 connected.*7 authorized.*2 not authorized yet/);
    assert.doesNotMatch(text, /Members|Database|Backups|Dashboard|Runtime|ready in/, 'nothing to report, nothing printed');
});

test('readableDuration rounds sub-second starts and formats seconds', () => {
    assert.equal(readableDuration(350), '350 ms');
    assert.equal(readableDuration(4200), '4.2 s');
    assert.equal(readableDuration(65_000), '65.0 s');
});
