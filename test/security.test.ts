import { authorize } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, Collection, PermissionsBitField, PermissionFlagsBits, type Guild, type GuildAuditLogsEntry } from 'discord.js';
import { Store } from '../src/database/db.js';
import { Security } from '../src/security/security.js';
import type { LogQueue } from '../src/logging.js';

function setup(mode: 'observe' | 'enforce' = 'observe') {
    const store = new Store(':memory:');
    authorize(store);
    const settings = store.settings('g');
    settings.authorized = true;
    settings.enabled = true;
    settings.mode = mode;
    store.save(settings);
    const logs: unknown[] = [];
    const security = new Security(store, { push: (_g: unknown, e: unknown) => logs.push(e) } as unknown as LogQueue);
    const guild = { id: 'g', ownerId: 'owner', client: { user: { id: 'bot' } } } as unknown as Guild;
    const entry = (id: string, actor = 'attacker', action = AuditLogEvent.MemberBanAdd, at = Date.now()) => ({ id, executorId: actor, action, createdTimestamp: at, targetId: 'target' } as GuildAuditLogsEntry);
    return { store, security, guild, entry, logs };
}

test('observe mode records incident at threshold without calling containment', async () => {
    const { store, security, guild, entry, logs } = setup();
    let calls = 0;
    security.punish = async () => {
        calls++;
        return 'contained';
    };
    await Promise.all(['1', '2', '3', '4', '5', '6'].map(id => security.audit(entry(id), guild)));
    assert.equal(store.all('SELECT * FROM incidents').length, 1);
    assert.equal(calls, 0);
    assert.equal(logs.length, 1);
    store.close();
});

test('enforce mode writes evidence before containment and stores the result', async () => {
    const { store, security, guild, entry } = setup('enforce');
    let calls = 0;
    security.punish = async () => {
        calls++;
        assert.equal(store.all('SELECT * FROM incidents').length, 1);
        return 'contained';
    };
    for (const id of ['1', '2', '3', '4', '5'])
        await security.audit(entry(id), guild);
    assert.equal(calls, 1);
    assert.match(store.get('SELECT result FROM incidents')?.result, /^contained/);
    store.close();
});

test('owner, bot and explicitly trusted users are excluded from audit counting', async () => {
    const { store, security, guild, entry } = setup();
    store.grant('g', 'trusted', 'trust', 'owner');
    for (const [n, id] of ['owner', 'bot', 'trusted'].entries())
        await security.audit(entry(String(n), id), guild);
    assert.equal(store.all('SELECT * FROM observations').length, 0);
    store.close();
});

test('security administrator grant alone does not bypass detection', async () => {
    const { store, security, guild, entry } = setup();
    store.grant('g', 'attacker', 'admin', 'owner');
    for (const id of ['1', '2', '3', '4', '5'])
        await security.audit(entry(id), guild);
    assert.equal(store.all('SELECT * FROM incidents').length, 1);
    store.close();
});

test('verification bot exemption covers only member role updates', async () => {
    const { store, security, guild, entry } = setup();
    store.grant('g', 'verifybot', 'bot', 'owner');
    await security.audit(entry('1', 'verifybot', AuditLogEvent.MemberRoleUpdate), guild);
    await security.audit(entry('2', 'verifybot', AuditLogEvent.RoleDelete), guild);
    assert.equal(store.all('SELECT * FROM observations').length, 1);
    store.close();
});

test('replayed and duplicate audit events cannot cause enforcement', async () => {
    const { store, security, guild, entry } = setup('enforce');
    let calls = 0;
    security.punish = async () => {
        calls++;
        return 'contained';
    };
    for (const id of ['1', '2', '3', '4', '5'])
        await security.audit(entry(id, 'attacker', AuditLogEvent.MemberBanAdd, Date.now() - 180000), guild);
    await security.audit(entry('1'), guild);
    assert.equal(calls, 0);
    assert.equal(store.all('SELECT * FROM incidents').length, 0);
    store.close();
});

test('disabled and unauthorized servers do not enforce', async () => {
    const { store, security, guild, entry } = setup('enforce');
    const s = store.settings('g');
    store.run("UPDATE guild_authorization SET state='DEAUTHORIZED' WHERE guild_id='g'");
    store.save(s);
    await security.audit(entry('1'), guild);
    assert.equal(store.all('SELECT * FROM observations').length, 0);
    authorize(store);
    s.enabled = false;
    store.save(s);
    for (const id of ['2', '3', '4'])
        await security.audit(entry(id), guild);
    assert.equal(store.all('SELECT * FROM incidents').length, 0);
    store.close();
});

test('containment backs up roles first, preserves ordinary roles and reports remaining danger', async () => {
    const { store, security } = setup('enforce');
    let backedUp = false;
    const ordinary = { id: 'ordinary', managed: false, permissions: new PermissionsBitField(0n) };
    const privileged = { id: 'admin', managed: false, permissions: new PermissionsBitField(PermissionFlagsBits.Administrator) };
    const member: any = { id: 'attacker', manageable: true, roles: { cache: new Collection([['ordinary', ordinary], ['admin', privileged]]), remove: async (ids: string[]) => {
                backedUp = !!store.get('SELECT * FROM backups');
                for (const id of ids)
                    member.roles.cache.delete(id);
            } }, permissions: new PermissionsBitField(PermissionFlagsBits.Administrator) };
    const guild: any = { id: 'g', ownerId: 'owner', client: { user: { id: 'bot' } }, members: { fetch: async () => member, fetchMe: async () => ({ roles: { highest: { comparePositionTo: () => 1 } } }) }, roles: { fetch: async () => { }, cache: new Collection() } };
    const result = await security.contain(guild, 'attacker');
    assert.equal(backedUp, true);
    assert.equal(member.roles.cache.has('ordinary'), true);
    assert.equal(member.roles.cache.has('admin'), false);
    assert.match(result, /incomplete/);
    assert.deepEqual(JSON.parse(store.get('SELECT roles FROM backups')!.roles), ['ordinary', 'admin']);
    store.close();
});

const perms = (...bits: bigint[]) => new PermissionsBitField(bits.reduce((all, bit) => all | BigInt(bit), 0n));
const auditEntry = (id: string, action: number, extra: Record<string, unknown> = {}, actor = 'attacker') => ({ id, executorId: actor, action, createdTimestamp: Date.now(), targetId: 'target', ...extra }) as unknown as GuildAuditLogsEntry;
const incidentsFor = (store: Store, rule: string) => store.all('SELECT * FROM incidents WHERE guild_id=? AND rule=?', 'g', rule);

test('a single dangerous permission grant to a role is an incident, and enforce mode undoes it', async () => {
    const { store, security, guild, logs } = setup('enforce');
    security.contain = async () => 'contained.';
    let setTo: bigint | undefined;
    const send = BigInt(PermissionFlagsBits.SendMessages), admin = BigInt(PermissionFlagsBits.Administrator);
    const role = { id: 'r1', name: 'Helpers', managed: false, editable: true, permissions: perms(admin, send), setPermissions: async (bits: bigint) => {
            setTo = bits;
        } };
    (guild as any).roles = { cache: new Map([['r1', role]]), fetch: async () => role };
    await security.audit(auditEntry('e1', AuditLogEvent.RoleUpdate, { targetId: 'r1', changes: [{ key: 'permissions', old: String(send), new: String(admin | send) }] }), guild);
    const [incident] = incidentsFor(store, 'dangerous_grant');
    assert.ok(incident, 'one grant is enough');
    assert.match(incident.result, /^contained\. \[completed\] Removed the newly granted permissions from role Helpers\. Reverts: 1 completed, 0 failed, 0 skipped\.$/);
    assert.equal(setTo, send, 'only the newly granted permission is removed');
    assert.equal(logs.length, 1);
    store.close();
});

test('routine permission changes are not dangerous grants', async () => {
    const { store, security, guild } = setup('enforce');
    const send = BigInt(PermissionFlagsBits.SendMessages), messages = BigInt(PermissionFlagsBits.ManageMessages);
    await security.audit(auditEntry('e1', AuditLogEvent.RoleUpdate, { changes: [{ key: 'permissions', old: String(send), new: String(send | messages) }] }), guild);
    assert.equal(incidentsFor(store, 'dangerous_grant').length, 0);
    store.close();
});

test('giving a member a role with escalation permissions is an incident, and enforce mode removes it from them', async () => {
    const { store, security, guild } = setup('enforce');
    security.contain = async () => 'contained.';
    const removed: string[][] = [];
    const adminRole = { id: 'admin', managed: false, editable: true, permissions: perms(BigInt(PermissionFlagsBits.Administrator)) };
    (guild as any).roles = { cache: new Map([['admin', adminRole]]) };
    (guild as any).members = { fetch: async () => ({ id: 'alt', roles: { cache: new Collection(), remove: async (ids: string[]) => {
                    removed.push(ids);
                } } }) };
    await security.audit(auditEntry('e1', AuditLogEvent.MemberRoleUpdate, { targetId: 'alt', changes: [{ key: '$add', new: [{ id: 'admin', name: 'Admin' }] }] }), guild);
    assert.match(incidentsFor(store, 'dangerous_grant')[0]?.result ?? '', /Removed 1 newly granted role\(s\) from <@alt>/);
    assert.deepEqual(removed, [['admin']]);
    store.close();
});

test('the verification bot exemption does not cover dangerous grants', async () => {
    const { store, security, guild } = setup();
    store.grant('g', 'verifybot', 'bot', 'owner');
    (guild as any).roles = { cache: new Map([['admin', { id: 'admin', managed: false, permissions: perms(BigInt(PermissionFlagsBits.Administrator)) }]]) };
    await security.audit(auditEntry('e1', AuditLogEvent.MemberRoleUpdate, { changes: [{ key: '$add', new: [{ id: 'admin' }] }] }, 'verifybot'), guild);
    assert.deepEqual(store.all('SELECT rule FROM observations').map(r => r.rule), ['dangerous_grant']);
    assert.equal(incidentsFor(store, 'dangerous_grant').length, 1);
    store.close();
});

test('a single member prune and AutoMod tampering are incidents, but ordinary AutoMod edits are not', async () => {
    const { store, security, guild } = setup();
    await security.audit(auditEntry('p1', AuditLogEvent.MemberPrune), guild);
    await security.audit(auditEntry('a1', AuditLogEvent.AutoModerationRuleUpdate, { changes: [{ key: 'name', old: 'Spam', new: 'Spam filter' }] }, 'editor'), guild);
    await security.audit(auditEntry('a2', AuditLogEvent.AutoModerationRuleUpdate, { changes: [{ key: 'enabled', old: true, new: false }] }, 'disabler'), guild);
    await security.audit(auditEntry('a3', AuditLogEvent.AutoModerationRuleDelete, {}, 'deleter'), guild);
    assert.equal(incidentsFor(store, 'member_prune').length, 1);
    assert.deepEqual(incidentsFor(store, 'automod_tamper').map(r => r.actor_id).sort(), ['deleter', 'disabler']);
    store.close();
});

test('the shared All threshold does not loosen single-event rules', async () => {
    const { store, security, guild } = setup();
    const settings = store.settings('g');
    settings.ruleDefaults = { count: 3, seconds: 20 };
    store.save(settings);
    await security.audit(auditEntry('p1', AuditLogEvent.MemberPrune), guild);
    assert.equal(incidentsFor(store, 'member_prune').length, 1);
    store.close();
});

test('bot containment kicks an offending bot only when enabled and only during automatic incidents', async () => {
    const { store, security, guild } = setup('enforce');
    let kicked = 0;
    const bot = { id: 'evilbot', user: { bot: true }, kickable: true, manageable: false, kick: async () => {
            kicked++;
        } };
    (guild as any).members = { fetch: async () => bot, fetchMe: async () => ({}) };
    assert.match(await security.contain(guild, 'evilbot', true), /cannot be managed/, 'option off: normal containment');
    store.setKickBots('g', true);
    assert.match(await security.contain(guild, 'evilbot'), /cannot be managed/, 'manual containment never kicks');
    assert.equal(kicked, 0);
    assert.match(await security.contain(guild, 'evilbot', true), /Removed the bot/);
    assert.equal(kicked, 1);
    store.close();
});

test('incident alerts offer Review restore only when the actor deleted channels or roles', async () => {
    const { store, guild } = setup();
    const pushed: {
        rows: any[];
    }[] = [];
    const security = new Security(store, { push: (_g: unknown, _e: unknown, rows: any[] = []) => pushed.push({ rows }) } as unknown as LogQueue);
    await security.audit(auditEntry('d1', AuditLogEvent.ChannelDelete, {}, 'nuker'), guild);
    await security.audit(auditEntry('d2', AuditLogEvent.ChannelDelete, {}, 'nuker'), guild);
    await security.audit(auditEntry('d3', AuditLogEvent.ChannelDelete, {}, 'nuker'), guild);
    await security.audit(auditEntry('p1', AuditLogEvent.MemberPrune, {}, 'pruner'), guild);
    assert.equal(pushed.length, 2);
    assert.match(JSON.stringify(pushed[0]!.rows.map(r => r.toJSON())), /incident:restore:1/);
    assert.equal(pushed[1]!.rows.length, 0, 'no deletions, no button');
    store.close();
});

test('bans and kicks done through /moderation count against the moderator, not the exempt bot', async () => {
    const { store, security, guild } = setup();
    const viaBot = (id: string, reason: string | null, action: number = AuditLogEvent.MemberBanAdd) => auditEntry(id, action, { reason }, 'bot');
    for (const n of ['1', '2', '3', '4', '5'])
        await security.audit(viaBot(n, '223456789012345678: spam'), guild);
    assert.deepEqual(store.all('SELECT actor_id, rule FROM incidents').map(r => `${r.actor_id}:${r.rule}`), ['223456789012345678:mass_ban']);
    await security.audit(viaBot('k1', '223456789012345678: raid', AuditLogEvent.MemberKick), guild);
    assert.equal(store.all("SELECT * FROM observations WHERE rule='mass_kick' AND actor_id='223456789012345678'").length, 1);
    // The bot's own restores and containment, and reasons without a moderator ID, stay exempt.
    await security.audit(viaBot('r1', 'Midtown Vanguard restore #1; actor 223456789012345678'), guild);
    await security.audit(viaBot('r2', null), guild);
    await security.audit(viaBot('r3', 'owner: not an id'), guild);
    assert.equal(store.all("SELECT * FROM observations WHERE actor_id<>'223456789012345678'").length, 0);
    store.close();
});

test('trusted moderators acting through the bot stay exempt', async () => {
    const { store, security, guild } = setup();
    store.grant('g', '323456789012345678', 'trust', 'owner');
    for (const n of ['1', '2', '3', '4', '5'])
        await security.audit(auditEntry(n, AuditLogEvent.MemberBanAdd, { reason: '323456789012345678: cleanup' }, 'bot'), guild);
    assert.equal(store.all('SELECT * FROM observations').length, 0);
    store.close();
});

function quarantined(givenBy: string | null) {
    const { store, security, logs } = setup('enforce');
    store.run("INSERT INTO backups(guild_id,user_id,roles,at,active) VALUES('g','target','[]',0,1)");
    const staffRole = { id: 'branch', managed: false, permissions: new PermissionsBitField(PermissionFlagsBits.ManageRoles) };
    const removed: string[] = [];
    const member: any = { id: 'target', manageable: true, permissions: new PermissionsBitField(0n),
        roles: { cache: new Collection([['branch', staffRole]]), remove: async (ids: string[]) => { for (const id of [ids].flat()) { removed.push(id); member.roles.cache.delete(id); } }, add: async () => { } } };
    const entries = givenBy ? [['e', { id: 'e', action: AuditLogEvent.MemberRoleUpdate, targetId: 'target', executorId: givenBy, createdTimestamp: Date.now(), changes: [{ key: '$add', new: [{ id: 'branch' }] }] }]] : [];
    const guild: any = { id: 'g', ownerId: 'owner', client: { user: { id: 'bot' } }, fetchAuditLogs: async () => ({ entries: new Collection(entries as any) }),
        members: { fetch: async () => member, fetchMe: async () => ({ roles: { highest: { comparePositionTo: () => 1 } } }) }, roles: { fetch: async () => { }, cache: new Collection() } };
    member.guild = guild;
    return { store, security, member, removed, logs };
}

test('a trusted person giving a quarantined member a staff role lifts the quarantine instead of undoing it', async () => {
    const { store, security, member, removed, logs } = quarantined('owner');
    await security.reconcile(member);
    assert.deepEqual(removed, []);
    assert.equal(store.get("SELECT active FROM backups WHERE user_id='target'")?.active, 0);
    assert.match(JSON.stringify(logs), /Quarantine lifted/);
    store.close();
});

test('an untrusted grant (or no audit entry) to a quarantined member is still removed and explained', async () => {
    for (const by of ['randomadmin', null]) {
        const { store, security, member, removed, logs } = quarantined(by);
        await security.reconcile(member);
        assert.deepEqual(removed, ['branch']);
        assert.equal(store.get("SELECT active FROM backups WHERE user_id='target'")?.active, 1);
        assert.match(JSON.stringify(logs), /Quarantine still active/);
        store.close();
    }
});
