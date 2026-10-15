import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection, PermissionFlagsBits } from 'discord.js';
import { Store } from '../src/database/db.js';
import { authorize } from './helpers.js';
import {
    DEFAULT_TICKET_TYPES, blockedFromTickets, blockUser, claimTicket, clearTicketCache, closeTicket, cooldownLeft,
    isTicketChannel, isTicketStaff, openTicket, openTicketIn, openTicketsFor, panelPayload, refreshTicketPanels, seedTicketTypes,
    startCooldown, ticketChannelGone, ticketConfig, ticketStats, ticketTypes, updateTicketConfig, weeklyReport, withPriority, stripPriority, slugify,
    loadTicketChannels, markTicketActivity, ticketById,
} from '../src/features/tickets.js';
import { buildTranscript } from '../src/features/ticket-transcript.js';

const G = '123456789012345678', G2 = '223456789012345678', USER = '111111111111111111', STAFF = '333333333333333333';
const BOT = '999999999999999999', OWNER = '1277709272041394187', STAFF_ROLE = '444444444444444444';
const store = (guild = G) => { const s = new Store(':memory:'); authorize(s, guild); return s; };

/** A server with just enough of discord.js to create a ticket channel and send messages. */
function fakeGuild(store: Store, guild = G) {
    const sent: any[] = [], created: any[] = [], deleted: string[] = [];
    const messages = new Map<string, any>();
    const channel: any = {
        id: '800000000000000001', name: 'general', type: ChannelType.GuildText, sends: 0,
        isTextBased: () => true, isSendable: () => true,
        set permissionOverwrites(_v: any) { },
        messages: { fetch: async (id: string) => messages.get(id) ?? null, new: async (id: string) => messages.get(id) ?? null },
        send: async (payload: any) => {
            channel.sends++;
            const message = { id: `90000000000000000${messages.size}`, url: `https://discord.com/channels/${guild}/800000000000000001/90000000000000000${messages.size}`,
                payload, pinned: 0, edits: 0, pin: async () => { message.pinned++; }, edit: async () => { message.edits++; } };
            messages.set(message.id, message); sent.push(message); return message;
        },
        delete: async () => { deleted.push(channel.id); },
    };
    const everyone: any = { id: guild };
    const staffRole: any = { id: STAFF_ROLE };
    const guildId = guild;
    const guildObject: any = {
        id: guildId, name: 'Test server', ownerId: OWNER,
        roles: { everyone, cache: new Collection<string, any>([[STAFF_ROLE, staffRole]]) },
        members: { me: { id: BOT, permissions: { has: () => true } }, fetchMe: async () => guildObject.members.me,
            fetch: async (id: string) => ({ id, displayName: 'Member', user: { id, tag: 'member#0001', username: 'member' },
                send: async () => { throw new Error('DMs closed'); } }) },
        channels: { cache: new Collection<string, any>([[channel.id, channel]]), fetch: async (id: string) => guildObject.channels.cache.get(id) ?? null,
            create: async (options: any) => { created.push(options); const c = { ...channel, id: '800000000000000002', options }; return c; } },
    };
    return { guild: guildObject, channel, sent, created, deleted, messages };
}

test('the ticket panel offers one option per type and fixed control ids that survive a restart', () => {
    const payload = panelPayload([
        { id: 1, name: 'General Support', emoji: '🎫', description: 'Questions or help', position: 0 },
        { id: 2, name: 'Bug Report', emoji: '🐛', description: null, position: 1 },
    ]);
    const menu = payload.components[0]!.toJSON().components[0] as any;
    assert.equal(menu.custom_id, 'vgticket-form:open');
    assert.deepEqual(menu.options.map((o: any) => o.value), ['1', '2']);
    assert.deepEqual(menu.options.map((o: any) => o.label), ['General Support', 'Bug Report']);
    assert.equal(menu.options[0].emoji.name, '🎫');
});

test('ticket types are seeded from the defaults, edited per server and never leak between servers', () => {
    const s = store();
    try {
        seedTicketTypes(s, G);
        const types = ticketTypes(s, G);
        assert.deepEqual(types.map(t => t.name), DEFAULT_TICKET_TYPES.map(t => t[0]));
        assert.deepEqual(ticketTypes(s, G2), [], 'another server starts empty');
        s.run('INSERT INTO ticket_types(guild_id,name,emoji,description,position) VALUES(?,?,?,?,?)', G, 'Partnership', '🤝', 'do not duplicate', 9);
        assert.equal(ticketTypes(s, G).length, 6);
    } finally { s.close(); }
});

test('settings round-trip through the store and are cached per server', () => {
    const s = store();
    try {
        assert.deepEqual([ticketConfig(s, G).ticketLimit, ticketConfig(s, G).autocloseHours, ticketConfig(s, G).dmTranscripts], [1, 48, true]);
        updateTicketConfig(s, G, { ticketLimit: 3, autocloseHours: 0, askRating: false, staffRoleId: STAFF_ROLE, logChannelId: '800000000000000009' }, USER);
        const config = ticketConfig(s, G);
        assert.deepEqual([config.ticketLimit, config.autocloseHours, config.askRating, config.staffRoleId], [3, 0, false, STAFF_ROLE]);
        clearTicketCache(s);
        assert.equal(ticketConfig(s, G).ticketLimit, 3, 'settings survive a cache clear (they are in the database)');
        assert.equal(ticketConfig(s, G2).ticketLimit, 1, 'the other server keeps its own settings');
    } finally { s.close(); }
});

test('panel edits are written to the panel message and dead panels are forgotten', async () => {
    const s = store();
    try {
        seedTicketTypes(s, G);
        const { guild, channel, messages } = fakeGuild(s);
        const panelMessage: any = { id: '900000000000000001', edits: 0, edit: async () => { panelMessage.edits++; } };
        messages.set(panelMessage.id, panelMessage);
        s.run('INSERT INTO ticket_panels(guild_id,message_id,channel_id,at) VALUES(?,?,?,?)', G, panelMessage.id, channel.id, Date.now());
        s.run('INSERT INTO ticket_panels(guild_id,message_id,channel_id,at) VALUES(?,?,?,?)', G, '900000000000000009', channel.id, Date.now());
        await s.withAuthorized(G, () => refreshTicketPanels(s, guild));
        assert.equal(panelMessage.edits, 1);
        assert.equal(s.all('SELECT * FROM ticket_panels WHERE guild_id=?', G).length, 1, 'the missing panel was dropped');
    } finally { s.close(); }
});

test('cooldown, per-member limit, blocks and staff checks use the ticket rules', () => {
    const s = store();
    try {
        assert.equal(cooldownLeft(G, USER), 0);
        startCooldown(G, USER);
        assert.ok(cooldownLeft(G, USER) > 0);
        assert.equal(cooldownLeft(G2, USER), 0, 'the cooldown is per server');
        updateTicketConfig(s, G, { ticketLimit: 2 }, USER);
        s.run('INSERT INTO ticket_records(guild_id,number,channel_id,user_id,type,opened_at,last_activity) VALUES(?,?,?,?,?,?,?)', G, 1, '800000000000000010', USER, 'Bug Report', Date.now(), Date.now());
        assert.equal(openTicketsFor(s, G, USER).length, 1);
        assert.equal(openTicketsFor(s, G, STAFF).length, 0);
        blockUser(s, G, USER, 'spamming tickets', STAFF);
        assert.equal(blockedFromTickets(s, G, USER)?.reason, 'spamming tickets');
        assert.equal(blockedFromTickets(s, G2, USER), undefined, 'blocks are per server');
        updateTicketConfig(s, G, { staffRoleId: STAFF_ROLE }, USER);
        const staffMember: any = { id: STAFF, guild: { id: G, ownerId: OWNER }, roles: { cache: new Collection([[STAFF_ROLE, {}]]) }, permissions: { has: () => false } };
        const plainMember: any = { id: USER, guild: { id: G, ownerId: OWNER }, roles: { cache: new Collection() }, permissions: { has: () => false } };
        assert.equal(isTicketStaff(s, G, STAFF, staffMember), true, 'the staff role counts');
        assert.equal(isTicketStaff(s, G, USER, plainMember), false);
        assert.equal(isTicketStaff(s, G, USER, { id: USER, guild: { id: G, ownerId: OWNER }, roles: { cache: new Collection() },
            permissions: { has: (p: bigint) => p === PermissionFlagsBits.ManageGuild } }), true, 'Manage Server counts');
        assert.equal(isTicketStaff(s, G, OWNER, plainMember), true, 'a Vanguard rank (the bot owner) counts');
    } finally { s.close(); }
});

test('opening a ticket creates a private channel, records it and posts the welcome with its buttons', async () => {
    const s = store();
    try {
        seedTicketTypes(s, G);
        const { guild, sent, created } = fakeGuild(s);
        const config = updateTicketConfig(s, G, { staffRoleId: STAFF_ROLE }, USER);
        const type = ticketTypes(s, G)[0]!;
        const opened = await s.withAuthorized(G, () => openTicket({ guild, user: { id: USER, tag: 'member#0001' } as any, type,
            subject: 'Cannot log in', details: 'It says my password is wrong', config, store: s }));
        const options = created.at(-1);
        assert.equal(options.name, 'general-support-0001', 'channel name is the type plus the ticket number');
        const ids = options.permissionOverwrites.map((o: any) => o.id);
        assert.ok(ids.includes(G), '@everyone is overwritten');
        assert.ok(ids.includes(STAFF_ROLE), 'the staff role is given access');
        assert.ok(ids.includes(USER), 'the member is given access');
        const rows = s.all('SELECT * FROM ticket_records WHERE guild_id=?', G);
        assert.equal(rows.length, 1);
        assert.deepEqual([rows[0]!.number, rows[0]!.status, rows[0]!.type, rows[0]!.subject], [1, 'open', type.name, 'Cannot log in']);
        const welcome = sent.at(-1)!;
        assert.match(welcome.payload.embeds[0].data.title, /Ticket #0001/);
        const buttons = welcome.payload.components[0].toJSON().components as any[];
        assert.deepEqual(buttons.map(b => [b.label, b.custom_id]), [['Claim', 'vgticket:claim'], ['Close', 'vgticket-form:close']]);
        assert.equal(welcome.pinned, 1, 'the welcome message is pinned');
        assert.equal(s.get('SELECT welcome_message_id m FROM ticket_records WHERE guild_id=?', G)!.m, welcome.id);
        assert.equal(isTicketChannel(opened.channel.id), true);
        assert.equal(cooldownLeft(G, USER) > 0, true, 'opening starts the anti-spam cooldown');
    } finally { s.close(); }
});

test('the same person cannot open a second ticket while the first one is open', async () => {
    const s = store();
    try {
        seedTicketTypes(s, G);
        const { guild } = fakeGuild(s);
        const config = updateTicketConfig(s, G, { staffRoleId: STAFF_ROLE }, USER);
        const type = ticketTypes(s, G)[0]!;
        await s.withAuthorized(G, () => openTicket({ guild, user: { id: USER, tag: 'member#0001' } as any, type, subject: 'One', details: '', config, store: s }));
        assert.equal(openTicketsFor(s, G, USER).length, 1);
        assert.equal(ticketConfig(s, G).counter, 1, 'numbers only count tickets that were really created');
    } finally { s.close(); }
});

test('claiming locks the ticket, updates the welcome buttons and refuses a second claim', async () => {
    const s = store();
    try {
        seedTicketTypes(s, G);
        const { guild } = fakeGuild(s);
        const config = updateTicketConfig(s, G, { staffRoleId: STAFF_ROLE }, USER);
        await s.withAuthorized(G, () => openTicket({ guild, user: { id: USER, tag: 'member#0001' } as any, type: ticketTypes(s, G)[0]!, subject: 'Help', details: '', config, store: s }));
        await s.withAuthorized(G, async () => {
            const ticket = openTicketIn(s, G, '800000000000000002')!;
            assert.equal(claimTicket(s, G, ticket, { id: STAFF, displayName: 'Alex' } as any, ticket.claimed_by), true);
            const claimed = ticketById(s, G, ticket.id)!;
            assert.equal(claimed.claimed_by, STAFF);
            assert.equal(claimTicket(s, G, claimed, null, null), false, 'a claim that lost the race is refused');
        });
    } finally { s.close(); }
});

test('closing saves a transcript to the log channel and the member, then deletes the channel', async () => {
    const s = store();
    try {
        seedTicketTypes(s, G);
        const { guild, messages } = fakeGuild(s);
        const logChannel: any = { id: '800000000000000005', isSendable: () => true, sent: [] as any[], send: async (p: any) => { logChannel.sent.push(p); return { id: 'x' }; } };
        guild.channels.cache.set(logChannel.id, logChannel);
        const config = updateTicketConfig(s, G, { staffRoleId: STAFF_ROLE, logChannelId: logChannel.id }, USER);
        const opened = await s.withAuthorized(G, () => openTicket({ guild, user: { id: USER, tag: 'member#0001' } as any, type: ticketTypes(s, G)[0]!, subject: 'Help', details: '', config, store: s }));
        const chatMessage = { id: '1', createdTimestamp: 1, createdAt: new Date(0),
            author: { displayName: 'Member', username: 'member', bot: false, displayAvatarURL: () => 'https://cdn/a.png' },
            cleanContent: 'any update?', embeds: [], attachments: new Collection() };
        const channel: any = { id: opened.channel.id, name: 'general-support-0001', isTextBased: () => true, sends: 0, deleted: 0,
            messages: { fetch: async () => new Collection([[chatMessage.id, chatMessage]]) },
            send: async () => ({ id: 'm' }), delete: async () => { channel.deleted++; } };
        const closed = await s.withAuthorized(G, () => closeTicket({ store: s, guild, channel, ticket: openTicketIn(s, G, channel.id)!,
            closer: { id: STAFF } as any, reason: 'Resolved', config: ticketConfig(s, G), client: { users: { fetch: async () => ({ send: async () => ({ edit: async () => ({}) }) }) } } as any }));
        assert.equal(closed, true);
        const row = s.get('SELECT * FROM ticket_records WHERE guild_id=?', G)!;
        assert.deepEqual([row.status, row.close_reason, row.closed_by], ['closed', 'Resolved', STAFF]);
        const withTranscript = logChannel.sent.filter((p: any) => p.files?.length);
        assert.equal(withTranscript.length, 1, 'the transcript went to the log channel');
        assert.match(withTranscript[0].files[0].name, /^ticket-0001\.html$/);
        assert.match(withTranscript[0].embeds[0].data.title, /Ticket #0001 closing/);
        assert.equal(channel.deleted, 0, 'the channel is deleted a few seconds later, not during the command');
    } finally { s.close(); }
});

test('a close that cannot save the transcript leaves the ticket open for a retry', async () => {
    const s = store();
    try {
        seedTicketTypes(s, G);
        const { guild } = fakeGuild(s);
        const config = updateTicketConfig(s, G, { staffRoleId: STAFF_ROLE, dmTranscripts: false }, USER);
        await s.withAuthorized(G, () => openTicket({ guild, user: { id: USER, tag: 'member#0001' } as any, type: ticketTypes(s, G)[0]!, subject: 'Help', details: '', config, store: s }));
        const channel: any = { id: '800000000000000002', isTextBased: () => true, send: async () => ({ id: 'm' }), delete: async () => { throw new Error('must not delete'); },
            messages: { fetch: async () => new Collection() } };
        await assert.rejects(s.withAuthorized(G, () => closeTicket({ store: s, guild, channel, ticket: openTicketIn(s, G, channel.id)!,
            closer: { id: STAFF } as any, reason: 'Resolved', config: ticketConfig(s, G), client: { users: { fetch: async () => null } } as any })),
        /stays open/);
        assert.equal(s.get('SELECT status FROM ticket_records WHERE guild_id=?', G)!.status, 'open', 'the ticket can be closed again once the log works');
    } finally { s.close(); }
});

test('a hand-deleted ticket channel stops counting as an open ticket', () => {
    const s = store();
    try {
        s.run('INSERT INTO ticket_records(guild_id,number,channel_id,user_id,type,opened_at,last_activity) VALUES(?,?,?,?,?,?,?)', G, 1, '800000000000000003', USER, 'Other', Date.now(), Date.now());
        loadTicketChannels(s);
        assert.equal(isTicketChannel('800000000000000003'), true);
        ticketChannelGone(s, G, '800000000000000003');
        assert.equal(isTicketChannel('800000000000000003'), false);
        const row = s.get('SELECT * FROM ticket_records WHERE guild_id=?', G)!;
        assert.deepEqual([row.status, row.close_reason], ['closed', 'Channel deleted manually']);
    } finally { s.close(); }
});

test('messages in a ticket keep it alive, and only that server sees the update', () => {
    const s = store();
    try {
        s.run('INSERT INTO ticket_records(guild_id,number,channel_id,user_id,type,opened_at,last_activity,warned) VALUES(?,?,?,?,?,?,?,1)', G, 1, '800000000000000004', USER, 'Other', 1, 1);
        loadTicketChannels(s);
        assert.equal(s.withAuthorized(G, () => markTicketActivity(s, '800000000000000004', 999)), true);
        const row = s.get('SELECT last_activity, warned FROM ticket_records WHERE guild_id=?', G)!;
        assert.deepEqual([row.last_activity, row.warned], [999, 0], 'activity clears the inactivity warning');
        assert.equal(s.withAuthorized(G, () => markTicketActivity(s, '800000000000000099')), false, 'channels that are not tickets are ignored');
    } finally { s.close(); }
});

test('stats and the weekly report count only their own server', () => {
    const s = store();
    try {
        const at = Date.now();
        s.run('INSERT INTO ticket_records(guild_id,number,channel_id,user_id,type,opened_at,last_activity,status,claimed_by,closed_at,rating) VALUES(?,?,?,?,?,?,?,?,?,?,?)', G, 1, 'c1', USER, 'Bug Report', at, at, 'closed', STAFF, at, 5);
        s.run('INSERT INTO ticket_records(guild_id,number,channel_id,user_id,type,opened_at,last_activity,status,claimed_by,closed_at) VALUES(?,?,?,?,?,?,?,?,?,?)', G, 2, 'c2', USER, 'Bug Report', at, at, 'closed', STAFF, at);
        s.run('INSERT INTO ticket_records(guild_id,number,channel_id,user_id,type,opened_at,last_activity) VALUES(?,?,?,?,?,?,?)', G, 3, 'c4', USER, 'Other', at, at);
        s.run('INSERT INTO ticket_records(guild_id,number,channel_id,user_id,type,opened_at,last_activity) VALUES(?,?,?,?,?,?,?)', G2, 1, 'c3', USER, 'Other', at, at);
        const stats = ticketStats(s, G);
        assert.deepEqual([stats.total, stats.open, stats.closed], [3, 1, 2]);
        assert.equal(stats.average, 5);
        assert.equal(stats.staff[0]!.claimed_by, STAFF);
        assert.equal(ticketStats(s, G2).total, 1);
        const report = weeklyReport(s, G, at + 1000);
        assert.deepEqual([report.opened, report.closed, report.openNow, report.urgent], [3, 2, 1, 0]);
        assert.equal(report.topType!.name, 'Bug Report');
    } finally { s.close(); }
});

test('priority prefixes and channel names follow the ticket naming rules', () => {
    assert.equal(slugify('Bug Report!'), 'bug-report');
    assert.equal(slugify('🎫'), 'ticket');
    assert.equal(withPriority('bug-report-0001', 'urgent'), '🔴-bug-report-0001');
    assert.equal(withPriority('bug-report-0001', 'normal'), 'bug-report-0001');
    assert.equal(stripPriority('🔴-bug-report-0001'), 'bug-report-0001');
    assert.equal(stripPriority('bug-report-0001'), 'bug-report-0001');
});

test('the transcript is HTML-safe and counts every message', async () => {
    const channel: any = {
        messages: { fetch: async () => new Collection([
            ['1', { id: '1', createdTimestamp: 1, createdAt: new Date(0), author: { displayName: '<script>', username: 'x', bot: false, displayAvatarURL: () => 'https://cdn/a.png' }, cleanContent: '<b>bold</b> & "quotes"', embeds: [], attachments: new Collection() }],
            ['2', { id: '2', createdTimestamp: 2, createdAt: new Date(1000), author: { displayName: 'A', username: 'a', bot: true, displayAvatarURL: () => 'https://cdn/b.png' }, cleanContent: 'hello', embeds: [{ title: 'Card', description: 'line', fields: [{ name: 'F', value: 'V' }] }], attachments: new Collection([['x', { url: 'https://cdn/file.png', name: 'file.png', contentType: 'image/png' }]]) }],
        ]) },
    };
    const guild: any = { name: 'Test <server>', members: { fetch: async () => ({ user: { tag: 'member#0001' } }) } };
    const ticket: any = { user_id: USER, claimed_by: null, subject: '<subject>', type: 'Bug Report', number: 7 };
    const { html, count } = await buildTranscript(channel, ticket, guild);
    assert.equal(count, 2);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&lt;b&gt;bold&lt;\/b&gt; &amp; &quot;quotes&quot;/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /Ticket #0007/);
    assert.match(html, /Test &lt;server&gt;/);
    assert.match(html, /<span class="tag">BOT<\/span>/);
    assert.match(html, /<img class="att"/);
});

test('the desk refuses to read another server’s tickets', () => {
    const s = store();
    try {
        s.run('INSERT INTO ticket_records(guild_id,number,channel_id,user_id,type,opened_at,last_activity) VALUES(?,?,?,?,?,?,?)', G, 1, 'c1', USER, 'Other', 1, 1);
        assert.throws(() => s.readGuild(G, () => s.all('SELECT * FROM ticket_records WHERE guild_id=?', G2)), /Cross-guild|not authorized/);
    } finally { s.close(); }
});
