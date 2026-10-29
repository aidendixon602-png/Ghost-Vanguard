import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionFlagsBits, PermissionsBitField, SlashCommandBuilder } from 'discord.js';
import { commandText, fromMessage, HANDOFF_EMOJI, HANDOFF_WINDOW_MS, isHandoff, parse, PRIVATE_COMMANDS, words } from '../src/bot/text-commands.js';
import { gvLine, gvText } from '../src/ui/gv-names.js';
import { Registry, defineCommand } from '../src/bot/registry.js';
import { Interactions } from '../src/bot/interactions.js';
import { Store } from '../src/database/db.js';
import { authorize } from './helpers.js';

const VEIL = '1563480035493417021';
const G = '123456789012345678', USER = '223456789012345678', TARGET = '323456789012345678', ROLE = '423456789012345678';

/** A small slice of the real command tree's shape: a group, a flat subcommand, options of each kind. */
const TREE = [
    { name: 'raid', type: 1, options: [
        { type: 2, name: 'mode', options: [
            { type: 1, name: 'on', options: [{ type: 3, name: 'reason', required: false }] },
            { type: 1, name: 'off', options: [] }] },
        { type: 1, name: 'lockdown', options: [{ type: 3, name: 'reason', required: false }, { type: 5, name: 'all', required: false }] }] },
    { name: 'antinuke', type: 1, options: [
        { type: 2, name: 'whitelist', options: [
            { type: 1, name: 'add', options: [{ type: 9, name: 'target', required: true }, { type: 3, name: 'scope', required: false, choices: [{ name: 'Full', value: 'full' }, { name: 'Ban rule', value: 'ban' }] }] }] }] },
    { name: 'mod', type: 1, options: [
        { type: 1, name: 'ban', options: [{ type: 6, name: 'user', required: true }, { type: 3, name: 'reason', required: false }, { type: 4, name: 'days', required: false }] }] },
    { name: 'help', type: 1, options: [] },
];

test('the command text comes after any prefix and gv / vanguard / ghost', () => {
    assert.equal(commandText(',gv raid mode on'), 'raid mode on');
    assert.equal(commandText('!vanguard  antinuke status'), 'antinuke status');
    assert.equal(commandText(',GHOST help'), 'help');
    assert.equal(commandText(',gv'), '');
    assert.equal(commandText('hello gv raid'), null, 'only at the start');
    assert.equal(commandText(',gvx raid'), null);
    assert.deepEqual(words('mod ban @x "being rude" 7'), ['mod', 'ban', '@x', 'being rude', '7']);
});

test('words map onto the command tree: groups, subcommands, positional and named options', () => {
    assert.deepEqual(parse('raid mode on spam wave', TREE), { commandName: 'raid', fileOption: undefined,
        data: [{ name: 'mode', type: 2, options: [{ name: 'on', type: 1, options: [{ name: 'reason', type: 3, value: 'spam wave' }] }] }] });
    const ban = parse(`mod ban <@${TARGET}> reason:"alt account" days:7`, TREE).data[0].options;
    assert.deepEqual(ban, [{ name: 'user', type: 6, value: TARGET }, { name: 'reason', type: 3, value: 'alt account' }, { name: 'days', type: 4, value: 7 }]);
    assert.deepEqual(parse('raid lockdown all:yes', TREE).data[0].options, [{ name: 'all', type: 5, value: true }]);
    assert.equal(parse(`antinuke whitelist add <@&${ROLE}> ban`, TREE).data[0].options[0].options[1].value, 'ban', 'choices by value');
    assert.equal(parse(`antinuke whitelist add <@&${ROLE}> "Ban rule"`, TREE).data[0].options[0].options[1].value, 'ban', 'or by name');
});

const REAL = [
    { name: 'antinuke', type: 1, options: [{ type: 2, name: 'whitelist', options: [{ type: 1, name: 'add', options: [{ type: 6, name: 'user' }, { type: 8, name: 'role' }] }] }] },
    { name: 'raid', type: 1, options: [{ type: 2, name: 'mode', options: [{ type: 1, name: 'on', options: [{ type: 4, name: 'min_account_age_days' }, { type: 3, name: 'action' }, { type: 4, name: 'hours' }] }] }] },
    { name: 'mod', type: 1, options: [
        { type: 1, name: 'ban', options: [{ type: 6, name: 'user', required: true }, { type: 3, name: 'reason' }, { type: 4, name: 'delete_messages' }, { type: 3, name: 'evidence' }] },
        { type: 1, name: 'timeout', options: [{ type: 6, name: 'user', required: true }, { type: 4, name: 'minutes', required: true }, { type: 3, name: 'reason' }] }] },
];
const leaf = (t: string) => { let d = parse(t, REAL).data; while (d[0]?.options && (d[0].type === 1 || d[0].type === 2)) d = d[0].options; return Object.fromEntries(d.map((o: any) => [o.name, o.value])); };

test('each word goes to the option that can take it', () => {
    assert.deepEqual(leaf(`antinuke whitelist add <@&${ROLE}>`), { role: ROLE }, 'a role mention fills the role option, not the user one');
    assert.deepEqual(leaf(`antinuke whitelist add <@${TARGET}>`), { user: TARGET });
    assert.deepEqual(leaf('raid mode on 7 kick 2'), { min_account_age_days: 7, action: 'kick', hours: 2 });
    assert.deepEqual(leaf(`mod ban <@${TARGET}> being rude 7`), { user: TARGET, reason: 'being rude', delete_messages: 7 });
    assert.deepEqual(leaf(`mod ban <@${TARGET}> spam evidence:https://x.io/a`), { user: TARGET, reason: 'spam', evidence: 'https://x.io/a' });
    assert.deepEqual(leaf(`mod timeout ${TARGET} 10 spamming the chat`), { user: TARGET, minutes: 10, reason: 'spamming the chat' });
});

test('mistakes say what to type instead', () => {
    assert.throws(() => parse('raid mode', TREE), /needs one of: `on`, `off`/);
    assert.throws(() => parse('mod ban', TREE), /Missing `user`.*Usage: `,gv mod ban <user> \[reason\] \[days\]`/);
    assert.throws(() => parse(`mod ban ${TARGET} spam days:soon`, TREE), /`days` must be a number/);
    assert.throws(() => parse('nope', TREE), /no `gv nope` command.*,gv help/);
    assert.throws(() => parse(`antinuke whitelist add ${ROLE} sometimes`, TREE), /must be one of: `full`, `ban`/);
});

const msg = (o: any = {}) => ({ createdTimestamp: Date.now(), editedTimestamp: null, author: { bot: false }, content: ',gv raid mode on', ...o });

test('only Veil\'s own 🛡️ on a fresh, unedited ,gv message hands it over', () => {
    assert.ok(isHandoff(VEIL, HANDOFF_EMOJI, msg()));
    assert.ok(!isHandoff(USER, HANDOFF_EMOJI, msg()), 'a member reacting the same emoji does nothing');
    assert.ok(!isHandoff(VEIL, '👍', msg()));
    assert.ok(!isHandoff(VEIL, HANDOFF_EMOJI, msg({ editedTimestamp: Date.now() })), 'edited after Veil saw it: refused');
    assert.ok(!isHandoff(VEIL, HANDOFF_EMOJI, msg({ createdTimestamp: Date.now() - HANDOFF_WINDOW_MS - 1 })), 'too old');
    assert.ok(!isHandoff(VEIL, HANDOFF_EMOJI, msg({ author: { bot: true } })), 'never a bot\'s message');
    assert.ok(!isHandoff(VEIL, HANDOFF_EMOJI, msg({ content: 'hello' })));
    assert.ok(PRIVATE_COMMANDS.has('dev') && PRIVATE_COMMANDS.has('network'));
});

test('everything Vanguard posts names its commands as ,gv commands', () => {
    assert.equal(gvLine('Use `/raid mode on` or /antinuke status.'), 'Use `,gv raid mode on` or ,gv antinuke status.');
    assert.equal(gvLine('https://discord.com/channels/1/2 and a/mod path'), 'https://discord.com/channels/1/2 and a/mod path', 'links and paths untouched');
    const out: any = gvText({ content: 'see /help', embeds: [{ title: 'Run `/setup logs`', fields: [{ name: 'Next', value: '**/ticket panel**' }] }], components: [{ type: 1, components: [{ custom_id: 'raid:/raid', label: 'Open /raid' }] }] });
    assert.equal(out.content, 'see ,gv help');
    assert.equal(out.embeds[0].title, 'Run `,gv setup logs`');
    assert.equal(out.embeds[0].fields[0].value, '**,gv ticket panel**');
    assert.equal(out.components[0].components[0].custom_id, 'raid:/raid', 'button IDs are never changed');
    assert.equal(out.components[0].components[0].label, 'Open ,gv raid');
});

function world() {
    const replies: any[] = [], dms: any[] = [];
    const member: any = { id: USER, permissions: new PermissionsBitField(PermissionFlagsBits.Administrator), roles: { highest: { comparePositionTo: () => 1 }, cache: new Collection() } };
    const target = { id: TARGET, username: 'raider', bot: false };
    const guild: any = {
        id: G, name: 'Guild', ownerId: USER, preferredLocale: 'en-US',
        members: { me: { permissions: new PermissionsBitField(PermissionFlagsBits.Administrator) }, fetch: async (id: any) => (id === USER || id?.user === USER) ? member : null },
        roles: { cache: new Collection() }, channels: { cache: new Collection() },
        client: { user: { id: 'vanguard' }, users: { fetch: async (id: string) => id === TARGET ? target : null } },
    };
    member.guild = guild;
    const message: any = {
        id: '900000000000000001', guildId: G, guild, channelId: 'c1', member, createdTimestamp: Date.now(), editedTimestamp: null,
        author: { id: USER, tag: 'boss', bot: false, send: async (p: any) => { dms.push(p); return { id: 'dm' }; } },
        client: guild.client, attachments: new Collection(), channel: { id: 'c1', sendTyping: async () => undefined },
        inGuild: () => true,
        reply: async (p: any) => { replies.push(p); return { id: `r${replies.length}`, edit: async (q: any) => { replies.push(q); return {}; } }; },
    };
    return { message, replies, dms, guild };
}

test('a ,gv message runs the real command code through the router, with the target resolved', async () => {
    const w = world();
    const store = new Store(':memory:'); authorize(store, G);
    const registry = new Registry();
    let seen: any = null;
    registry.add(defineCommand(new SlashCommandBuilder().setName('mod').setDescription('Mod')
        .addSubcommand(s => s.setName('ban').setDescription('Ban').addUserOption(o => o.setName('user').setDescription('u').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('r'))),
    {}, async (_ctx, i) => {
        seen = { sub: i.options.getSubcommand(), user: i.options.getUser('user', true).id, reason: i.options.getString('reason') };
        return 'Banned.';
    }), 'mod');
    try {
        w.message.content = `,gv mod ban <@${TARGET}> being rude`;
        const i = await fromMessage(w.message, TREE);
        await new Interactions({ store, registry, client: {}, security: {}, roblox: {}, snapshots: {}, logs: {}, lifecycle: { isReady: () => true }, confirmations: new Map(), ai: { inFlight: 0 } } as any).handle(i as any);
        assert.deepEqual(seen, { sub: 'ban', user: TARGET, reason: 'being rude' });
        assert.equal(w.replies.length, 1, 'answered once, in the channel, as a reply');
        assert.match(JSON.stringify(w.replies[0]), /Banned\./);
        assert.ok(!('flags' in w.replies[0]) || !(w.replies[0].flags & 64), 'never sent as ephemeral');
    } finally { store.close(); }
});

test('developer commands answer by DM, never in the channel', async () => {
    const w = world();
    w.message.content = ',gv help';
    const tree = [{ name: 'dev', type: 1, options: [{ type: 1, name: 'status', options: [] }] }];
    w.message.content = ',gv dev status';
    const i = await fromMessage(w.message, tree);
    await i.reply({ content: 'secret diagnostics' });
    assert.deepEqual(w.dms.map(d => d.content), ['secret diagnostics']);
    assert.match(w.replies[0].content, /Sent you the answer by DM/);
    assert.ok(!JSON.stringify(w.replies).includes('secret'));
});

test('a form can\'t open from a message, and replies are never deleted', async () => {
    const w = world();
    w.message.content = ',gv help';
    const i = await fromMessage(w.message, TREE);
    await assert.rejects(i.showModal(), /only works from a button/);
    await i.reply({ content: 'kept' });
    await i.deleteReply();
    assert.equal(w.replies.length, 1);
});

test('builders stay builders after the translation', async () => {
    const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
    const e = new EmbedBuilder().setDescription('Use `/raid mode off`');
    const row = new ActionRowBuilder<any>().addComponents(new ButtonBuilder().setCustomId('x:/raid').setLabel('/raid help').setStyle(ButtonStyle.Primary));
    const out: any = gvText({ embeds: [e], components: [row] });
    assert.ok(out.embeds[0] instanceof EmbedBuilder && out.components[0] instanceof ActionRowBuilder);
    assert.equal(out.embeds[0].toJSON().description, 'Use `,gv raid mode off`');
    assert.deepEqual([out.components[0].toJSON().components[0].label, out.components[0].toJSON().components[0].custom_id], [',gv raid help', 'x:/raid']);
});
