import test from 'node:test';
import assert from 'node:assert/strict';
import { requestRestart } from '../src/bot/restart-request.js';

test('an unauthorized user cannot request a restart', async () => {
    let asked = false;
    const result = await requestRestart('member', {
        isDeveloper: () => false,
        askRestart: async () => { asked = true; return true; },
        fallbackRestart: () => 'scheduled',
    });
    assert.equal(result, 'not-authorized');
    assert.equal(asked, false);
});

test('an approved developer uses the launcher restart request', async () => {
    let requestedBy = '';
    const result = await requestRestart('developer-id', {
        isDeveloper: id => id === 'developer-id',
        askRestart: async id => { requestedBy = id; return true; },
        fallbackRestart: () => 'no-launcher',
    });
    assert.equal(result, 'restarting');
    assert.equal(requestedBy, 'developer-id');
});

test('busy launcher requests do not run the fallback', async () => {
    let usedFallback = false;
    const result = await requestRestart('developer-id', {
        isDeveloper: () => true,
        askRestart: async () => false,
        fallbackRestart: () => { usedFallback = true; return 'scheduled'; },
    });
    assert.equal(result, 'busy');
    assert.equal(usedFallback, false);
});

test('a silent launcher uses the available fallback result', async () => {
    const result = await requestRestart('developer-id', {
        isDeveloper: () => true,
        askRestart: async () => null,
        fallbackRestart: () => 'scheduled',
    });
    assert.equal(result, 'scheduled');
});
