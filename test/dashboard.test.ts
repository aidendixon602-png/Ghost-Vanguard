import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/database/db.js';
import { authorize } from './helpers.js';
import { answer, tokenAccepted } from '../src/dashboard/router.js';
import { overview, guilds, incidents, serverDetail, threats, tickets } from '../src/dashboard/data.js';
import { recordThreat, recordThreatAction } from '../src/security/threat-board.js';
import { seedTicketTypes } from '../src/features/tickets.js';

const G = '123456789012345678', ATTACKER = '111111111111111111', OWNER = '1277709272041394187';
const store = () => { const s = new Store(':memory:'); authorize(s, G); s.markGuild(G, 'Test server', true); return s; };

const get = (s: Store, url: string, token?: string) => answer(s, { method: 'GET', url, headers: {} }, { token });

test('the dashboard page is served without any build step or external asset', () => {
    const s = store();
    try {
        const page = get(s, '/');
        assert.equal(page.status, 200);
        assert.match(page.type, /text\/html/);
        assert.match(page.body, /Ghost Vanguard/);
        assert.match(page.body, /Control Board/);
        assert.match(page.body, /\/api\/guilds/);
        assert.doesNotMatch(page.body, /https?:\/\/(?!localhost)/u, 'no external URLs: it works offline');
        assert.match(page.body, /<img class="mark" src="data:image\/png;base64,/, 'the brand mark is inlined, not fetched');
        assert.match(page.body, /rel="icon" type="image\/png" href="data:image\/png;base64,/, 'the tab icon is inline too');
        assert.match(page.body, /setInterval\(tick, 15000\)/, 'it refreshes itself');
    } finally { s.close(); }
});

test('/healthz stays a plain liveness probe and unknown paths answer with the route list', () => {
    const s = store();
    try {
        const health = get(s, '/healthz');
        assert.equal(health.status, 200);
        assert.deepEqual(Object.keys(JSON.parse(health.body)).sort(), ['dashboard', 'ready', 'service', 'version']);
        const missing = get(s, '/api/nope');
        assert.equal(missing.status, 404);
        assert.ok(JSON.parse(missing.body).paths.includes('/api/threats?id='));
        const icon = get(s, '/favicon.ico');
        assert.equal(icon.status, 200);
        assert.equal(icon.type, 'image/png', 'the tab icon is the Ghost Vanguard mark, inlined');
        assert.equal(icon.encoding, 'base64', 'binary responses are flagged so the servers decode them');
        assert.equal(answer(s, { method: 'POST', url: '/' }).status, 405, 'the dashboard is read-only');
    } finally { s.close(); }
});

test('a token protects the page and the API when one is configured', () => {
    const s = store();
    try {
        assert.equal(get(s, '/api/guilds').status, 200, 'no token configured: open');
        assert.equal(get(s, '/api/guilds', 'secret').status, 401);
        assert.equal(get(s, '/api/guilds?token=secret', 'secret').status, 200);
        assert.equal(get(s, '/healthz', 'secret').status, 200, 'the probe never needs the token');
        assert.equal(answer(s, { method: 'GET', url: '/', headers: { authorization: 'Bearer secret' } }, { token: 'secret' }).status, 200);
        assert.equal(answer(s, { method: 'GET', url: '/', headers: { cookie: 'gv_dash=secret' } }, { token: 'secret' }).status, 200);
        assert.equal(tokenAccepted({ url: '/', headers: { authorization: ['Bearer nope'] } }, 'secret'), false);
    } finally { s.close(); }
});

test('the API refuses a missing or malformed server id instead of guessing', () => {
    const s = store();
    try {
        for (const path of ['/api/guild', '/api/threats', '/api/tickets', '/api/incidents']) {
            const response = get(s, path);
            assert.equal(response.status, 400, path);
            assert.match(JSON.parse(response.body).error, /id=<server id>/);
            assert.equal(get(s, `${path}?id=not-an-id`).status, 400, path);
        }
    } finally { s.close(); }
});

test('the overview counts servers, protection, threats, tickets and incidents', () => {
    const s = store();
    try {
        s.save({ ...s.settings(G), enabled: true, mode: 'enforce' });
        s.run("UPDATE guild_config SET enabled=1, mode='enforce' WHERE guild_id=?", G);
        s.run('INSERT INTO antinuke_rules(guild_id,rule,enabled,count,seconds) VALUES(?,?,1,5,60)', G, 'mass_ban');
        recordThreat(s, G, ATTACKER, 'mass_ban', 'demo');
        recordThreat(s, G, ATTACKER, 'mass_ban', 'demo');
        recordThreat(s, G, ATTACKER, 'mass_ban', 'demo');   // 120 → critical
        recordThreat(s, G, '222222222222222222', 'webhook_change', 'demo'); // 20 → quiet
        s.run("INSERT INTO incidents(guild_id,actor_id,rule,at,mode,result) VALUES(?,?,?,?,?,'x')", G, ATTACKER, 'mass_ban', Date.now(), 'enforce');
        seedTicketTypes(s, G);
        s.run("INSERT INTO ticket_records(guild_id,number,channel_id,user_id,type,subject,opened_at,last_activity) VALUES(?,?,?,?,?,?,?,?)", G, 1, 'c1', ATTACKER, 'Bug Report', 'x', Date.now(), Date.now());
        const data = overview(s);
        assert.deepEqual([data.service, data.version], ['Ghost Vanguard', '3.0.0']);
        assert.deepEqual([data.totals.servers, data.totals.authorized, data.totals.protected], [1, 1, 1]);
        assert.deepEqual([data.totals.critical, data.totals.watch], [1, 0]);
        assert.equal(data.totals.tickets, 1);
        assert.equal(data.totals.incidents24h, 1);
        const summary = data.servers[0]!;
        assert.deepEqual([summary.name, summary.protection.enabled, summary.protection.rules], ['Test server', true, 1]);
        assert.equal(summary.threats.total, 2);
        assert.equal(guilds(s)[0]!.authorized, true);
    } finally { s.close(); }
});

test('the threat API shows the board, the levels and what the bot already did', () => {
    const s = store();
    try {
        recordThreat(s, G, ATTACKER, 'mass_ban', 'banned five people');
        recordThreatAction(s, G, ATTACKER, 'strike', 'banned', '999999999999999999');
        const data = threats(s, G);
        assert.equal(data.threats.length, 1);
        const row = data.threats[0]!;
        assert.deepEqual([row.userId, row.score, row.level, row.strikes], [ATTACKER, 40, 'watch', 1]);
        assert.equal(row.lastRuleLabel, 'Mass ban');
        assert.equal(row.lastAction, 'strike');
        assert.equal(data.actions.length, 1);
        assert.match(data.actions[0]!.detail, /banned/);
        assert.equal(String(row.firstSeen).length > 0, true);
    } finally { s.close(); }
});

test('the tickets API reports the desk numbers and the newest tickets first', () => {
    const s = store();
    try {
        seedTicketTypes(s, G);
        s.run("INSERT INTO ticket_records(guild_id,number,channel_id,user_id,type,subject,opened_at,last_activity,status,closed_at,rating) VALUES(?,?,?,?,?,?,?,?,?,?,?)", G, 1, 'c1', ATTACKER, 'Bug Report', 'first', Date.now() - 1000, Date.now(), 'closed', Date.now(), 5);
        s.run("INSERT INTO ticket_records(guild_id,number,channel_id,user_id,type,subject,opened_at,last_activity) VALUES(?,?,?,?,?,?,?,?)", G, 2, 'c2', ATTACKER, 'Other', 'second', Date.now(), Date.now());
        const data = tickets(s, G);
        assert.deepEqual([data.stats.total, data.stats.open, data.stats.closed, data.stats.average], [2, 1, 1, 5]);
        assert.deepEqual(data.tickets.map(t => t.number), [2, 1]);
        assert.equal(data.tickets[1]!.rating, 5);
        assert.equal(data.week.opened, 2);
    } finally { s.close(); }
});

test('the incidents API is newest first and capped', () => {
    const s = store();
    try {
        for (let index = 0; index < 5; index++)
            s.run("INSERT INTO incidents(guild_id,actor_id,rule,at,mode,result) VALUES(?,?,?,?,?,'x')", G, ATTACKER, 'mass_ban', 1000 + index, 'enforce');
        const rows = incidents(s, G, 3);
        assert.deepEqual(rows.map(r => r.at), [1004, 1003, 1002]);
    } finally { s.close(); }
});

test('a server detail combines the summary, board, incidents and tickets', () => {
    const s = store();
    try {
        recordThreat(s, G, ATTACKER, 'mass_ban', 'x');
        const detail = serverDetail(s, G);
        assert.equal(detail.id, G);
        assert.equal(detail.board.threats.length, 1);
        assert.equal(detail.tickets.tickets.length, 0);
        assert.equal(Array.isArray(detail.incidents), true);
    } finally { s.close(); }
});

test('a dashboard read never leaks another server’s private data through the API', () => {
    const s = store();
    try {
        authorize(s, '223456789012345678');
        recordThreat(s, G, ATTACKER, 'mass_ban', 'x');
        const response = get(s, `/api/threats?id=223456789012345678`);
        assert.equal(response.status, 200);
        assert.equal(JSON.parse(response.body).threats.length, 0, 'the other server has its own empty board');
    } finally { s.close(); }
});
