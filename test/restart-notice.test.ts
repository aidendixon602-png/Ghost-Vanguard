import test from 'node:test';
import assert from 'node:assert/strict';
import type { Client } from 'discord.js';
import { Store } from '../src/database/db.js';
import { completeRestartNotice, formatDowntime, restartNoticeText, saveRestartNotice } from '../src/bot/restart-notice.js';

test('the restart status is plain text with a dynamic Discord ETA and no forced delay', () => {
    const requestedAt = 1_800_000_000_123;
    const expectedEta = Math.floor((requestedAt + 30_000) / 1000);
    const text = restartNoticeText(requestedAt);
    assert.match(text, new RegExp(`<t:${expectedEta}:R>`));
    assert.match(text, /not a forced wait/);
    assert.doesNotMatch(text, /embed/i);
});

test('restart downtime is formatted clearly at seconds, minutes, and hours', () => {
    assert.equal(formatDowntime(0), '0s');
    assert.equal(formatDowntime(63), '1m 3s');
    assert.equal(formatDowntime(3723), '1h 2m 3s');
    assert.equal(formatDowntime(-4), '0s');
});

test('the new process edits the original restart reply with actual uptime details', async () => {
    const store = new Store(':memory:');
    try {
        const requestedAt = 1_800_000_000_000;
        assert.equal(saveRestartNotice(store, 'channel-1', 'message-1', requestedAt), true);
        assert.equal(saveRestartNotice(store, 'channel-2', 'message-2', requestedAt + 1_000), false,
            'a second restart notice cannot replace the active one');

        let fetchedChannel = '';
        let fetchedMessage = '';
        let edited = '';
        const client = {
            channels: {
                fetch: async (id: string) => {
                    fetchedChannel = id;
                    return {
                        isTextBased: () => true,
                        messages: {
                            fetch: async (messageId: string) => {
                                fetchedMessage = messageId;
                                return { edit: async (content: string) => { edited = content; } };
                            },
                        },
                    };
                },
            },
        } as unknown as Client;

        assert.equal(await completeRestartNotice(client, store, requestedAt + 12_900, 14, 27), true);
        assert.equal(fetchedChannel, 'channel-1');
        assert.equal(fetchedMessage, 'message-1');
        assert.match(edited, /Actual downtime: 12s/);
        assert.match(edited, /14 servers connected · 27 commands ready/);
        assert.match(edited, /Startup checks and command sync are complete/);
        assert.equal(store.get('SELECT id FROM restart_notices WHERE id=?', 1), undefined,
            'the saved notice is consumed after reconnect');
    } finally {
        store.close();
    }
});
