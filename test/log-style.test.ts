import test from 'node:test';
import assert from 'assert/strict';
import { AuditLogEvent, Colors, EmbedBuilder } from 'discord.js';
import { Store } from '../src/database/db.js';
import { LogQueue } from '../src/logging.js';
import { describeAudit, renderEvent } from '../src/audit/event-log.js';
import { LOG_PALETTE, logScopeFor, logToneFor, styleLogEmbed } from '../src/ui/log-style.js';
import { embed } from '../src/ui/ui.js';
import { ticketLog } from '../src/features/tickets.js';
import { authorize } from './helpers.js';

const G = '500000000000000001';

test('Signal theme brands a log once, keeps useful footer details and preserves the timestamp', () => {
    const at = new Date('2026-11-13T21:28:00Z');
    const source = new EmbedBuilder().setTitle('🗑️ Channel deleted').setDescription('#veil-auth')
        .setColor(Colors.Red).setAuthor({ name: 'web3_w2z', iconURL: 'https://cdn.example/a.png' })
        .setFooter({ text: 'Target ID: 42' }).setTimestamp(at);
    const styled = styleLogEmbed(source);
    assert.equal(styled.author?.name, 'GHOST VANGUARD / CHANNELS');
    assert.equal(styled.title, '▣ Channel deleted');
    assert.equal(styled.color, LOG_PALETTE.coral);
    assert.equal(styled.thumbnail?.url, 'https://cdn.example/a.png');
    assert.equal(styled.footer?.text, 'Ghost Vanguard · Target ID: 42');
    assert.equal(styled.timestamp, at.toISOString());
    assert.deepEqual(styleLogEmbed(styled), styled, 'delivery and refresh must not stack a second header');
});

test('log scopes and severity tones stay stable for the existing card titles', () => {
    assert.equal(logScopeFor('Bot permission role change blocked'), 'security');
    assert.equal(logScopeFor('Promotion'), 'roles');
    assert.equal(logScopeFor('Member joined'), 'members');
    assert.equal(logScopeFor('Message deleted by a moderator'), 'messages');
    assert.equal(logScopeFor('Ticket #0001 opened'), 'tickets');
    assert.equal(logScopeFor('Member Banned'), 'moderation');
    assert.equal(logToneFor('Channel deleted', Colors.Red), 'coral');
    assert.equal(logToneFor('Ticket opened', Colors.Green), 'mint');
    assert.equal(logToneFor('Anti-nuke Warning', Colors.Yellow), 'amber');
    assert.equal(logToneFor('Role changes', Colors.Purple), 'violet');
    assert.equal(logToneFor('Ban expired', 0x43B581), 'mint', 'custom record colours keep their meaning');
});

test('deleted channel cards show a compact summary instead of a grid of "→ none" fields', () => {
    const guild: any = { id: G, client: { user: { id: 'bot' }, users: { cache: new Map() } } };
    const entry: any = {
        id: '1', action: AuditLogEvent.ChannelDelete, executorId: 'web3_w2z', targetId: '42', createdTimestamp: Date.now(),
        changes: [
            { key: 'name', old: 'veil-auth' },
            { key: 'topic', old: 'Servers that tried to add the bot' },
            { key: 'nsfw', old: false },
            { key: 'rate_limit_per_user', old: 0 },
        ],
    };
    const event = describeAudit(entry, guild)!;
    const card = styleLogEmbed(renderEvent({ ...event, compact: true }));
    assert.equal(card.title, '▣ Channel deleted');
    assert.equal(card.author?.name, 'GHOST VANGUARD / CHANNELS');
    assert.equal(card.color, LOG_PALETTE.coral);
    assert.match(card.description!, /^\*\*#veil-auth\*\*\n-# Changed by <@web3_w2z>$/);
    assert.doesNotMatch(JSON.stringify(card), /→ none/);
    assert.deepEqual(card.fields?.map(f => [f.name, f.inline]), [['Topic', false]]);
});

test('the outbox keeps original JSON and applies the theme on delivery, including older plain alerts and buttons', async () => {
    const store = new Store(':memory:');
    authorize(store, G);
    const sent: any[] = [];
    const client: any = { isReady: () => true, channels: { fetch: async () => ({ isSendable: () => true, send: async (m: any) => { sent.push(m); return { id: 'm' }; } }) } };
    const logs = new LogQueue(store, client);
    try {
        store.run('INSERT INTO outbox(guild_id,channel_id,json) VALUES(?,?,?)', G, 'logs', JSON.stringify({ title: 'Older alert', description: 'kept' }));
        logs.push(G, new EmbedBuilder().setTitle('Incident').setDescription('response'), [{ toJSON: () => ({ type: 1, components: [{ type: 2, custom_id: 'incident:restore:1' }] }) } as any], 'logs');
        const pending = store.all('SELECT json FROM outbox WHERE guild_id=?', G);
        assert.ok(pending.every(row => !String(row.json).includes('GHOST VANGUARD /')), 'styling is a delivery concern, not a schema change');
        await logs.flush();
        assert.deepEqual(sent.map(m => m.embeds[0].title), ['◈ Older alert', '◆ Incident']);
        assert.equal(sent[0].embeds[0].description, 'kept');
        assert.equal(sent[1].components[0].components[0].custom_id, 'incident:restore:1');
        assert.match(sent[1].nonce, /^mv\d+$/);
        assert.equal(store.get('SELECT COUNT(*) AS n FROM outbox WHERE guild_id=?', G)!.n, 0);
    } finally { store.close(); }
});

test('ticket logs use the same theme and keep transcript attachments', async () => {
    const sent: any[] = [];
    const channel = { isSendable: () => true, send: async (payload: any) => { sent.push(payload); return { id: 'm' }; } };
    const guild: any = { channels: { cache: { get: () => channel } } };
    const file = { name: 'ticket-0001.html' } as any;
    const ok = await ticketLog(guild, { logChannelId: 'ticket-logs' } as any, { embeds: [embed('📥 Ticket #0001 opened', '**User:** <@1>', Colors.Green)], files: [file] });
    assert.equal(ok, true);
    assert.equal(sent[0].embeds[0].data.author.name, 'GHOST VANGUARD / TICKETS');
    assert.equal(sent[0].embeds[0].data.title, '▤ Ticket #0001 opened');
    assert.equal(sent[0].embeds[0].data.color, LOG_PALETTE.mint);
    assert.deepEqual(sent[0].files, [file]);
    assert.deepEqual(sent[0].allowedMentions, { parse: [] });
});
