import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection, PermissionFlagsBits } from 'discord.js';
import { authorize } from './helpers.js';
import { Store } from '../src/database/db.js';
import { configureEventLog } from '../src/audit/event-log.js';
import { applyLogMerge, describeRouteSetup, LEGACY_LOG_ROUTES, logChannels, logTwins, pacing, planLogMerge, setLogChannels, setupLogChannels } from '../src/audit/log-setup.js';
import { deleteDuplicates, duplicatePlan } from '../src/audit/log-duplicates.js';
import { requiredRank, RANKS } from '../src/bot/ranks.js';

const G = '500000000000000001', BOT = '600000000000000001';
pacing.sleep = async () => { };

const OWN = 'Ghost Vanguard Logs', ARCHIVE = 'Archive - Veil Logs';
const ROUTE_NAMES: string[] = Object.values(LEGACY_LOG_ROUTES);

interface ChannelOptions {
    /** Vanguard can view and post in it. Default true. */
    usable?: boolean;
    /** @everyone can read it. Default false. */
    open?: boolean;
    /** Created by Vanguard: the audit log shows the bot creating it. */
    madeByVanguard?: boolean;
    /** Somebody has posted in it. */
    messages?: boolean;
    /** Not in the gateway cache; only a fresh fetch finds it. */
    hidden?: boolean;
}

/** A server that remembers every change made to it, with channels whose permissions can be set one by one. */
function world() {
    const channels = new Collection<string, any>();
    const hidden = new Collection<string, any>();
    const log: string[] = [];
    let next = 0;
    const bit = (b: bigint) => b;
    /** What the audit log says this bot created. `fails` makes it unreadable, as without View Audit Log. */
    const madeByBot = new Set<string>();
    const audit = { fails: false };
    const make = (name: string, type: number, parentId: string | null, o: ChannelOptions = {}) => {
        const id = `90${String(++next).padStart(16, '0')}`;
        if (o.madeByVanguard) madeByBot.add(id);
        const channel: any = {
            id, name, type, parentId, lastMessageId: o.messages ? '1' : null, isTextBased: () => type === ChannelType.GuildText,
            permissionsFor: (who: any) => ({ has: (b: bigint) => who === 'everyone' ? !!o.open && b === bit(PermissionFlagsBits.ViewChannel) : o.usable !== false }),
            send: async () => { log.push(`send ${name}`); },
            setParent: async (parent: string) => { log.push(`move ${name}`); channel.parentId = parent; return channel; },
            edit: async (change: any) => { log.push(`rename ${channel.name}`); Object.assign(channel, change); return channel; },
            delete: async () => { log.push(`delete ${name}`); channels.delete(id); },
            setPosition: async () => channel,
        };
        (o.hidden ? hidden : channels).set(id, channel);
        return channel;
    };
    const guild: any = {
        id: G, name: 'Test Server', client: { user: { id: BOT } },
        roles: { everyone: 'everyone', cache: new Collection() },
        members: { me: { permissions: { has: () => true } }, fetchMe: async () => guild.members.me },
        channels: {
            cache: channels,
            // With no id this is the full list, which also teaches the cache about channels the gateway never sent.
            fetch: async (id?: string) => {
                if (id) return channels.get(id) ?? null;
                for (const [key, channel] of hidden) channels.set(key, channel);
                hidden.clear();
                return channels;
            },
            create: async (opts: any) => {
                log.push(`create ${opts.name}`);
                return make(opts.name, opts.type, opts.parent ?? null, { madeByVanguard: true });
            },
        },
        fetchAuditLogs: async () => {
            if (audit.fails) throw new Error('Missing Permissions');
            return { entries: new Collection([...madeByBot].map(id => [id, { executorId: BOT, targetId: id }])) };
        },
    };
    return {
        guild, channels, log, audit,
        category: (name: string) => make(name, ChannelType.GuildCategory, null),
        text: (name: string, parentId: string | null = null, o: ChannelOptions = {}) => make(name, ChannelType.GuildText, parentId, o),
        named: (name: string, parentId?: string) => [...channels.values()].filter(c => c.type === ChannelType.GuildText && c.name === name && (parentId === undefined || c.parentId === parentId)),
    };
}

const fresh = () => { const store = new Store(':memory:'); authorize(store, G); return store; };
const setup = (store: Store, guild: any, options: { separate?: boolean } = {}) => store.withAuthorized(G, () => setupLogChannels(store, guild, 'admin', {}, options));

test('merging never moves an old Veil channel next to a channel of the same name that Vanguard already has', async () => {
    const store = fresh();
    try {
        const w = world();
        const own = w.category(OWN), archive = w.category(ARCHIVE);
        const bans = w.text('bans', own.id), logging = w.text('ghost-vanguard-logging', own.id);
        const ours = w.text('mod-logs', own.id, { madeByVanguard: true });
        const veilMod = w.text('mod-logs', archive.id, { usable: false });
        const veilJoin = w.text('join-logs', archive.id);
        setLogChannels(store, G, { bansChannelId: bans.id, routes: { moderation: ours.id } });
        store.save({ ...store.settings(G), logChannelId: logging.id });
        const plan = planLogMerge(store, w.guild);
        assert.deepEqual(plan.moves.map(m => m.channelId), [veilJoin.id], 'only the channel that has no twin is grouped');
        const left = plan.untouched.find(u => u.channelId === veilMod.id);
        assert.ok(left, 'the twin is listed, with the reason it stays');
        assert.match(left!.why, new RegExp(`<#${ours.id}>`));
        assert.match(left!.why, /second #mod-logs/);
        await applyLogMerge(store, w.guild, 'admin');
        assert.equal(veilMod.parentId, archive.id, 'it stays where it was');
        assert.equal(w.named('mod-logs', own.id).length, 1, 'one #mod-logs in the category');
        assert.equal(veilJoin.parentId, own.id, 'a channel without a twin is still grouped');
    } finally { store.close(); }
});

test('with no saved routes, setup uses the channel already in Vanguard\'s category before it adopts an old Veil one', async () => {
    const store = fresh();
    try {
        const w = world();
        const own = w.category(OWN), archive = w.category(ARCHIVE);
        const ours = w.text('mod-logs', own.id, { madeByVanguard: true });
        const veil = w.text('mod-logs', archive.id);
        const result = await setup(store, w.guild, { separate: false });
        assert.equal(result.routes.moderation, ours.id, 'its own channel is the route');
        assert.equal(veil.parentId, archive.id, 'the old Veil channel is not pulled in beside it');
        assert.equal(w.named('mod-logs', own.id).length, 1);
        assert.equal(logChannels(store, G).routes?.moderation, ours.id);
    } finally { store.close(); }
});

test('a same-named channel in the category that Vanguard cannot use does not get a twin with the same name', async () => {
    const store = fresh();
    try {
        const w = world();
        const own = w.category(OWN);
        const stuck = w.text('mod-logs', own.id, { usable: false });
        const result = await setup(store, w.guild);
        assert.equal(w.named('mod-logs', own.id).length, 1, 'still only one #mod-logs in the category');
        const made = w.guild.channels.cache.get(result.routes.moderation!);
        assert.notEqual(made.id, stuck.id);
        assert.equal(made.name, 'vanguard-mod-logs', 'the replacement is named so nobody mistakes it for the other one');
        assert.equal(made.parentId, own.id);
        assert.ok(result.created.includes('moderation'));
        const summary = describeRouteSetup(result).lines.join('\n');
        assert.match(summary, /Not reused \(a new private #vanguard-mod-logs was created instead\)/);
        // The next run finds its own channel again instead of making anything new.
        const before = w.guild.channels.cache.size;
        const again = await setup(store, w.guild);
        assert.equal(w.guild.channels.cache.size, before, 'nothing is created the second time');
        assert.equal(again.routes.moderation, made.id);
    } finally { store.close(); }
});

// ---- twins that are blocked, reported or already there

test('when the plain name and the vanguard- name are both taken and neither can be used, nothing is made and setup says so', async () => {
    const store = fresh();
    try {
        const w = world();
        const own = w.category(OWN);
        w.text('mod-logs', own.id, { usable: false });
        w.text('vanguard-mod-logs', own.id, { usable: false });
        const result = await setup(store, w.guild);
        assert.deepEqual(result.blocked, ['moderation']);
        assert.equal(result.routes.moderation, undefined);
        assert.equal(w.named('mod-logs', own.id).length, 1);
        assert.equal(w.named('vanguard-mod-logs', own.id).length, 1);
        assert.equal(result.created.includes('moderation'), false);
        const summary = describeRouteSetup(result);
        assert.equal(summary.attention, true);
        assert.match(summary.lines.join('\n'), /\*\*Not created:\*\* #mod-logs\. A channel with that name and one named #vanguard-… are both in the category already, and Vanguard cannot use either\./);
        assert.match(summary.lines.join('\n'), /Not activated:/, 'the reason the existing channel could not be used is listed too');
    } finally { store.close(); }
});

test('twins that already exist are reported, the one Vanguard logs to keeps being used, and nothing new is made for that type', async () => {
    const store = fresh();
    try {
        const w = world();
        const own = w.category(OWN);
        const first = w.text('mod-logs', own.id, { madeByVanguard: true });
        const second = w.text('mod-logs', own.id, { madeByVanguard: true });
        setLogChannels(store, G, { routes: { moderation: second.id } });
        const result = await setup(store, w.guild, { separate: false });
        assert.equal(result.routes.moderation, second.id, 'the saved destination wins, whichever twin comes first');
        assert.equal(w.named('mod-logs', own.id).length, 2, 'nothing is deleted or made');
        assert.deepEqual(result.twins, [{ name: 'mod-logs', used: [second.id], unused: [first.id] }]);
        const text = describeRouteSetup(result).lines.join('\n');
        assert.match(text, new RegExp(`Two channels named #mod-logs:\\*\\* Vanguard logs to <#${second.id}>; <#${first.id}> is not used\\.`));
        assert.match(text, /Vanguard never deletes a channel on its own\. `\/setup logs cleanup-duplicates`/);
        assert.deepEqual(logTwins(store, w.guild), result.twins);
        // Two channels that both have a job are not a duplicate.
        setLogChannels(store, G, { routes: { moderation: second.id, joins: first.id } });
        assert.deepEqual(logTwins(store, w.guild), []);
    } finally { store.close(); }
});

test('setup asks Discord for the whole channel list first, so a channel the cache never received is not made again', async () => {
    const store = fresh();
    try {
        const w = world();
        const own = w.category(OWN);
        const unseen = w.text('mod-logs', own.id, { madeByVanguard: true, hidden: true });
        assert.equal(w.guild.channels.cache.has(unseen.id), false, 'the gateway never sent it');
        const result = await setup(store, w.guild);
        assert.equal(result.routes.moderation, unseen.id, 'it is found and used');
        assert.equal(w.named('mod-logs').length, 1);
        assert.ok(!w.log.includes('create mod-logs'));
    } finally { store.close(); }
});

test('a channel with the same name outside the log category is not a twin and is never touched', async () => {
    const store = fresh();
    try {
        const w = world();
        const own = w.category(OWN), staff = w.category('Staff');
        const outside = w.text('mod-logs', staff.id, { madeByVanguard: true });
        const inside = w.text('mod-logs', own.id, { madeByVanguard: true });
        setLogChannels(store, G, { routes: { moderation: inside.id } });
        const result = await setup(store, w.guild, { separate: false });
        assert.deepEqual(result.twins, []);
        const plan = await store.withAuthorized(G, () => duplicatePlan(store, w.guild));
        assert.deepEqual([plan.remove, plan.keep], [[], []]);
        assert.equal(outside.parentId, staff.id);
    } finally { store.close(); }
});

// ---- cleaning up what is already there

const planOf = (store: Store, guild: any) => store.withAuthorized(G, () => duplicatePlan(store, guild));

test('cleanup lists an unused channel Vanguard made, next to a twin it uses, and says whether anything was posted in it', async () => {
    const store = fresh();
    try {
        const w = world();
        const own = w.category(OWN);
        const used = w.text('mod-logs', own.id, { madeByVanguard: true });
        const emptyTwin = w.text('mod-logs', own.id, { madeByVanguard: true });
        const busyTwin = w.text('join-logs', own.id, { madeByVanguard: true, messages: true });
        const usedJoin = w.text('join-logs', own.id, { madeByVanguard: true });
        const variant = w.text('vanguard-role-logs', own.id, { madeByVanguard: true });
        const variantTwin = w.text('vanguard-role-logs', own.id, { madeByVanguard: true });
        setLogChannels(store, G, { routes: { moderation: used.id, joins: usedJoin.id, roles: variant.id } });
        const plan = await planOf(store, w.guild);
        assert.deepEqual(plan.remove.map(r => [r.id, r.keeper, r.empty]).sort(), [
            [emptyTwin.id, used.id, true], [busyTwin.id, usedJoin.id, false], [variantTwin.id, variant.id, true],
        ].sort());
        assert.deepEqual(plan.keep, []);
        // Planning changes nothing.
        assert.equal(w.channels.size, 7);
        assert.ok(!w.log.some(l => l.startsWith('delete')));
    } finally { store.close(); }
});

test('cleanup never lists a channel it cannot show it made, and says why', async () => {
    const store = fresh();
    try {
        const w = world();
        const own = w.category(OWN);
        const used = w.text('mod-logs', own.id, { madeByVanguard: true });
        const veils = w.text('mod-logs', own.id);   // nothing in the audit log: another bot's, or staff's
        setLogChannels(store, G, { routes: { moderation: used.id } });
        const plan = await planOf(store, w.guild);
        assert.deepEqual(plan.remove, []);
        assert.deepEqual(plan.keep, [{ id: veils.id, name: 'mod-logs', why: 'Vanguard cannot show that it made this channel, so it may belong to another bot or to staff.' }]);
    } finally { store.close(); }
});

test('cleanup deletes nothing when Vanguard is not logging to any channel of that name, or cannot read the audit log', async () => {
    const store = fresh();
    try {
        const w = world();
        const own = w.category(OWN);
        const a = w.text('mod-logs', own.id, { madeByVanguard: true }), b = w.text('mod-logs', own.id, { madeByVanguard: true });
        const none = await planOf(store, w.guild);
        assert.deepEqual(none.remove, [], 'with no used channel there is no telling which to keep');
        assert.deepEqual(none.keep.map(k => k.id).sort(), [a.id, b.id].sort());
        assert.match(none.keep[0]!.why, /not logging to any channel with this name yet\. Run `\/setup logs setup`/);
        setLogChannels(store, G, { routes: { moderation: a.id } });
        w.audit.fails = true;
        const blind = await planOf(store, w.guild);
        assert.deepEqual(blind.remove, []);
        assert.equal(blind.keep[0]!.id, b.id);
        assert.match(blind.keep[0]!.why, /could not read the audit log to confirm it made this channel\. It needs View Audit Log\./);
    } finally { store.close(); }
});

test('cleanup deletes only what the confirmed plan lists, one pause apart, and checks each channel again first', async () => {
    const store = fresh();
    const sleeps: number[] = [];
    const originalSleep = pacing.sleep;
    pacing.sleep = async ms => { sleeps.push(ms); };
    try {
        const w = world();
        const own = w.category(OWN);
        const used = ROUTE_NAMES.slice(0, 4).map(name => w.text(name, own.id, { madeByVanguard: true }));
        const twins = ROUTE_NAMES.slice(0, 4).map(name => w.text(name, own.id, { madeByVanguard: true }));
        setLogChannels(store, G, { routes: { moderation: used[0]!.id, joins: used[1]!.id, members: used[2]!.id, roles: used[3]!.id } });
        const plan = await planOf(store, w.guild);
        assert.equal(plan.remove.length, 4);
        // Between the preview and the click: one twin becomes a destination, one loses its used sibling, one is no longer provably Vanguard's.
        setLogChannels(store, G, { routes: { moderation: used[0]!.id, joins: twins[1]!.id, members: used[2]!.id, roles: used[3]!.id } });
        w.channels.delete(used[2]!.id);
        // (Three of the four are now unsafe; only the roles twin is still deletable.)
        const text = await store.withAuthorized(G, () => deleteDuplicates(w.guild, store, plan, 'owner'));
        assert.match(text, /Duplicate cleanup: \*\*(\d+) deleted\*\*, \*\*(\d+) skipped\*\*, \*\*0 failed\*\*\. Deleted message history cannot be recovered\./);
        const deleted = w.log.filter(l => l.startsWith('delete'));
        assert.deepEqual(deleted.sort(), ['delete ' + twins[0]!.name, 'delete ' + twins[3]!.name].sort(), 'only the two that were still safe');
        assert.ok(w.channels.has(twins[1]!.id), 'a twin that became a destination is kept');
        assert.ok(w.channels.has(twins[2]!.id), 'a twin whose used sibling vanished is kept');
        assert.deepEqual(sleeps, [500], 'one pause between the two deletions, none before the first');
        assert.match(text, /\*\*2 deleted\*\*, \*\*2 skipped\*\*/);
    } finally { pacing.sleep = originalSleep; store.close(); }
});

test('a plan that is no longer provably Vanguard\'s is not carried out, and a confirmed cleanup survives a failing delete', async () => {
    const store = fresh();
    try {
        const w = world();
        const own = w.category(OWN);
        const used = w.text('mod-logs', own.id, { madeByVanguard: true });
        const twin = w.text('mod-logs', own.id, { madeByVanguard: true });
        const other = w.text('join-logs', own.id, { madeByVanguard: true }), otherUsed = w.text('join-logs', own.id, { madeByVanguard: true });
        setLogChannels(store, G, { routes: { moderation: used.id, joins: otherUsed.id } });
        const plan = await planOf(store, w.guild);
        assert.equal(plan.remove.length, 2);
        other.delete = async () => { throw new Error('Missing Permissions'); };
        const text = await store.withAuthorized(G, () => deleteDuplicates(w.guild, store, plan, 'owner'));
        assert.match(text, /\*\*1 deleted\*\*, \*\*0 skipped\*\*, \*\*1 failed\*\*/);
        assert.equal(w.channels.has(twin.id), false);
        // With the audit log unreadable at confirmation time, nothing is deleted at all.
        const w2 = world();
        const own2 = w2.category(OWN);
        const u = w2.text('mod-logs', own2.id, { madeByVanguard: true }), t = w2.text('mod-logs', own2.id, { madeByVanguard: true });
        setLogChannels(store, G, { routes: { moderation: u.id } });
        const plan2 = await planOf(store, w2.guild);
        w2.audit.fails = true;
        const blind = await store.withAuthorized(G, () => deleteDuplicates(w2.guild, store, plan2, 'owner'));
        assert.match(blind, /\*\*0 deleted\*\*, \*\*1 skipped\*\*/);
        assert.equal(w2.channels.has(t.id), true);
    } finally { store.close(); }
});

test('/setup logs cleanup-duplicates is owner-only, previews what it would delete, and says when there is nothing to do', async () => {
    const { default: command } = await import('../src/commands/configuration/logs.js');
    assert.equal(command.subcommands?.['cleanup-duplicates']?.access, 'owner');
    assert.equal(requiredRank('logs/cleanup-duplicates'), RANKS.owner);
    const store = fresh();
    try {
        const w = world();
        const own = w.category(OWN);
        const used = w.text('mod-logs', own.id, { madeByVanguard: true });
        const twin = w.text('mod-logs', own.id, { madeByVanguard: true, messages: true });
        const replies: any[] = [];
        const i: any = { guildId: G, guild: w.guild, user: { id: 'owner' }, options: { getSubcommand: () => 'cleanup-duplicates' }, editReply: async (reply: any) => { replies.push(reply); }, reply: async (reply: any) => { replies.push(reply); } };
        // With no destination saved for #mod-logs yet, Vanguard cannot tell which of the two to keep, so it deletes nothing.
        const none = String(await store.withAuthorized(G, () => command.execute({ store } as any, i)));
        assert.match(none, /^Nothing was deleted\. Vanguard cannot remove these channels, each of which shares its name with another log channel:/);
        assert.match(none, new RegExp(`<#${used.id}> \\(#mod-logs\\): Vanguard is not logging to any channel with this name yet`));
        assert.match(none, new RegExp(`<#${twin.id}> \\(#mod-logs\\)`));
        assert.equal(replies.length, 0, 'no confirmation was offered');
        setLogChannels(store, G, { routes: { moderation: used.id } });
        await store.withAuthorized(G, () => command.execute({ store } as any, i));
        const preview = JSON.stringify(replies.at(-1));
        assert.match(preview, /Delete duplicate log channels/);
        assert.match(preview, new RegExp(`<#${twin.id}> · has messages · Vanguard logs to <#${used.id}> instead`));
        assert.match(preview, /Only channels the audit log shows this bot created are included/);
        assert.equal(w.channels.has(twin.id), true, 'previewing deletes nothing');
        // A server with no twins gets a plain answer.
        const clean = world();
        const cleanOwn = clean.category(OWN);
        clean.text('mod-logs', cleanOwn.id, { madeByVanguard: true });
        const answer = await store.withAuthorized(G, () => command.execute({ store } as any, { ...i, guild: clean.guild }));
        assert.equal(answer, 'No duplicate log channels were found.');
    } finally { store.close(); }
});

test('/setup logs check lists twins without failing the check', async () => {
    const { default: command } = await import('../src/commands/configuration/logs.js');
    const store = fresh();
    try {
        const w = world();
        const own = w.category(OWN);
        const bans = w.text('bans', own.id, { madeByVanguard: true }), logging = w.text('ghost-vanguard-logging', own.id, { madeByVanguard: true });
        const used = w.text('mod-logs', own.id, { madeByVanguard: true }), twin = w.text('mod-logs', own.id, { madeByVanguard: true });
        setLogChannels(store, G, { bansChannelId: bans.id, routes: { moderation: used.id } });
        configureEventLog(store, G, { enabled: true, channelId: logging.id });
        const replies: any[] = [];
        const i: any = { guildId: G, guild: w.guild, user: { id: 'owner' }, options: { getSubcommand: () => 'check' }, editReply: async (reply: any) => { replies.push(reply); } };
        await store.withAuthorized(G, () => command.execute({ store } as any, i));
        const card = replies.at(-1).embeds[0].toJSON();
        assert.match(card.description, new RegExp(`Two channels named #mod-logs:\\*\\* Vanguard logs to <#${used.id}>; <#${twin.id}> is not used\\.`));
    } finally { store.close(); }
});

// ---- the rest of the rules, one at a time

test('when a plain name and its vanguard- twin are both usable and nothing is saved, the plain one is the route', async () => {
    const store = fresh();
    try {
        const w = world();
        const own = w.category(OWN);
        const prefixed = w.text('vanguard-mod-logs', own.id, { madeByVanguard: true });
        const plain = w.text('mod-logs', own.id, { madeByVanguard: true });
        const result = await setup(store, w.guild, { separate: false });
        assert.equal(result.routes.moderation, plain.id);
        assert.notEqual(result.routes.moderation, prefixed.id);
        // Both of them are reported as names that appear once each, not as twins of one another.
        assert.deepEqual(result.twins, []);
    } finally { store.close(); }
});

test('a destination somebody chose stays where it is, and the same name twice with the vanguard- prefix is reported too', async () => {
    const store = fresh();
    try {
        const w = world();
        const own = w.category(OWN), staff = w.category('Staff');
        const chosen = w.text('records', staff.id);
        setLogChannels(store, G, { routes: { messages: chosen.id } });
        const result = await setup(store, w.guild, { separate: false });
        assert.equal(result.routes.messages, chosen.id, 'a working chosen destination is kept');
        assert.equal(chosen.parentId, staff.id, 'and is not pulled into the log category');
        // Twins are found under the vanguard- name as well.
        const a = w.text('vanguard-role-logs', own.id, { madeByVanguard: true }), b = w.text('vanguard-role-logs', own.id, { madeByVanguard: true });
        setLogChannels(store, G, { routes: { messages: chosen.id, roles: a.id } });
        assert.deepEqual(logTwins(store, w.guild), [{ name: 'vanguard-role-logs', used: [a.id], unused: [b.id] }]);
    } finally { store.close(); }
});

test('only channels the audit log shows this bot creating count as Vanguard\'s, not channels another account created', async () => {
    const store = fresh();
    try {
        const w = world();
        const own = w.category(OWN);
        const used = w.text('mod-logs', own.id, { madeByVanguard: true });
        const byAnother = w.text('mod-logs', own.id);
        setLogChannels(store, G, { routes: { moderation: used.id } });
        // The audit log lists the channel, but it was created by somebody else.
        const real = w.guild.fetchAuditLogs;
        w.guild.fetchAuditLogs = async () => {
            const logs = await real();
            logs.entries.set(byAnother.id, { executorId: '700000000000000009', targetId: byAnother.id });
            return logs;
        };
        const plan = await planOf(store, w.guild);
        assert.deepEqual(plan.remove, []);
        assert.equal(plan.keep[0]?.id, byAnother.id);
    } finally { store.close(); }
});

test('a channel that stopped being provably Vanguard\'s or left the log category before the click is skipped', async () => {
    const store = fresh();
    try {
        const w = world();
        const own = w.category(OWN), elsewhere = w.category('Staff');
        const used = [w.text('mod-logs', own.id, { madeByVanguard: true }), w.text('join-logs', own.id, { madeByVanguard: true })];
        const twinGone = w.text('mod-logs', own.id, { madeByVanguard: true });
        const twinMoved = w.text('join-logs', own.id, { madeByVanguard: true });
        setLogChannels(store, G, { routes: { moderation: used[0]!.id, joins: used[1]!.id } });
        const plan = await planOf(store, w.guild);
        assert.equal(plan.remove.length, 2);
        // Before the click: the audit log no longer shows the first (or somebody else made it), and the second was moved elsewhere.
        const real = w.guild.fetchAuditLogs;
        w.guild.fetchAuditLogs = async () => { const logs = await real(); logs.entries.delete(twinGone.id); return logs; };
        twinMoved.parentId = elsewhere.id;
        const text = await store.withAuthorized(G, () => deleteDuplicates(w.guild, store, plan, 'owner'));
        assert.match(text, /\*\*0 deleted\*\*, \*\*2 skipped\*\*, \*\*0 failed\*\*/);
        assert.equal(w.channels.has(twinGone.id) && w.channels.has(twinMoved.id), true);
    } finally { store.close(); }
});

test('a server removed in the middle of a cleanup gets no further deletion', async () => {
    const store = fresh();
    const originalSleep = pacing.sleep;
    try {
        const w = world();
        const own = w.category(OWN);
        const used = [w.text('mod-logs', own.id, { madeByVanguard: true }), w.text('join-logs', own.id, { madeByVanguard: true })];
        const twins = [w.text('mod-logs', own.id, { madeByVanguard: true }), w.text('join-logs', own.id, { madeByVanguard: true })];
        setLogChannels(store, G, { routes: { moderation: used[0]!.id, joins: used[1]!.id } });
        const plan = await planOf(store, w.guild);
        pacing.sleep = async () => { store.run("UPDATE guild_authorization SET state='DEAUTHORIZED',generation=generation+1 WHERE guild_id=?", G); };
        await assert.rejects(store.withAuthorized(G, () => deleteDuplicates(w.guild, store, plan, 'owner')), /requires developer authorization/);
        assert.equal(w.log.filter(l => l.startsWith('delete')).length, 1, 'only the first deletion happened');
    } finally { pacing.sleep = originalSleep; store.close(); }
});

// ---- gaps found by breaking the code on purpose

test('an unusable channel in Vanguard\'s category is not replaced by pulling in a usable one from the old Veil category', async () => {
    const store = fresh();
    try {
        const w = world();
        const own = w.category(OWN), archive = w.category(ARCHIVE);
        const stuck = w.text('mod-logs', own.id, { usable: false });
        const veil = w.text('mod-logs', archive.id);
        const result = await setup(store, w.guild, { separate: false });
        assert.equal(veil.parentId, archive.id, 'moving it in would put two #mod-logs side by side');
        assert.equal(w.named('mod-logs', own.id).length, 1);
        const full = await setup(store, w.guild);
        assert.equal(w.guild.channels.cache.get(full.routes.moderation!).name, 'vanguard-mod-logs');
        assert.notEqual(full.routes.moderation, stuck.id);
        assert.equal(result.routes.moderation, undefined, 'with per-type channels off nothing was made either');
    } finally { store.close(); }
});

test('a vanguard- channel in the category is found again by its name when nothing is saved', async () => {
    const store = fresh();
    try {
        const w = world();
        const own = w.category(OWN);
        const prefixed = w.text('vanguard-mod-logs', own.id, { madeByVanguard: true });
        const result = await setup(store, w.guild);
        assert.equal(result.routes.moderation, prefixed.id);
        assert.equal(result.created.includes('moderation'), false, 'it is reused, not made again');
        assert.equal(w.named('mod-logs').length, 0);
        assert.ok(!w.log.includes('create mod-logs') && !w.log.includes('create vanguard-mod-logs'));
    } finally { store.close(); }
});

test('a lone channel with a log name is not a twin, and cleanup has nothing to say about it', async () => {
    const store = fresh();
    try {
        const w = world();
        const own = w.category(OWN);
        w.text('mod-logs', own.id, { madeByVanguard: true });
        assert.deepEqual(logTwins(store, w.guild), []);
        const plan = await planOf(store, w.guild);
        assert.deepEqual([plan.remove, plan.keep], [[], []]);
    } finally { store.close(); }
});

test('a twin that became a destination too, next to a used one, is kept at confirmation', async () => {
    const store = fresh();
    try {
        const w = world();
        const own = w.category(OWN);
        const used = w.text('mod-logs', own.id, { madeByVanguard: true });
        const twin = w.text('mod-logs', own.id, { madeByVanguard: true });
        setLogChannels(store, G, { routes: { moderation: used.id } });
        const plan = await planOf(store, w.guild);
        assert.deepEqual(plan.remove.map(r => r.id), [twin.id]);
        // Before the click an admin points another log type at the twin: both channels now have a job.
        setLogChannels(store, G, { routes: { moderation: used.id, members: twin.id } });
        const text = await store.withAuthorized(G, () => deleteDuplicates(w.guild, store, plan, 'owner'));
        assert.match(text, /\*\*0 deleted\*\*, \*\*1 skipped\*\*/);
        assert.equal(w.channels.has(twin.id), true);
    } finally { store.close(); }
});

test('confirming a cleanup asks Discord for the channel list again, so a used twin the cache never received still counts', async () => {
    const store = fresh();
    try {
        const w = world();
        const own = w.category(OWN);
        const used = w.text('mod-logs', own.id, { madeByVanguard: true, hidden: true });
        const twin = w.text('mod-logs', own.id, { madeByVanguard: true });
        setLogChannels(store, G, { routes: { moderation: used.id } });
        const plan = { remove: [{ id: twin.id, name: 'mod-logs', keeper: used.id, empty: true }], keep: [] };
        const text = await store.withAuthorized(G, () => deleteDuplicates(w.guild, store, plan, 'owner'));
        assert.match(text, /\*\*1 deleted\*\*, \*\*0 skipped\*\*/);
        assert.equal(w.channels.has(twin.id), false);
    } finally { store.close(); }
});

test('a long list of duplicates is previewed up to fifteen channels and the rest are counted', async () => {
    const { default: command } = await import('../src/commands/configuration/logs.js');
    const store = fresh();
    try {
        const w = world();
        const own = w.category(OWN);
        const names = [...ROUTE_NAMES, ...ROUTE_NAMES.map(n => `vanguard-${n}`)].slice(0, 16);
        const used = names.map(name => w.text(name, own.id, { madeByVanguard: true }));
        names.forEach(name => w.text(name, own.id, { madeByVanguard: true }));
        // Sixteen names, each with a channel Vanguard logs to and an unused twin it made.
        setLogChannels(store, G, { routes: Object.fromEntries(used.map((c, n) => [`destination${n}`, c.id])) as any });
        const replies: any[] = [];
        const i: any = { guildId: G, guild: w.guild, user: { id: 'owner' }, options: { getSubcommand: () => 'cleanup-duplicates' }, editReply: async (r: any) => { replies.push(r); }, reply: async (r: any) => { replies.push(r); } };
        await store.withAuthorized(G, () => command.execute({ store } as any, i));
        const preview = JSON.stringify(replies.at(-1));
        assert.match(preview, /Delete 16 log channels that Vanguard made and is not using\./);
        assert.equal(preview.match(/Vanguard logs to <#/g)?.length, 15, 'fifteen are listed');
        assert.match(preview, /Plus 1 more\./);
    } finally { store.close(); }
});

test('twins are only reported among the per-type log channels; a doubled #bans is left to merge', async () => {
    const store = fresh();
    try {
        const w = world();
        const own = w.category(OWN);
        const bans = w.text('bans', own.id, { madeByVanguard: true });
        w.text('bans', own.id, { madeByVanguard: true });
        const logging = w.text('ghost-vanguard-logging', own.id, { madeByVanguard: true });
        w.text('midtown-vanguard-logging', own.id, { madeByVanguard: true });
        setLogChannels(store, G, { bansChannelId: bans.id });
        configureEventLog(store, G, { enabled: true, channelId: logging.id });
        assert.deepEqual(logTwins(store, w.guild), [], 'setup and check say nothing about them');
        const plan = await planOf(store, w.guild);
        assert.deepEqual([plan.remove, plan.keep], [[], []], 'and cleanup does not touch them');
        // Merge still names the second #bans, so a person hears about it.
        const merge = planLogMerge(store, w.guild);
        assert.ok(merge.untouched.some(u => u.name === 'bans' && /another bans channel next to/.test(u.why)));
    } finally { store.close(); }
});
