import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, PermissionFlagsBits } from 'discord.js';
import { ageDays, Cooldowns, dangerous, decideLinks, escalationAdded, KeyedQueue, overrideRule, RULES, ruleFor } from '../src/core.js';
import { parseIds } from '../src/config.js';
import { Registry } from '../src/bot/registry.js';

const registry = new Registry();

await registry.load();

const commandJSON = registry.json;

import { remapOverwrites } from '../src/recovery/snapshots.js';
import { memberOrNull } from '../src/ui/ui.js';

test('all modular commands serialize with unique names and no duplicate trust aliases', () => {
    assert.equal(commandJSON.length, 61);
    assert.equal(new Set(commandJSON.map(c => c.name )).size, 61);
    assert.ok(!commandJSON.some(c => ['antinukeunauth', 'antinukeauthlist'].includes(c.name)));
    for (const c of commandJSON)
        assert.deepEqual(c.contexts, [0]);
});

test('seventeen rules, all audit action mappings unambiguous', () => {
    assert.equal(RULES.length, 17);
    assert.equal(new Set(RULES.map(r => r.key)).size, RULES.length);
    const actions = RULES.flatMap(r => r.actions);
    assert.equal(new Set(actions).size, actions.length);
    assert.equal(ruleFor(AuditLogEvent.MemberBanAdd)?.key, 'mass_ban');
    assert.equal(ruleFor(AuditLogEvent.ChannelOverwriteDelete)?.key, 'channel_update');
    assert.equal(ruleFor(AuditLogEvent.MemberRoleUpdate)?.key, 'role_grant');
    assert.equal(ruleFor(AuditLogEvent.IntegrationDelete), undefined);
    assert.equal(ruleFor(AuditLogEvent.MemberPrune)?.key, 'member_prune');
    assert.equal(ruleFor(AuditLogEvent.AutoModerationRuleDelete)?.key, 'automod_tamper');
});

test('the preset is fixed: shared limits, per-rule overrides and toggles never change a rule', () => {
    for (const rule of RULES) {
        const changed = overrideRule(rule, { [rule.key]: { count: 99, seconds: 300, enabled: false } as any }, { count: 50, seconds: 5 });
        assert.deepEqual(changed, rule);
    }
});

test('escalationAdded reports only newly granted escalation permissions', () => {
    const admin = BigInt(PermissionFlagsBits.Administrator), messages = BigInt(PermissionFlagsBits.ManageMessages);
    assert.equal(escalationAdded(0n, admin | messages), admin);
    assert.equal(escalationAdded(admin, admin), 0n);
    assert.equal(escalationAdded('0', String(messages)), 0n, 'moderator-level permissions are not escalation');
    assert.equal(escalationAdded('not a number', String(admin)), admin, 'malformed values count as no permissions');
    assert.equal(escalationAdded('0', 'not a number'), 0n);
});

test('rule overrides do not mutate defaults', () => {
    const r = RULES[0]!;
    const copy = overrideRule(r, { mass_ban: { count: 1, seconds: 5 } });
    assert.notEqual(copy, r);
    assert.equal(copy.count, r.count);
    assert.equal(r.count, 5);
});

test('verification provider disagreement blocks a link', () => {
    assert.deepEqual(decideLinks([{ kind: 'found', id: '1' }, { kind: 'found', id: '2' }]), { kind: 'conflict' });
});

test('provider absence must be unanimous before revocation', () => {
    assert.deepEqual(decideLinks([{ kind: 'absent' }, { kind: 'error' }]), { kind: 'unavailable' });
    assert.deepEqual(decideLinks([{ kind: 'absent' }, { kind: 'absent' }]), { kind: 'absent' });
    assert.deepEqual(decideLinks([]), { kind: 'unavailable' });
});

test('a successful configured provider can verify despite the other failing', () => {
    assert.deepEqual(decideLinks([{ kind: 'found', id: '42' }, { kind: 'error' }]), { kind: 'found', id: '42' });
});

test('minimum account age calculates whole days and rejects invalid dates', () => {
    const created = '2026-01-01T00:00:00Z';
    assert.equal(ageDays(created, Date.parse('2026-01-07T23:59:00Z')), 6);
    assert.throws(() => ageDays('invalid'));
});

test('dangerous roles include admin, moderation and channel/role management', () => {
    assert.equal(dangerous(PermissionFlagsBits.Administrator), true);
    assert.equal(dangerous(PermissionFlagsBits.ManageRoles), true);
    assert.equal(dangerous(PermissionFlagsBits.ModerateMembers), true);
    assert.equal(dangerous(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages), false);
});

test('developer IDs accept comma-separated snowflakes and discard invalid inputs', () => {
    assert.deepEqual([...parseIds('1277709272041394187, junk, 123456789012345678')], ['1277709272041394187', '123456789012345678']);
    assert.equal(parseIds('123').size, 0);
});

test('cooldowns expire at the correct time', () => {
    const c = new Cooldowns();
    assert.equal(c.take('u', 100, 0), true);
    assert.equal(c.take('u', 100, 99), false);
    assert.equal(c.take('u', 100, 100), true);
});

test('guild queues serialize conflicting work and recover after failure', async () => {
    const q = new KeyedQueue(), order: string[] = [];
    await Promise.allSettled([q.run('guild', async () => {
            order.push('a');
            throw new Error('failure');
        }), q.run('guild', async () => {
            order.push('b');
        })]);
    assert.deepEqual(order, ['a', 'b']);
    assert.equal(await q.run('guild', async () => 42), 42);
});

test('recovery remaps role overwrites but preserves member IDs and filters missing roles', () => {
    const result = remapOverwrites([{ id: 'old', type: 0, allow: '1024', deny: '0' }, { id: 'user', type: 1, allow: '0', deny: '2048' }, { id: 'missing', type: 0, allow: '0', deny: '0' }], { old: 'new' }, new Set(['new']));
    assert.deepEqual(result, [{ id: 'new', type: 0, allow: 1024n, deny: 0n }, { id: 'user', type: 1, allow: 0n, deny: 2048n }]);
});

test('membership lookup distinguishes an absent member from transient API failures', async () => {
    const absent: any = { members: { fetch: async () => {
                throw { code: 10007 };
            } } };
    assert.equal(await memberOrNull(absent, 'u'), null);
    const failed: any = { members: { fetch: async () => {
                throw { status: 500 };
            } } };
    await assert.rejects(memberOrNull(failed, 'u'), /No action was taken/);
});

test('clearing one guild cooldown keeps other guilds and overlapping IDs blocked', () => {
    const c = new Cooldowns();
    for (const key of ['123:u:ban', '123:u:kick', '1234:u:ban', '456:u:ban']) {
        assert.equal(c.take(key, 100, 0), true);
    }
    c.clearPrefix('123:');
    assert.equal(c.take('123:u:ban', 100, 1), true);
    assert.equal(c.take('123:u:kick', 100, 1), true);
    assert.equal(c.take('1234:u:ban', 100, 1), false);
    assert.equal(c.take('456:u:ban', 100, 1), false);
});
