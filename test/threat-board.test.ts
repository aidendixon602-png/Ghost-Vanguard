import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/database/db.js';
import { authorize } from './helpers.js';
import {
    ACTION_COOLDOWN_MS, DECAY_AFTER_MS, THREAT_TTL_MS, board, boardSummary, clearThreat, decayedScore, decayThreats, levelFor,
    planResponse, pointsFor, recordThreat, recordThreatAction, sweepThreats, threatActions, threatEvents, threatFor,
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

test('the balance: nothing automatic in observe mode, for trusted people, the owner or the bot', () => {
    const base = { score: 120, mode: 'enforce' as const, protectionOn: true, trusted: false, isBot: false, isOwner: false, lastActionAt: null };
    assert.equal(planResponse(base).action, 'strike');
    assert.match(planResponse({ ...base, mode: 'observe' }).why, /observe mode/);
    assert.equal(planResponse({ ...base, mode: 'observe' }).action, 'none');
    assert.match(planResponse({ ...base, protectionOn: false }).why, /Protection is off/);
    assert.match(planResponse({ ...base, trusted: true }).why, /whitelist/);
    assert.match(planResponse({ ...base, isOwner: true }).why, /server owner/);
    assert.match(planResponse({ ...base, isBot: true }).why, /never acts against itself/);
    assert.equal(planResponse({ ...base, score: 60 }).action, 'contain');
    assert.equal(planResponse({ ...base, score: 30 }).action, 'watch');
    assert.equal(planResponse({ ...base, score: 10 }).action, 'none');
    assert.match(planResponse({ ...base, score: 90, alreadyBanned: true }).why, /already banned/);
    assert.equal(planResponse({ ...base, score: 90, alreadyBanned: true }).action, 'contain', 'never bans twice');
    assert.match(planResponse({ ...base, lastActionAt: Date.now() - 1000 }).why, /last 10 minutes/);
    assert.equal(planResponse({ ...base, lastActionAt: Date.now() - ACTION_COOLDOWN_MS - 1 }).action, 'strike', 'the cooldown expires');
});

test('the sweep contains a high scorer, strikes a critical one and only logs a warning to others', async () => {
    const s = store();
    try {
        s.save(s.settings(G));
        s.run("UPDATE guild_config SET enabled=1, mode='enforce' WHERE guild_id=?", G);
        recordThreat(s, G, '211111111111111111', 'mass_kick', 'x');       // 30 → watch
        recordThreat(s, G, '222222222222222222', 'mass_ban', 'x');        // 40 → watch… pushed to contain below
        recordThreat(s, G, '222222222222222222', 'mass_kick', 'x');       // 70 → high → contain
        recordThreat(s, G, '333333333333333333', 'mass_ban', 'x');
        recordThreat(s, G, '333333333333333333', 'dangerous_grant', 'x'); // 75 → high
        recordThreat(s, G, '333333333333333333', 'bot_add', 'x');         // 110 → critical → strike
        const contained: string[] = [], banned: string[] = [], lines: any[] = [];
        const guild: any = { id: G, ownerId: OWNER, members: { fetch: async ({ user }: any) => ({ id: user, user: { bot: false } }) }, bans: { fetch: async () => { throw new Error('not banned'); } } };
        const logs: any = { push: (guildId: string, payload: any) => lines.push(payload) };
        const result = await sweepThreats({
            store: s, client: { guilds: { cache: new Map([[G, guild]]) }, user: { id: BOT } } as any, logs,
            ready: () => true, trusted: () => false,
            contain: async (_g, id) => { contained.push(id); return `Removed 3 dangerous roles from ${id}.`; },
            isBanned: async () => false,
            ban: async (_g, id) => { banned.push(id); return true; },
        });
        assert.equal(result.watch, 1);
        assert.deepEqual(contained.sort(), ['222222222222222222', '333333333333333333']);
        assert.deepEqual(banned, ['333333333333333333'], 'only the critical score is counter-attacked');
        assert.equal(s.threatFor === undefined, true);
        assert.equal(threatFor(s, G, '333333333333333333')!.strikes, 1);
        assert.equal(threatFor(s, G, '333333333333333333')!.last_action, 'strike');
        assert.equal(threatActions(s, G).length, 2, 'both actions are on the record');
        assert.equal(lines.length, 2, 'both actions are in the server log');
        const strikeLine = lines.map(l => String(l.data.description)).find(text => text.includes('333333333333333333'))!;
        assert.match(strikeLine, /Counter-attack:\*\* banned/);
        assert.match(strikeLine, /Critical/);
    } finally { s.close(); }
});

test('an automatic action is never repeated inside its cooldown, and never on a whitelisted person', async () => {
    const s = store();
    try {
        s.save(s.settings(G));
        s.run("UPDATE guild_config SET enabled=1, mode='enforce' WHERE guild_id=?", G);
        recordThreat(s, G, ATTACKER, 'mass_ban', 'x');
        recordThreat(s, G, ATTACKER, 'mass_ban', 'x');
        recordThreat(s, G, ATTACKER, 'mass_ban', 'x');   // 120 → critical
        const contained: string[] = [];
        const deps: any = {
            store: s, client: { guilds: { cache: new Map([[G, { id: G, ownerId: OWNER, members: { fetch: async () => ({ user: { bot: false } }) }, bans: { fetch: async () => { throw new Error('no'); } } }]]) }, user: { id: BOT } },
            logs: { push: () => undefined }, ready: () => true, trusted: (_g: any, id: string) => id === ATTACKER,
            contain: async (_g: any, id: string) => { contained.push(id); return 'Removed 1 dangerous role.'; },
            isBanned: async () => false, ban: async () => true,
        };
        const first = await sweepThreats(deps);
        assert.equal(first.contained + first.struck, 0, 'a whitelisted member is never touched');
        deps.trusted = () => false;
        await sweepThreats(deps);
        assert.equal(contained.length, 1);
        await sweepThreats(deps);
        assert.equal(contained.length, 1, 'the 10-minute cooldown holds');
        s.run('UPDATE threat_scores SET last_action_at=? WHERE guild_id=?', Date.now() - ACTION_COOLDOWN_MS - 1, G);
        await sweepThreats(deps);
        assert.equal(contained.length, 2, 'after the cooldown the board may act again');
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

test('a sweep in a server that is not ready does nothing at all', async () => {
    const s = store();
    try {
        s.save(s.settings(G));
        s.run("UPDATE guild_config SET enabled=1, mode='enforce' WHERE guild_id=?", G);
        recordThreat(s, G, ATTACKER, 'mass_ban', 'x');
        recordThreat(s, G, ATTACKER, 'mass_ban', 'x');
        recordThreat(s, G, ATTACKER, 'mass_ban', 'x');
        let contained = 0;
        const result = await sweepThreats({
            store: s, client: { guilds: { cache: new Map([[G, { id: G, ownerId: OWNER, members: { fetch: async () => null } }]]) } } as any,
            logs: { push: () => undefined }, ready: () => false,
            contain: async () => { contained++; return ''; }, isBanned: async () => false,
        });
        assert.equal(contained, 0);
        assert.equal(result.reviewed, 0);
        assert.equal(threatFor(s, G, ATTACKER)!.score, 120, 'nothing was even written while the server is not ready');
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
