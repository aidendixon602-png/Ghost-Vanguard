import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { dmTrusted, trustedRecipients } from '../src/bot/trusted-dm.js';

test('only the trusted DM list gets bot DMs: Supreme Leaders and developers are not added by their rank', async () => {
    const before = new Set(config.trustedDmIds);
    try {
        config.trustedDmIds.clear(); config.trustedDmIds.add('111111111111111111');
        config.supremeExtra.add('333333333333333333'); config.developers.add('222222222222222222');
        assert.deepEqual(trustedRecipients(), ['111111111111111111']);
        const sent: string[] = [];
        const client: any = { users: { fetch: async (id: string) => ({ send: async () => { sent.push(id); } }) } };
        assert.equal(await dmTrusted(client, { content: 'backup' }), 1);
        assert.deepEqual(sent, ['111111111111111111'], 'the backup file never reaches a Supreme Leader or developer who is not on the list');
        assert.equal(await dmTrusted(undefined, { content: 'x' }), 0);
    } finally {
        config.trustedDmIds.clear(); for (const id of before) config.trustedDmIds.add(id);
        config.developers.delete('222222222222222222'); config.supremeExtra.delete('333333333333333333');
    }
});

test('no Supreme Leader is built into the code, and every start lists who has bot-wide access', async () => {
    const { Store } = await import('../src/database/db.js');
    const { accessSummary } = await import('../src/bot/access-summary.js');
    const { isSupreme } = await import('../src/bot/ranks.js');
    if (!process.env.SUPREME_LEADER_IDS) assert.equal(config.supremeExtra.size, 0, 'nobody is a Supreme Leader unless SUPREME_LEADER_IDS lists them');
    assert.equal(isSupreme('843909457616044092'), false, 'the old built-in account has no special access');
    const store = new Store(':memory:');
    try {
        store.run("INSERT INTO bot_staff(user_id,level,by_id,at) VALUES('444444444444444444','botmanager','x',1)");
        store.run("INSERT INTO bot_staff(user_id,level,by_id,at) VALUES('555555555555555555','supreme','x',1)");
        const text = accessSummary(store).join('\n');
        assert.match(text, /Supreme.*555555555555555555/);
        assert.match(text, /Bot-wide.*444444444444444444 \(botmanager\)/);
        assert.match(text, /Bot DMs to/);
    } finally { store.close(); }
});
