import { authorize } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent } from 'discord.js';
import { Store } from '../src/database/db.js';
import { configureEventLog, describeAudit, eventLogConfig, logsCategory, recentEvents, recordEvent } from '../src/audit/event-log.js';
import { restartNotice, summarizeMissed, formatDuration } from '../src/audit/downtime.js';

const guild: any = { id: 'g', client: { user: { id: 'bot' } } };
const entry = (action: number, extra: Record<string, unknown> = {}, actor = 'mod') => ({ id: String(Math.random()), action, executorId: actor, targetId: 'target', createdTimestamp: Date.now(), changes: [], ...extra }) as any;

function setup() {
    const store = new Store(':memory:');
    authorize(store);
    const s = store.settings('g');
    s.authorized = true;
    s.logChannelId = 'security-log';
    store.save(s);
    const pushed: {
        title: string;
        channel?: string | null;
    }[] = [];
    const logs: any = { push: (_g: string, e: any, _rows: unknown, channel?: string | null) => pushed.push({ title: e.data?.title ?? e.toJSON?.().title, channel }) };
    return { store, logs, pushed };
}

test('audit entries become readable log events with the right category and actor', () => {
    const deleted = describeAudit(entry(AuditLogEvent.ChannelDelete, { changes: [{ key: 'name', old: 'general' }] }), guild)!;
    assert.equal(deleted.category, 'channels');
    assert.equal(deleted.action, 'Channel deleted');
    assert.equal(deleted.target, '#general', 'a deleted channel is shown by name, not as a dead link');
    const until = new Date(Date.now() + 3600000).toISOString();
    const timeout = describeAudit(entry(AuditLogEvent.MemberUpdate, { changes: [{ key: 'communication_disabled_until', new: until }], reason: 'spam' }), guild)!;
    assert.equal(timeout.category, 'moderation');
    assert.equal(timeout.action, 'Timeout Added');
    assert.ok(timeout.details!.includes('**Duration:** 1 hour'), 'the timeout length is shown');
    assert.ok(timeout.details!.some(d => d.startsWith('**Until:**')) && timeout.details!.some(d => d === '**Reason:** spam'));
    const roles = describeAudit(entry(AuditLogEvent.MemberRoleUpdate, { changes: [{ key: '$add', new: [{ id: 'r1' }] }] }), guild)!;
    assert.deepEqual(roles.details, ['**Roles added:** <@&r1>']);
    const prune = describeAudit(entry(AuditLogEvent.MemberPrune, { extra: { removed: 12, days: 30 } }), guild)!;
    assert.match(prune.details![0]!, /12 member\(s\) inactive for 30 day/);
});

test("the bot's own actions are skipped (its commands and the ban log report them), others are credited", () => {
    assert.equal(describeAudit(entry(AuditLogEvent.ChannelCreate, {}, 'bot'), guild), null);
    assert.equal(describeAudit(entry(AuditLogEvent.MemberBanAdd, { reason: '223456789012345678: raiding' }, 'bot'), guild), null, '/mod ban is already logged as a case and in #bans');
    const ban = describeAudit(entry(AuditLogEvent.MemberBanAdd, { reason: 'raiding' }, '323456789012345678'), guild)!;
    assert.equal(ban.action, 'Member Banned');
    assert.equal(ban.actorId, '323456789012345678');
    assert.ok(ban.details!.includes('**Reason:** raiding'));
    assert.equal(describeAudit(entry(999999), guild), null, 'unknown audit actions are ignored');
});

test('nothing is stored or posted until logging is enabled, and disabled categories are skipped', () => {
    const { store, logs, pushed } = setup();
    const event = { category: 'channels' as const, action: 'Channel created', actorId: 'mod' };
    assert.equal(recordEvent(store, logs, 'g', event), false);
    configureEventLog(store, 'g', { enabled: true });
    assert.equal(recordEvent(store, logs, 'g', event), true);
    configureEventLog(store, 'g', { category: ['channels', false] });
    assert.equal(recordEvent(store, logs, 'g', event), false);
    assert.equal(logsCategory(store, 'g', 'channels'), false);
    assert.equal(logsCategory(store, 'g', 'moderation'), true);
    assert.equal(recentEvents(store, 'g').total, 1);
    assert.deepEqual(pushed.map(p => p.channel), [null], 'without its own channel, events go to the security log channel');
    store.close();
});

test('a dedicated event log channel is used, and settings persist', () => {
    const { store, logs, pushed } = setup();
    configureEventLog(store, 'g', { enabled: true, channelId: 'events' });
    recordEvent(store, logs, 'g', { category: 'members', action: 'Member joined', targetId: 'u1', target: '<@u1>' });
    assert.equal(pushed[0]!.channel, 'events');
    const config = eventLogConfig(store, 'g');
    assert.deepEqual([config.enabled, config.channelId, config.categories.size], [true, 'events', 6]);
    store.close();
});

test('event history filters by category and user, pages, and expires after 30 days', () => {
    const { store, logs } = setup();
    configureEventLog(store, 'g', { enabled: true });
    for (let n = 0; n < 15; n++)
        recordEvent(store, logs, 'g', { category: 'members', action: 'Member joined', targetId: `u${n}` });
    recordEvent(store, logs, 'g', { category: 'moderation', action: 'Member banned', actorId: 'mod', targetId: 'u3' });
    recordEvent(store, logs, 'g', { category: 'roles', action: 'Role deleted', actorId: 'old', at: Date.now() - 31 * 86400000 });
    assert.equal(recentEvents(store, 'g').total, 17);
    assert.deepEqual([recentEvents(store, 'g', { page: 2 }).rows.length, recentEvents(store, 'g', { page: 2 }).pages], [7, 2]);
    assert.equal(recentEvents(store, 'g', { category: 'moderation' }).total, 1);
    assert.equal(recentEvents(store, 'g', { userId: 'u3' }).total, 2, 'matches events done by or to the user');
    assert.equal(recentEvents(store, 'g', { page: 99 }).page, 2, 'out-of-range pages clamp to the last page');
    store.cleanup();
    assert.equal(recentEvents(store, 'g').total, 16, 'events older than 30 days are removed');
    store.close();
});

test('the restart notice reports the restored anti-nuke settings', () => {
    const { store } = setup();
    const s = store.settings('g');
    s.enabled = true;
    s.mode = 'enforce';
    s.rules = { mass_ban: { count: 2, seconds: 10 } };
    store.save(s);
    store.grant('g', 'helper', 'trust', 'owner');
    const now = Date.now();
    const lines = restartNotice(store, store.settings('g'), now - 7 * 60000, now).join('\n');
    assert.match(lines, /Offline for about 7 minutes/);
    assert.match(lines, /\*\*Anti-nuke:\*\* on · enforce mode/);
    assert.match(lines, /17 \(1 with custom limits\)/);
    assert.match(lines, /\*\*Trusted users:\*\* 1/);
    assert.match(lines, /Event logging:\*\* off/);
    assert.equal(formatDuration(30000), 'less than a minute');
    store.close();
});

test('the downtime report counts actions per actor and flags anything at the rule limit', () => {
    const { store } = setup();
    const s = store.settings('g');
    const missed = [
        ...Array.from({ length: 3 }, () => entry(AuditLogEvent.ChannelDelete, {}, 'nuker')),
        entry(AuditLogEvent.ChannelDelete, {}, 'helper'),
        entry(AuditLogEvent.MemberBanAdd, {}, 'friend'),
        entry(AuditLogEvent.ChannelCreate, {}, 'nuker'),
    ];
    const summary = summarizeMissed(missed, guild, s, id => id === 'friend');
    assert.equal(summary.flagged, 1);
    assert.match(summary.lines[0]!, /<@nuker> · 3× .*at or above the anti-nuke limit/);
    assert.ok(!summary.lines.some(l => l.includes('friend')), 'trusted users are not reported');
    assert.ok(!summary.lines.some(l => l.includes('helper') && l.includes('⚠️')), 'one deletion is below the limit');
    store.close();
});
