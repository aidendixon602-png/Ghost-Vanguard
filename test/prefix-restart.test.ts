import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrefixRestartMessage, requestPrefixRestart } from '../src/bot/prefix-restart.js';

const message = (content: string, author: { id: string; bot: boolean } = { id: 'dev', bot: false }, guildId: string | null = 'guild') => ({ content, author, guildId });

test('the comma restart command matches only the exact command from a human in a server', () => {
    assert.equal(isPrefixRestartMessage(message(',restart')), true);
    assert.equal(isPrefixRestartMessage(message('  ,restart  ')), true);
    assert.equal(isPrefixRestartMessage(message(',RESTART')), true);
    assert.equal(isPrefixRestartMessage(message(',restart now')), false);
    assert.equal(isPrefixRestartMessage(message('hello ,restart')), false);
    assert.equal(isPrefixRestartMessage(message(',restart', { id: 'bot', bot: true })), false);
    assert.equal(isPrefixRestartMessage(message(',restart', { id: 'dev', bot: false }, null)), false);
});

test('only the bot owner or configured developers can request a restart', async () => {
    let asked = false;
    const result = await requestPrefixRestart('member', {
        isDeveloper: () => false,
        askRestart: async () => { asked = true; return true; },
        fallbackRestart: () => 'scheduled',
    });
    assert.equal(result, 'not-authorized');
    assert.equal(asked, false);
});

test('an approved developer uses the launcher restart request', async () => {
    let requestedBy = '';
    const result = await requestPrefixRestart('developer-id', {
        isDeveloper: id => id === 'developer-id',
        askRestart: async id => { requestedBy = id; return true; },
        fallbackRestart: () => 'no-launcher',
    });
    assert.equal(result, 'restarting');
    assert.equal(requestedBy, 'developer-id');
});

test('busy launcher requests do not run the fallback', async () => {
    let usedFallback = false;
    const result = await requestPrefixRestart('developer-id', {
        isDeveloper: () => true,
        askRestart: async () => false,
        fallbackRestart: () => { usedFallback = true; return 'scheduled'; },
    });
    assert.equal(result, 'busy');
    assert.equal(usedFallback, false);
});

test('a silent launcher uses the available fallback result', async () => {
    const result = await requestPrefixRestart('developer-id', {
        isDeveloper: () => true,
        askRestart: async () => null,
        fallbackRestart: () => 'scheduled',
    });
    assert.equal(result, 'scheduled');
});
