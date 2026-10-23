import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, Collection } from 'discord.js';
import { Store } from '../src/database/db.js';
import { Security } from '../src/security/security.js';
import { authorize } from './helpers.js';
import { globalAlertCard, globalAlertTarget, setGlobalAlertTarget, snapshotMember } from '../src/security/global-alert.js';
import { RULES } from '../src/core.js';

const timeout = RULES.find(r => r.key === 'timeout')!;

function setup() {
    const store = new Store(':memory:'); authorize(store);
    const s = store.settings('g'); s.enabled = true; s.mode = 'enforce'; s.logChannelId = 'log'; store.save(s);
    const pushes: { guild: string; embed: any; rows: any[]; channel?: string | null }[] = [];
    const security = new Security(store, { push: (guild: string, embed: any, rows: any[] = [], channel?: string | null) => pushes.push({ guild, embed, rows, channel }) } as any);
    const roles = new Collection<string, any>([['g', { id: 'g', name: '@everyone', position: 0 }], ['r1', { id: 'r1', name: 'Staff', position: 3 }], ['r2', { id: 'r2', name: 'Executive Co-Owner', position: 9 }]]);
    const actor = { id: 'actor', guild: { id: 'g' }, user: { username: 'ham6600y', bot: false, displayAvatarURL: () => 'https://cdn/avatar.png' }, roles: { cache: roles }, displayAvatarURL: () => 'https://cdn/avatar.png' };
    const guild: any = { id: 'g', name: 'The Midtown Genre', ownerId: 'owner', client: { user: { id: 'bot' } },
        members: { me: { permissions: { has: () => true }, roles: { highest: { id: 'botrole', position: 10 } } }, cache: new Collection(), fetch: async ({ user }: any) => { if (user === 'actor') return actor; throw { code: 10007 }; } },
        roles: { cache: new Collection() }, channels: { cache: new Collection() } };
    return { store, security, guild, pushes };
}

test('the global card shows the server, the person, the limit, the punishment and the roles they held', () => {
    const snap = snapshotMember({ guild: { id: 'g' }, user: { username: 'ham6600y', bot: false }, displayAvatarURL: () => 'x',
        roles: { cache: new Collection<string, any>([['g', { id: 'g', name: '@everyone', position: 0 }], ['a', { id: 'a', name: 'Low', position: 1 }], ['b', { id: 'b', name: 'simisear', position: 7 }]]) } } as any);
    assert.deepEqual(snap.roles, ['simisear', 'Low'], 'highest first, no @everyone');
    const { embed, row } = globalAlertCard({ guild: { id: '845541092136058920', name: 'The Midtown Genre' }, actor: '1445847653891178626', snapshot: snap,
        rule: timeout, mode: 'enforce', incident: 12, failed: false, reverted: null, jumpUrl: 'https://discord.com/channels/845541092136058920' });
    const e = embed.toJSON(), f = Object.fromEntries(e.fields!.map(x => [x.name, x.value]));
    assert.equal(e.title, 'Anti-nuke Triggered');
    assert.match(f.Guild!, /The Midtown Genre[\s\S]*845541092136058920/);
    assert.match(f.User!, /ham6600y[\s\S]*1445847653891178626/);
    assert.equal(f.Bot, 'No');
    assert.equal(f['Triggered Action'], timeout.title);
    assert.equal(f.Threshold, `${timeout.count} in ${timeout.seconds}s`);
    assert.equal(f.Punishment, 'Strip');
    assert.equal(f['Highest Role'], 'simisear');
    assert.equal(f['Roles Held'], 'simisear, Low');
    assert.match(e.footer!.text, /Global anti-nuke alert · Incident #12/);
    const button: any = row.toJSON().components[0];
    assert.equal(button.label, 'Jump to Server'); assert.equal(button.url, 'https://discord.com/channels/845541092136058920');
});

test('a real trigger is posted to the global channel with the roles held before the strip; warnings only when switched on', async () => {
    const { store, security, guild, pushes } = setup();
    try {
        // Off by default: only the server's own log.
        assert.equal(globalAlertTarget(store), null);
        const fire = async (prefix: string) => { for (let n = 0; n < timeout.count; n++) await security.audit({ id: `${prefix}${n}`, executorId: 'actor', targetId: `t${n}`, createdTimestamp: Date.now(), action: AuditLogEvent.MemberUpdate, changes: [{ key: 'communication_disabled_until', new: new Date(Date.now() + 3600000).toISOString() }] } as any, guild); };
        security.punish = async () => 'Removed 2 dangerous role(s).';
        (security as any).revert = async () => 'Removed timeout.';
        await fire('a');
        assert.equal(pushes.filter(p => p.channel === 'feed').length, 0, 'nothing global while it is off');
        assert.match(JSON.stringify(pushes.at(-1)!.embed), /Anti-nuke Warning/, 'timeouts warn first');

        setGlobalAlertTarget(store, { guildId: 'g', channelId: 'feed', warnings: false, by: 'dev', at: Date.now() });
        store.run('DELETE FROM incidents'); store.run('DELETE FROM observations');
        await fire('b'); // a warning again: not posted globally (warnings are off)
        assert.equal(pushes.filter(p => p.channel === 'feed').length, 0, 'warnings are left out by default');
        await fire('c'); // second offence within the hour: stripped
        const global = pushes.filter(p => p.channel === 'feed');
        assert.equal(global.length, 1);
        const f = Object.fromEntries(global[0]!.embed.toJSON().fields.map((x: any) => [x.name, x.value]));
        assert.equal(f.Punishment, 'Strip');
        assert.equal(f['Roles Held'], 'Executive Co-Owner, Staff', 'roles captured before the strip');
        assert.match(f.Guild, /The Midtown Genre/);
        assert.equal(global[0]!.rows[0].toJSON().components[0].url, 'https://discord.com/channels/g/log', 'jumps to the server\'s security log');

        setGlobalAlertTarget(store, { guildId: 'g', channelId: 'feed', warnings: true, by: 'dev', at: Date.now() });
        store.run('DELETE FROM incidents'); store.run('DELETE FROM observations');
        await fire('d');
        assert.match(JSON.stringify(pushes.filter(p => p.channel === 'feed').at(-1)!.embed), /Anti-nuke Warning/, 'warnings posted when switched on');
    } finally { store.close(); }
});

test('every strip is DMed to the bot Developers and TRUSTED_DM_IDS with the same card, rate-limited so a raid cannot flood DMs', async () => {
    const { dmGlobalAlert, dmSetting, setDmSetting, resetDmLimits, DM_WINDOW_MAX } = await import('../src/security/global-alert.js');
    const { config } = await import('../src/config.js');
    const store = new Store(':memory:');
    const sent: { to: string; payload: any }[] = [];
    const client: any = { users: { fetch: async (id: string) => ({ send: async (payload: any) => { sent.push({ to: id, payload }); } }) } };
    const before = new Set(config.trustedDmIds), devsBefore = new Set(config.developers);
    // The owner (BOT_OWNER_ID) is a Developer; also one extra Developer and one trusted person who is both.
    config.trustedDmIds.clear(); config.trustedDmIds.add('111111111111111111'); config.trustedDmIds.add(config.ownerId);
    config.developers.clear(); config.developers.add('222222222222222222');
    const people = [config.ownerId, '222222222222222222', '111111111111111111'].sort();
    resetDmLimits();
    const info = (actor: string, mode = 'enforce') => ({ guild: { id: 'g', name: 'Central Bank of West Midtown' }, actor, snapshot: { username: 'cam', avatarUrl: null, bot: false, roles: ['Staff'] },
        rule: timeout, mode, incident: 23, failed: false, reverted: { completed: 1, failed: 0, skipped: 0 }, jumpUrl: 'https://discord.com/channels/g/log' });
    try {
        assert.deepEqual(dmSetting(store), { on: true, warnings: false }, 'on by default, strips only');
        assert.equal(await dmGlobalAlert(client, store, info('a'), 1000), 3, 'owner, Developers and trusted people, each once');
        assert.deepEqual(sent.map(s => s.to).sort(), people);
        const card = sent[0]!.payload.embeds[0].toJSON();
        assert.equal(card.title, 'Anti-nuke Triggered');
        assert.match(JSON.stringify(card.fields), /Central Bank of West Midtown/);
        assert.equal(sent[0]!.payload.components[0].toJSON().components[0].label, 'Jump to Server');
        assert.equal(await dmGlobalAlert(client, store, info('a'), 2000), 0, 'same person and server: once per 5 minutes');
        assert.equal(await dmGlobalAlert(client, store, info('w', 'warn'), 3000), 0, 'warnings are not DMed by default');
        for (let n = 0; n < DM_WINDOW_MAX + 5; n++) await dmGlobalAlert(client, store, info(`x${n}`), 4000 + n);
        assert.equal(sent.length, DM_WINDOW_MAX * 3, 'at most 15 alerts per 10 minutes (each to all 3 people)');
        resetDmLimits(); setDmSetting(store, { on: false, warnings: false });
        assert.equal(await dmGlobalAlert(client, store, info('b'), 1000), 0, '/dev alerts dm:false turns them off');
    } finally { config.trustedDmIds.clear(); for (const id of before) config.trustedDmIds.add(id); config.developers.clear(); for (const id of devsBefore) config.developers.add(id); resetDmLimits(); store.close(); }
});

test('exempt people get a blue "not punished" card in the log, the global feed and the DM', async () => {
    const { incidentCard } = await import('../src/ui/incident-card.js');
    const card = incidentCard({ incident: 4, actor: 'owner', rule: timeout, mode: 'exempt', exemptReason: 'the server owner', count: 10, result: 'Not punished: the server owner. Nothing was undone.', progress: { completed: 0, failed: 0, skipped: 0 }, deleted: { channels: 0, roles: 0 }, targetId: null }).toJSON();
    assert.equal(card.title, 'Anti-nuke Alert (not punished)');
    assert.match(card.description!, /not punished\*\* because they are the server owner/);
    assert.equal(card.fields!.find(f => f.name === 'Punishment')!.value, 'None (the server owner)');
    const g = globalAlertCard({ guild: { id: 'g', name: 'G' }, actor: 'owner', snapshot: { username: 'o', avatarUrl: null, bot: false, roles: [] }, rule: timeout, mode: 'exempt', exemptReason: 'a Developer', incident: 4, failed: false, jumpUrl: 'https://discord.com/channels/g' }).embed.toJSON();
    assert.equal(g.title, 'Anti-nuke Alert (not punished)');
    assert.equal(g.fields!.find(f => f.name === 'Punishment')!.value, 'None (a Developer)');
});
