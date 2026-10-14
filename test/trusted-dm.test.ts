import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { dmTrusted, trustedRecipients } from '../src/bot/trusted-dm.js';

test('only the trusted DM list gets bot DMs: Supreme Leaders and developers are not added by their rank', async () => {
    const before = new Set(config.trustedDmIds);
    try {
        config.trustedDmIds.clear(); config.trustedDmIds.add('111111111111111111');
        config.supremeExtra.add('843909457616044092'); config.developers.add('222222222222222222');
        assert.deepEqual(trustedRecipients(), ['111111111111111111']);
        const sent: string[] = [];
        const client: any = { users: { fetch: async (id: string) => ({ send: async () => { sent.push(id); } }) } };
        assert.equal(await dmTrusted(client, { content: 'backup' }), 1);
        assert.deepEqual(sent, ['111111111111111111'], 'the backup file never reaches a Supreme Leader or developer who is not on the list');
        assert.equal(await dmTrusted(undefined, { content: 'x' }), 0);
    } finally {
        config.trustedDmIds.clear(); for (const id of before) config.trustedDmIds.add(id);
        config.developers.delete('222222222222222222');
    }
});
