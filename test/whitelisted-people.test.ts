import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { Store } from '../src/database/db.js';
import { Security } from '../src/security/security.js';
import { isWhitelistedPerson, WHITELISTED_PEOPLE } from '../src/bot/trusted-bots.js';
import { assertNotProtectedUser } from '../src/ui/ui.js';
import { assertTargetable, enforceOnJoin } from '../src/security/network-ban.js';
import { config } from '../src/config.js';
import { authorize } from './helpers.js';

const SIMI = '843909457616044092';

test('thesimisear is whitelisted in the code', () => {
    assert.equal(WHITELISTED_PEOPLE.get(SIMI), 'thesimisear');
    assert.ok(isWhitelistedPerson(SIMI) && !isWhitelistedPerson('1') && !isWhitelistedPerson(null));
});

test('no moderation command can target them, not even a Developer\'s', () => {
    config.developers.add('9001');
    try {
        assert.throws(() => assertNotProtectedUser(SIMI, '9001'), /whitelisted on Ghost Vanguard/);
        assert.throws(() => assertTargetable({ user: { id: 'bot' } } as any, SIMI, '9001'), /whitelisted on Ghost Vanguard/);
        assert.doesNotThrow(() => assertNotProtectedUser('5', '9001'));
    } finally { config.developers.delete('9001'); }
});

test('anti-nuke and everything that uses its trust leave them alone', async () => {
    const store = new Store(':memory:'); authorize(store, 'g');
    const settings = store.settings('g'); settings.enabled = true; settings.mode = 'enforce'; store.save(settings);
    const security = new Security(store, { push: () => undefined } as any);
    const guild: any = { id: 'g', ownerId: 'owner', client: { user: { id: 'bot' } }, roles: { cache: new Collection() }, members: { cache: new Collection(), fetch: async () => null } };
    let punished = 0;
    security.punish = async () => { punished++; return ''; };
    try {
        assert.ok(security.trusted(guild, SIMI));
        assert.equal(security.exemptReason(guild, SIMI), 'whitelisted on Ghost Vanguard');
        await security.audit({ id: 'e', executorId: SIMI, targetId: 'x', action: 22, createdTimestamp: Date.now(), changes: [] } as any, guild);
        assert.equal(punished, 0);
        assert.equal(store.get('SELECT COUNT(*) AS n FROM incidents')!.n, 0, 'not even recorded as an incident');
        assert.match(await security.contain(guild, SIMI), /Protected executor/);
    } finally { store.close(); }
});

test('an old network ban on record is never enforced on them', async () => {
    let banned = 0;
    const guild: any = { id: 'g', members: { ban: async () => { banned++; } } };
    assert.equal(await enforceOnJoin({ isReady: () => true, store: { get: () => ({ kind: 'hardban', user_id: SIMI }) } } as any, guild, SIMI), false);
    assert.equal(banned, 0);
});
