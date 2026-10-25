import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/database/db.js';
import { authorize } from './helpers.js';
import {
    DECAY_AFTER_MS, THREAT_TTL_MS, board, boardSummary, clearThreat, decayedScore, decayThreats, levelFor,
    maintainThreats, pointsFor, recordThreat, recordThreatAction, threatActions, threatEvents, threatFor,
} from '../src/security/threat-board.js';

const G = '123456789012345678', ATTACKER = '111111111111111111', OWNER = '1277709272041394187', BOT = '999999999999999999';
const store = () => { const s = new Store(':memory:'); authorize(s, G); return s; };

test('incidents add up into levels: watch, high, critical', () => {
    const s = store();
    try {
        assert.equal(recordThreat(s, G, ATTACKER, 'channel_update', 'x', 1000)!.score, 5);
        assert.equal(recordThreat(s, G, ATTACKER, 'channel_update', 'x', 1001)!.score, 10);
        assert.equal(recordThreat(s, G, ATTACKER, 'channel_update', 'x', 1002)!.level, 'quiet');
        assert.equal(recordThreat(s, G, ATTACKER, 'webhook_change', 'x', 1003)!.score, 35);
        assert.equal(threatFor(s, G, ATTACKER)!.level, 'watch');
        assert.equal(recordThreat(s, G, ATTACKER, 'mass_kick', 'x', 1004)!.level, 'high');
        assert.equal(recordThreat(s, G, ATTACKER, 'mass_ban', 'x', 1005)!.score, 105);
        assert.equal(threatFor(s, G, ATTACKER)!.level, 'critical');
        assert.equal(levelFor(0), 'quiet');
        assert.equal(levelFor(25), 'watch');
        assert.equal(levelFor(54), 'watch');
        assert.equal(levelFor(55), 'high');
        assert.equal(levelFor(85), 'critical');
        assert.equal(pointsFor('mass_ban'), 40);
        assert.equal(pointsFor('something_new'), 5, 'an unknown rule still counts, just barely');
    } finally { s.close(); }
});

test('every scored incident is kept as evidence and only scored rules are recorded', () => {
    const s = store();
    try {
        recordThreat(s, G, ATTACKER, 'mass_ban', 'banned 6 people', 1000);
        recordThreat(s, G, ATTACKER, 'not_a_rule', 'ignored', 1001);
        const events = threatEvents(s, G, ATTACKER);
        assert.equal(events.length, 1);
        assert.deepEqual([events[0]!.rule, events[0]!.points, events[0]!.detail], ['mass_ban', 40, 'banned 6 people']);
        assert.equal(threatFor(s, G, ATTACKER)!.first_at, 1000, 'first sighting is kept when the score grows');
    } finally { s.close(); }
});

test('quiet attackers cool off: scores halve every day and fall off the board after a week', () => {
    const s = store();
    try {
        recordThreat(s, G, ATTACKER, 'mass_ban', 'x', 0);
        const row = threatFor(s, G, ATTACKER)!;
        assert.equal(decayedScore(row, DECAY_AFTER_MS * 0.9), 40, 'less than a day: unchanged');
        assert.equal(decayedScore(row, DECAY_AFTER_MS * 1.1), 20);
        assert.equal(decayedScore(row, DECAY_AFTER_MS * 2.1), 10);
        recordThreat(s, G, ATTACKER, 'channel_update', 'x', DECAY_AFTER_MS * 2);
        assert.equal(threatFor(s, G, ATTACKER)!.score, 15, 'new points add to the decayed score, not the old one');
        const decayed = decayThreats(s, G, DECAY_AFTER_MS * 3);
        assert.equal(decayed.changed, 1);
        assert.equal(threatFor(s, G, ATTACKER)!.score, 7);
        // A week counts from the last incident (2 days in), so the board clears after 9 quiet days.
        const expired = decayThreats(s, G, DECAY_AFTER_MS * 9.5);
        assert.equal(expired.expired, 1);
        assert.equal(threatFor(s, G, ATTACKER), undefined, 'a full quiet week clears the board');
        assert.equal(threatEvents(s, G, ATTACKER).length, 2, 'the evidence stays in the log');
    } finally { s.close(); }
});

test('periodic maintenance decays scores without any enforcement or log-card path', async () => {
    const s = store();
    try {
        recordThreat(s, G, ATTACKER, 'mass_ban', 'x', 0);
        const guild = { id: G };
        const result = await maintainThreats({
            store: s,
            client: { guilds: { cache: new Map([[G, guild]]) } } as any,
            ready: () => true,
            now: () => DECAY_AFTER_MS * 2,
        });
        assert.deepEqual(result, { guilds: 1, changed: 1, expired: 0 });
        assert.equal(threatFor(s, G, ATTACKER)!.score, 10, 'scoring and decay continue');
        assert.equal(threatActions(s, G).length, 0, 'maintenance records no contain or strike action');
    } finally { s.close(); }
});

test('clearing a threat takes it off the board but keeps the evidence', () => {
    const s = store();
    try {
        recordThreat(s, G, ATTACKER, 'mass_ban', 'x');
        recordThreatAction(s, G, ATTACKER, 'strike', 'banned', BOT);
        assert.equal(clearThreat(s, G, ATTACKER, OWNER), true);
        const row = threatFor(s, G, ATTACKER)!;
        assert.deepEqual([row.score, row.cleared_at !== null, row.cleared_by], [0, true, OWNER]);
        assert.equal(board(s, G).length, 0);
        assert.equal(threatEvents(s, G, ATTACKER).length, 1, 'what they did stays on the record');
        assert.equal(threatActions(s, G).length, 1);
        assert.equal(clearThreat(s, G, ATTACKER, OWNER), false, 'clearing twice is reported, not repeated');
        // A cleared person who offends again starts from that incident, not from their old score.
        assert.equal(recordThreat(s, G, ATTACKER, 'channel_update', 'x')!.score, 5);
        assert.equal(threatFor(s, G, ATTACKER)!.cleared_at, null);
    } finally { s.close(); }
});

test('one server’s board is never another server’s, and the summary counts the levels', () => {
    const s = store();
    try {
        const G2 = '223456789012345678';
        authorize(s, G2);
        recordThreat(s, G, ATTACKER, 'mass_ban', 'x');
        recordThreat(s, G2, ATTACKER, 'channel_update', 'x');
        assert.equal(board(s, G).length, 1);
        assert.equal(board(s, G2).length, 1);
        assert.equal(board(s, G)[0]!.score, 40);
        assert.equal(board(s, G2)[0]!.score, 5);
        recordThreat(s, G, '444444444444444444', 'dangerous_grant', 'x');
        recordThreat(s, G, '444444444444444444', 'mass_kick', 'x');
        const summary = boardSummary(s, G);
        assert.deepEqual([summary.total, summary.critical, summary.high], [2, 0, 1]);
        assert.equal(summary.top[0]!.user_id, '444444444444444444');
    } finally { s.close(); }
});

test('maintenance in a server that is not ready does nothing at all', async () => {
    const s = store();
    try {
        const now = Date.now();
        recordThreat(s, G, ATTACKER, 'mass_ban', 'x', now);
        const result = await maintainThreats({
            store: s,
            client: { guilds: { cache: new Map([[G, { id: G }]]) } } as any,
            ready: () => false,
            now: () => now + DECAY_AFTER_MS * 2,
        });
        assert.deepEqual(result, { guilds: 0, changed: 0, expired: 0 });
        assert.equal(threatFor(s, G, ATTACKER)!.score, 40, 'nothing was written while the server is not ready');
    } finally { s.close(); }
});

test('the board is scoped per guild like everything else', () => {
    const s = store();
    try {
        recordThreat(s, G, ATTACKER, 'mass_ban', 'x');
        assert.throws(() => s.readGuild(G, () => s.all('SELECT * FROM threat_scores WHERE guild_id=?', '223456789012345678')), /Cross-guild|not authorized/);
        assert.throws(() => s.readGuild(G, () => s.all('SELECT * FROM threat_events')), /Cross-guild or unscoped/);
    } finally { s.close(); }
});

test('the board expires a whole quiet week, not a busy one', () => {
    const s = store();
    try {
        recordThreat(s, G, ATTACKER, 'mass_ban', 'x', Date.now());
        const { expired } = decayThreats(s, G, Date.now() + THREAT_TTL_MS - 1000);
        assert.equal(expired, 0);
        assert.equal(decayThreats(s, G, Date.now() + THREAT_TTL_MS + 1000).expired, 1, 'seen only once but long ago: off the board');
    } finally { s.close(); }
});
