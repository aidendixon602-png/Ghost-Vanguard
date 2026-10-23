import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/database/db.js';
import { whitelistCheck } from '../src/ui/whitelist-check.js';
import { authorize } from './helpers.js';

const guild: any = { id: 'g', ownerId: 'owner', client: { user: { id: 'vanguard' } } };

test('whitelist check: owner, full bypass, role-based rules, warnings and quarantine are all explained', () => {
    const store = new Store(':memory:'); authorize(store);
    try {
        assert.match(whitelistCheck(store, guild, 'owner', [], false).toJSON().description!, /server owner/);
        assert.match(whitelistCheck(store, guild, 'nobody', [], false).toJSON().description!, /not whitelisted/);
        const plain = whitelistCheck(store, guild, 'nobody', [], false).toJSON();
        assert.match(plain.fields!.find(f => f.name === 'Still checked')!.value, /Role Invite\*\*: 8 in 60s → strip \(warns first\)/);

        store.grant('g', 'staffrole', 'trust_role:role_grant', 'owner'); store.grant('g', 'staffrole', 'trust_role:role_update', 'owner');
        store.grant('g', 'person', 'trust:mass_ban', 'owner', 24);
        const staff = whitelistCheck(store, guild, 'person', ['staffrole'], false).toJSON();
        assert.match(staff.description!, /whitelisted for \*\*3\*\* rule/);
        const ignored = staff.fields!.find(f => f.name === 'Not punished for (still alerted)')!.value;
        assert.match(ignored, /Role Invite\*\* · from <@&staffrole>, permanent/);
        assert.match(ignored, /\*\*Ban\*\* · until <t:\d+:f>/);
        assert.match(staff.description!, /Administrator\*\* or \*\*Manage Server\*\* still strips/);

        store.run('INSERT INTO incidents(guild_id,actor_id,rule,at,mode,result) VALUES(?,?,?,?,?,?)', 'g', 'person', 'timeout', Date.now(), 'warn', 'Warning');
        store.run('INSERT INTO backups(guild_id,user_id,roles,at,active) VALUES(?,?,?,?,1)', 'g', 'person', '[]', Date.now());
        const after = whitelistCheck(store, guild, 'person', ['staffrole'], false).toJSON().description!;
        assert.match(after, /Warned <t:\d+:R>/); assert.match(after, /Quarantined/);

        store.grant('g', 'adminrole', 'trust_role', 'owner');
        assert.match(whitelistCheck(store, guild, 'person', ['adminrole'], false).toJSON().description!, /full bypass.*<@&adminrole>/);
        assert.match(whitelistCheck(store, guild, '426537812993638400', [], true).toJSON().description!, /Bloxlink.*never counted/);
    } finally { store.close(); }
});
