/**
 * Demo data for the dashboard: `npm run dashboard:demo`.
 *
 * Creates ./data/dashboard-demo.db with a few servers, incidents, tickets and a threat board, then
 * serves the dashboard from it. Nothing here touches the real database, Discord, or the network,
 * so it is also the fastest way to look at the dashboard on a machine with no bot token.
 *
 *   npm run dashboard:demo                      → http://localhost:8080
 *   npm run dashboard:demo -- --port 9000       → another port
 *   npm run dashboard:demo -- --host 0.0.0.0    → visible from outside this machine
 */

import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from '../src/database/db.ts';
import { startDashboard } from '../src/dashboard/server.ts';

const args = process.argv.slice(2);
const flag = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const dbPath = resolve(flag('--db') ?? './data/dashboard-demo.db');
const port = Number(flag('--port') ?? process.env.DASHBOARD_PORT ?? 8080);
const host = flag('--host') ?? process.env.DASHBOARD_HOST ?? '0.0.0.0';

rmSync(dbPath, { force: true });
const store = new Store(dbPath);
const now = Date.now();
const HOUR = 3600000, DAY = 24 * HOUR;

const GUILDS = [
    { id: '401112223334445556', name: 'Ghost Vanguard', owner: '1277709272041394187' },
    { id: '402222223334445556', name: 'Midtown Lounge', owner: '1277709272041394187' },
    { id: '403333333334445556', name: 'Midtown Gaming', owner: '1277709272041394187' },
];

for (const [index, guild] of GUILDS.entries()) {
    store.markGuild(guild.id, guild.name, true, now);
    store.run(`INSERT OR REPLACE INTO guild_authorization(guild_id,name,state,joined_at,authorized_at,authorized_by,version,config_version,generation)
        VALUES(?,?,?,?,?,?,?,3,1)`, guild.id, guild.name, index === 2 ? 'PENDING_AUTHORIZATION' : 'AUTHORIZED', now - 40 * DAY, now - 39 * DAY, guild.owner, '3.0.0');
    if (index === 2)
        continue;
    store.save({ ...store.settings(guild.id), guildId: guild.id, authorized: true, enabled: true, mode: 'enforce', minAge: 7 });
    store.run("UPDATE guild_config SET enabled=1, mode='enforce' WHERE guild_id=?", guild.id);
    for (const rule of ['mass_ban', 'bot_add', 'channel_delete', 'role_delete', 'dangerous_grant', 'webhook_change'])
        store.run('INSERT OR REPLACE INTO antinuke_rules(guild_id,rule,enabled,count,seconds) VALUES(?,?,1,5,60)', guild.id, rule);
    store.run('INSERT OR REPLACE INTO grants(guild_id,user_id,kind,by_id,expires) VALUES(?,?,?,?,NULL)', guild.id, '333333333333333331', 'trusted', guild.owner);
    store.run('INSERT OR REPLACE INTO grants(guild_id,user_id,kind,by_id,expires) VALUES(?,?,?,?,NULL)', guild.id, '333333333333333332', 'trusted', guild.owner);
    store.run('INSERT INTO snapshots(guild_id,by_id,at,json) VALUES(?,?,?,?)', guild.id, guild.owner, now - 3 * HOUR, '{}');
    store.run('UPDATE snapshots SET number=(SELECT COUNT(*) FROM snapshots o WHERE o.guild_id=snapshots.guild_id AND o.id<=snapshots.id)');
}

// --- the threat board (the information board of possible attackers) ---------------------------------
const POINTS = { mass_ban: 40, dangerous_grant: 35, channel_delete: 25, role_delete: 25, webhook_change: 20, join_flood: 10, antiping: 10, role_create: 15, scam_post: 15 };
const levelOf = score => score >= 85 ? 'critical' : score >= 55 ? 'high' : score >= 25 ? 'watch' : 'quiet';
const THREATS = [
    { guild: GUILDS[0].id, user: '555111111111111111', rules: ['mass_ban', 'mass_ban', 'dangerous_grant'], strike: true },
    { guild: GUILDS[0].id, user: '555222222222222222', rules: ['channel_delete', 'channel_delete', 'webhook_change'] },
    { guild: GUILDS[0].id, user: '555333333333333333', rules: ['join_flood', 'antiping'] },
    { guild: GUILDS[1].id, user: '555444444444444444', rules: ['role_delete', 'role_create', 'scam_post'] },
];
for (const entry of THREATS) {
    store.withAuthorized(entry.guild, () => {
        let score = 0;
        entry.rules.forEach((rule, index) => {
            const at = now - (index + 1) * 40 * 60000;
            const points = POINTS[rule] ?? 5;
            score += points;
            store.run(`INSERT INTO threat_scores(guild_id,user_id,score,level,first_at,last_at,last_rule,strikes)
                VALUES(?,?,?,?,?,?,?,0) ON CONFLICT(guild_id,user_id) DO UPDATE SET score=excluded.score, level=excluded.level, last_at=excluded.last_at, last_rule=excluded.last_rule`,
                entry.guild, entry.user, score, levelOf(score), at, at, rule);
            store.run('INSERT INTO threat_events(guild_id,user_id,rule,points,detail,at) VALUES(?,?,?,?,?,?)', entry.guild, entry.user, rule, points,
                `Demo: ${rule.replaceAll('_', ' ')} detected by anti-nuke`, at);
        });
        if (entry.strike) {
            store.run('INSERT INTO threat_actions(guild_id,user_id,action,detail,by_id,at) VALUES(?,?,?,?,?,?)', entry.guild, entry.user, 'contain',
                'High score: strip their dangerous roles and put their damage back. Removed 4 dangerous roles.', '999999999999999999', now - 18 * 60000);
            store.run('INSERT INTO threat_actions(guild_id,user_id,action,detail,by_id,at) VALUES(?,?,?,?,?,?)', entry.guild, entry.user, 'strike',
                'Critical score: contain, put their damage back, then ban them. Banned.', '999999999999999999', now - 15 * 60000);
            store.run('UPDATE threat_scores SET last_action=?, last_action_at=?, strikes=strikes+1 WHERE guild_id=? AND user_id=?', 'strike', now - 15 * 60000, entry.guild, entry.user);
        } else if (levelOf(score) === 'high')
            store.run('INSERT INTO threat_actions(guild_id,user_id,action,detail,by_id,at) VALUES(?,?,?,?,?,?)', entry.guild, entry.user, 'contain',
                'High score: strip their dangerous roles and put their damage back. Removed 3 dangerous roles.', '999999999999999999', now - 9 * 60000);
    });
}

// --- incidents --------------------------------------------------------------------------------------
const INCIDENTS = [
    [GUILDS[0].id, '555111111111111111', 'mass_ban', 'enforce', 'Containment: stripped 4 dangerous roles. Reverts: 6 completed, 0 failed, 0 skipped.', 25 * 60000],
    [GUILDS[0].id, '555222222222222222', 'channel_delete', 'enforce', 'Removed 3 dangerous roles. Reverts: 3 completed, 0 failed, 0 skipped.', 3 * HOUR],
    [GUILDS[0].id, '555333333333333333', 'join_flood', 'warn', 'Warning: no roles were removed. Doing this again within an hour gets the normal punishment.', 6 * HOUR],
    [GUILDS[1].id, '555444444444444444', 'role_delete', 'enforce', 'Removed 2 dangerous roles. Reverts: 2 completed, 0 failed, 0 skipped.', 11 * HOUR],
    [GUILDS[0].id, '666111111111111111', 'webhook_change', 'enforce', 'Removed 1 dangerous role.', 2 * DAY],
    [GUILDS[0].id, '666222222222222222', 'automod_tamper', 'observe', 'Observed only; no Discord actions taken.', 3 * DAY],
];
for (const [guild, actor, rule, mode, result, ago] of INCIDENTS)
    store.run('INSERT INTO incidents(guild_id,actor_id,rule,at,mode,result) VALUES(?,?,?,?,?,?)', guild, actor, rule, now - ago, mode, result);

// --- the ticket desk -------------------------------------------------------------------------------
const TICKETS = [
    [1, 'General Support', 'Cannot verify my account', 'open', '777111111111111111', 'normal'],
    [2, 'Bug Report', 'Bot deletes my messages in #art', 'open', '777222222222222222', 'high'],
    [3, 'Partnership', 'Collab with our server?', 'open', '777333333333333333', 'urgent'],
    [4, 'General Support', 'Role request for event', 'closed', '777444444444444444', 'normal'],
    [5, 'Other', 'Question about the rules', 'closed', '777555555555555555', 'low'],
    [6, 'Bug Report', 'Ticket panel did not update', 'closed', '777666666666666666', 'normal'],
    [7, 'Feature Request', 'Add a movie night ping role', 'closed', '777777777777777777', 'normal'],
];
for (const [index, type, subject, status, user, priority] of TICKETS) {
    const opened = now - index * 26 * HOUR;
    const closed = status === 'closed' ? opened + 5 * HOUR : null;
    store.run(`INSERT INTO ticket_records(guild_id,number,channel_id,welcome_message_id,user_id,type,subject,details,claimed_by,priority,status,opened_at,last_activity,closed_at,closed_by,close_reason,rating)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, GUILDS[0].id, index, `90000000000000000${index}`, `80000000000000000${index}`, user, type, subject,
        'Demo ticket, seeded for the dashboard.', status === 'closed' ? '888111111111111111' : null, priority, status, opened, closed ?? opened + HOUR,
        closed, closed ? '888111111111111111' : null, closed ? 'Issue resolved' : null, closed ? (index % 2 ? 5 : 4) : null);
}
store.run('INSERT OR REPLACE INTO ticket_config(guild_id,staff_role_id,category_id,log_channel_id,ticket_limit,autoclose_hours,dm_transcripts,ask_rating,weekly_report,counter,by_id,at) VALUES(?,?,?,?,2,48,1,1,1,?,?,?)',
    GUILDS[0].id, '888222222222222222', '888333333333333333', '888444444444444444', TICKETS.length, '1277709272041394187', now);
for (const [name, emoji, description, position] of [['General Support', '🎫', 'Questions or help with anything', 0], ['Bug Report', '🐛', 'Report a problem', 1], ['Partnership', '🤝', 'Partner with the server', 2], ['Other', '❓', 'Anything else', 3]])
    store.run('INSERT INTO ticket_types(guild_id,name,emoji,description,position) VALUES(?,?,?,?,?)', GUILDS[0].id, name, emoji, description, position);

// --- closed cases, so the numbers look like a bot that has been running ------------------------------
for (let index = 0; index < 12; index++)
    store.run('INSERT INTO cases(guild_id,user_id,moderator_id,action,reason,at,number) VALUES(?,?,?,?,?,?,?)', GUILDS[0].id, `7770000000000000${index}`, '888111111111111111',
        index % 4 === 0 ? 'ban' : index % 3 === 0 ? 'timeout' : 'warn', 'Demo case', now - index * 9 * HOUR, index + 1);

store.close();
console.log(`Demo database written: ${dbPath}`);
console.log('Threat board, incidents, tickets and cases were seeded. No real data was touched.');
const { server, database } = startDashboard({ dbPath, port, host });
server.listen(port, host, () => console.log(`Dashboard ready on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`));
const close = () => { server.close(); database.close(); process.exit(0); };
process.on('SIGINT', close);
process.on('SIGTERM', close);
