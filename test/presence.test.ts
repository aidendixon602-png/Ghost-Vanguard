import test from 'node:test';
import assert from 'node:assert/strict';
import { presenceLines } from '../src/security/protection-stats.js';

test('presence reads naturally, with correct plurals and thousands separators', () => {
    assert.deepEqual(presenceLines({ guilds: 12, users: 4821, robloxUsers: 1500, complete: true }), [
        '🛡️ Protecting 12 servers',
        '👥 Watching over 4,821 members',
        '🎮 1,500 verified Roblox accounts',
        '💬 Use /help to see commands',
    ]);
    assert.equal(presenceLines({ guilds: 1, users: 1, robloxUsers: 1, complete: true })[0], '🛡️ Protecting 1 server');
});

test('presence skips the Roblox line when nobody is verified and flags partial member counts', () => {
    const lines = presenceLines({ guilds: 3, users: 250, robloxUsers: 0, complete: false });
    assert.equal(lines.length, 3);
    assert.ok(!lines.some(l => l.includes('Roblox')));
    assert.equal(lines[1], '👥 Watching over 250 known members');
});
