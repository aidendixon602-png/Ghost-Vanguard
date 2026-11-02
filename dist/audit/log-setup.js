import { ChannelType, Colors, EmbedBuilder, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { DEFAULT_CATEGORIES, DEFAULT_CHANNELS, LEGACY_CATEGORIES, LEGACY_CHANNELS } from '../branding.js';
import { getFeature, setFeature } from '../features/settings.js';
import { configureEventLog, eventLogConfig } from './event-log.js';
/**
 * Where Vanguard's logs go in each server:
 *   #bans                      one record per ban, with server-owner / Developer Unban and Reban buttons
 *   one channel per log type   moderation, joins, members, roles, channels, server, messages, voice, commands, anti-nuke
 *   #ghost-vanguard-logging    bot actions, and any event type that has no channel of its own
 * Setup creates what is missing, inside Ghost Vanguard Logs. Settings are saved per server; existing
 * channels are reused, never duplicated.
 */
export const BANS_CHANNEL = DEFAULT_CHANNELS.bans;
export const LOGGING_CHANNEL = DEFAULT_CHANNELS.logging;
export const SECURITY_CHANNEL = DEFAULT_CHANNELS.security;
export const LOG_CATEGORY = DEFAULT_CATEGORIES.logs;
export const ARCHIVED_LOG_CATEGORY = LEGACY_CATEGORIES.archivedLogs;
/**
 * Names used by older releases. A server that already has one keeps using it instead of getting a
 * second log channel; the name is only reported, Vanguard never renames a server's channels by itself.
 */
export const LEGACY_LOGGING_CHANNELS = [...LEGACY_CHANNELS.logging];
export const LOGGING_CHANNEL_NAMES = [LOGGING_CHANNEL, ...LEGACY_LOGGING_CHANNELS];
/**
 * Every log type and the name of its channel. Setup creates a missing channel under this name (the
 * order here is the order they appear in the category), and reuses one that already has it inside
 * Ghost Vanguard Logs or the archived Veil category.
 */
export const LEGACY_LOG_ROUTES = {
    moderation: 'mod-logs', joins: 'join-logs', members: 'member-logs', roles: 'role-logs',
    channels: 'channel-logs', server: 'server-logs', messages: 'message-logs', voice: 'voice-logs',
    commands: 'command-logs', antinuke: 'antinuke-logs',
};
/**
 * Every name Vanguard has ever given one of its own log channels. A matching name alone never makes a
 * channel Vanguard's: another bot (or staff) can run a `join-logs`, `bans` or `vanguard-security` of its
 * own, so a channel outside Vanguard's log area is only ever reported, never moved, renamed or reused.
 */
export const RECOGNIZED_LOG_NAMES = new Set([
    BANS_CHANNEL, SECURITY_CHANNEL, ...LOGGING_CHANNEL_NAMES, ...Object.values(LEGACY_LOG_ROUTES),
]);
const DEFAULTS = { bansChannelId: null, excludedChannels: [], ignoreBotRoutine: true };
export const logChannels = (store, guild) => getFeature(store, guild, 'log_channels', DEFAULTS);
export const setLogChannels = (store, guild, change, by) => setFeature(store, guild, 'log_channels', DEFAULTS, change, by);
export const isExcluded = (store, guild, channelId) => !!channelId && logChannels(store, guild).excludedChannels.includes(channelId);
export const logRoute = (store, guild, route) => logChannels(store, guild).routes?.[route] ?? null;
/** Channel permissions Vanguard needs in each log channel. */
export const CHANNEL_PERMISSIONS = [
    [PermissionFlagsBits.ViewChannel, 'View Channel'], [PermissionFlagsBits.SendMessages, 'Send Messages'],
    [PermissionFlagsBits.EmbedLinks, 'Embed Links'], [PermissionFlagsBits.ReadMessageHistory, 'Read Message History'],
];
/** Server permissions needed to verify who did something, and for the ban buttons. */
export const SERVER_PERMISSIONS = [
    [PermissionFlagsBits.ViewAuditLog, 'View Audit Log', 'needed to verify who banned, kicked or changed something'],
    [PermissionFlagsBits.BanMembers, 'Ban Members', 'needed for the Unban and Reban buttons'],
];
/** Staff ranks that can read the log channels Vanguard creates (Administrators always can). */
const READER_LEVELS = ['moderator', 'admin', 'headadmin'];
function privateOverwrites(store, guild) {
    const staff = store.all('SELECT role_id, level FROM staff_roles WHERE guild_id=?', guild.id)
        .filter(r => READER_LEVELS.includes(String(r.level)) && guild.roles.cache.has(String(r.role_id)));
    return [
        { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
        { id: guild.client.user.id, type: OverwriteType.Member, allow: CHANNEL_PERMISSIONS.map(([bit]) => bit) },
        ...staff.map(r => ({ id: String(r.role_id), type: OverwriteType.Role, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] })),
    ];
}
/**
 * Setup and merge change a lot of channels in a row, and Discord rate limits how fast a server can be
 * written to. A run waits `pauseMs` between its changes: not before the first one, and not at all when
 * there is nothing to change. `sleep` can be replaced so tests do not have to sit through the pauses.
 */
export const pacing = {
    pauseMs: 500,
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
};
/**
 * One per setup or merge run. `beforeChange` goes in front of every change the run makes to the server.
 * It waits out the pause after the previous change, then checks that the server is still authorized, so
 * a server removed during the wait (`/dev server deauthorize`) gets no further change.
 */
class Pacer {
    stillAuthorized;
    started = false;
    constructor(stillAuthorized) {
        this.stillAuthorized = stillAuthorized;
    }
    async beforeChange() {
        if (this.started)
            await pacing.sleep(pacing.pauseMs);
        this.started = true;
        this.stillAuthorized();
    }
}
/**
 * Use the chosen channel, the saved one, one with an expected name (the current name or a legacy
 * one), or create a private one. A legacy name is reused as it is: Vanguard never renames channels.
 */
async function resolveChannel(store, guild, names, chosen, saved, reason, pace) {
    const wanted = Array.isArray(names) ? names : [names];
    const text = (c) => c && c.type === ChannelType.GuildText ? c : null;
    if (chosen) {
        const c = text(chosen);
        if (!c)
            throw new Error(`<#${chosen.id}> is not a text channel.`);
        return { channel: c, created: false, how: 'chosen' };
    }
    const savedChannel = text(saved ? guild.channels.cache.get(saved) ?? await guild.channels.fetch(saved).catch(() => null) : null);
    if (savedChannel)
        return { channel: savedChannel, created: false, how: 'already set up' };
    // Prefer Vanguard's own log area, then an uncategorized channel, before any look-alike elsewhere:
    // another bot's #join-logs or #bans must not be adopted just because the name matches.
    const named = text([...guild.channels.cache.values()]
        .filter(c => c.type === ChannelType.GuildText && wanted.includes(c.name))
        .sort((a, b) => Number(inLogArea(guild, b.parentId)) - Number(inLogArea(guild, a.parentId))
        || Number(!!a.parentId) - Number(!!b.parentId))[0]);
    if (named)
        return { channel: named, created: false, how: named.name === wanted[0] ? 'existing channel reused' : `existing channel reused (still named #${named.name})` };
    await pace.beforeChange();
    const created = await guild.channels.create({ name: wanted[0], type: ChannelType.GuildText, permissionOverwrites: privateOverwrites(store, guild), reason });
    return { channel: created, created: true, how: 'created (private: staff only)' };
}
const normalizedCategoryName = (name) => name.trim().toLowerCase().replace(/[_-]+/g, ' ');
/** Find or create the category for active Ghost Vanguard logs. */
async function resolveLogCategory(store, guild, reason, pace) {
    const category = findLogCategory(guild);
    if (category)
        return { category, created: false };
    await pace.beforeChange();
    const created = await guild.channels.create({ name: LOG_CATEGORY, type: ChannelType.GuildCategory, permissionOverwrites: privateOverwrites(store, guild), reason });
    return { category: created, created: true };
}
/** Move only the two active log channels. Keep their channel overrides and every old log message intact. */
async function placeInLogCategory(channels, category, reason, pace) {
    for (const { channel } of channels) {
        if (channel.parentId === category.id)
            continue;
        await pace.beforeChange();
        await channel.setParent(category.id, { lockPermissions: false, reason });
    }
}
/** Rename the old Veil category so it is clearly archived; never delete its channels or messages. */
async function archiveLegacyLogCategories(guild, reason, pace) {
    const legacyNames = new Set(LEGACY_CATEGORIES.logs.map(normalizedCategoryName));
    const archived = [];
    for (const channel of guild.channels.cache.values()) {
        if (channel.type !== ChannelType.GuildCategory || !legacyNames.has(normalizedCategoryName(channel.name)))
            continue;
        await pace.beforeChange();
        await channel.edit({ name: ARCHIVED_LOG_CATEGORY, reason });
        archived.push(channel.id);
    }
    return archived;
}
/** Reuse recognized channels from Veil's old category; preserve their overrides and history. */
async function activateLegacyRoutes(store, guild, category, reason, pace) {
    const names = new Set([...LEGACY_CATEGORIES.logs, ARCHIVED_LOG_CATEGORY].map(normalizedCategoryName));
    const legacyIds = new Set([...guild.channels.cache.values()].filter(c => c.type === ChannelType.GuildCategory && names.has(normalizedCategoryName(c.name))).map(c => c.id));
    const routes = { ...logChannels(store, guild.id).routes };
    const skipped = [];
    for (const [route, name] of Object.entries(LEGACY_LOG_ROUTES)) {
        store.assertAuthorized(guild.id);
        const matches = (c) => c.type === ChannelType.GuildText && c.name === name;
        // Also find a channel already moved by a setup that failed before saving its routes.
        const existing = guild.channels.cache.find(c => matches(c) && !!c.parentId && legacyIds.has(c.parentId))
            ?? guild.channels.cache.find(c => matches(c) && c.parentId === category.id);
        const saved = routes[route];
        // A renamed or moved channel can still be the saved destination; check it even if another
        // legacy channel is found, so an unsafe saved destination cannot survive a failed reuse.
        if (saved && saved !== existing?.id) {
            const check = await checkChannel(guild, saved, name, false);
            if (!check.ok || check.publiclyVisible) {
                delete routes[route];
                skipped.push({ route, check });
            }
            else
                continue; // Keep a manually chosen private destination.
        }
        if (!existing)
            continue;
        const check = await checkChannel(guild, existing.id, name, false);
        if (!check.ok || check.publiclyVisible) {
            if (routes[route] === existing.id)
                delete routes[route];
            skipped.push({ route, check });
            continue;
        }
        store.assertAuthorized(guild.id);
        if (existing.parentId !== category.id) {
            await pace.beforeChange();
            await existing.setParent(category.id, { lockPermissions: false, reason });
        }
        routes[route] = existing.id;
    }
    return { routes, skipped };
}
/**
 * Give every log type that has no destination its own private channel in the log category. It stops
 * at the first failure, because the same missing permission or full category would stop the rest too.
 * Channels already made are kept (they sit in the category, so running setup again finds them by
 * name instead of making a second set).
 */
async function createMissingRoutes(store, guild, category, routes, reason, pace) {
    const created = [];
    let failed = null;
    for (const [route, name] of Object.entries(LEGACY_LOG_ROUTES)) {
        if (routes[route])
            continue;
        // Outside the try: a server that lost its authorization stops the whole run, it is not a refused channel.
        await pace.beforeChange();
        try {
            const channel = await guild.channels.create({ name, type: ChannelType.GuildText, parent: category.id, permissionOverwrites: privateOverwrites(store, guild), reason });
            routes[route] = channel.id;
            created.push(route);
        }
        catch (error) {
            failed = { route, error: error instanceof Error ? error.message : String(error) };
            break;
        }
    }
    return { created, failed };
}
/** Check one channel: Vanguard's permissions, whether everyone can read it, and send a test embed. */
export async function checkChannel(guild, channelId, label, sendTest = true) {
    const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
    const me = guild.members.me ?? await guild.members.fetchMe();
    if (!channel || !channel.isTextBased())
        return { channelId, ok: false, missing: ['the channel no longer exists'], publiclyVisible: false, test: 'skipped' };
    const perms = channel.permissionsFor(me);
    const missing = CHANNEL_PERMISSIONS.filter(([bit]) => !perms?.has(bit)).map(([, name]) => name);
    const publiclyVisible = !!channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel);
    let test = 'skipped', error;
    if (sendTest && !missing.length) {
        try {
            await channel.send({ embeds: [new EmbedBuilder().setColor(Colors.Green).setTitle('✅ Log channel test')
                        .setDescription(`Ghost Vanguard can post **${label}** here.`).setFooter({ text: `Channel ID: ${channel.id}` }).setTimestamp()], allowedMentions: { parse: [] } });
            test = 'sent';
        }
        catch (e) {
            test = 'failed';
            error = e instanceof Error ? e.message : String(e);
        }
    }
    return { channelId, ok: !missing.length && test !== 'failed', missing, publiclyVisible, test, error };
}
export function serverPermissionGaps(guild) {
    const me = guild.members.me;
    return SERVER_PERMISSIONS.filter(([bit]) => !me?.permissions.has(bit)).map(([, name, why]) => `${name} (${why})`);
}
export function describeCheck(label, check) {
    const lines = [`**${label}:** <#${check.channelId}> ${check.ok ? '✅' : '❌'}`];
    if (check.missing.length)
        lines.push(`  Missing: ${check.missing.join(', ')}`);
    if (check.test === 'sent')
        lines.push('  Test embed sent.');
    if (check.test === 'failed')
        lines.push(`  Test embed failed: ${check.error}`);
    if (check.publiclyVisible)
        lines.push('  ⚠️ Everyone can read this channel. Logs should be staff only: deny View Channel for @everyone.');
    return lines.join('\n');
}
const setupRuns = new Map();
/**
 * One setup per server at a time. Setup can create a dozen channels, so a second run started in the
 * meantime (a double submit, or two admins) would otherwise create the same missing channels again.
 */
function oneAtATime(guildId, work) {
    const run = (setupRuns.get(guildId) ?? Promise.resolve()).catch(() => undefined).then(work);
    setupRuns.set(guildId, run);
    const clear = () => { if (setupRuns.get(guildId) === run)
        setupRuns.delete(guildId); };
    run.then(clear, clear);
    return run;
}
/**
 * Set up (or repair) the log channels and save them: bans, the combined server log and, unless
 * `separate` is false, one channel for every log type that does not have one yet.
 */
export function setupLogChannels(store, guild, by, chosen = {}, options = {}) {
    return oneAtATime(guild.id, () => runLogSetup(store, guild, by, chosen, options));
}
async function runLogSetup(store, guild, by, chosen, options) {
    const reason = `Ghost Vanguard log setup by ${by}`;
    const pace = new Pacer(() => store.assertAuthorized(guild.id));
    const current = logChannels(store, guild.id);
    const bans = await resolveChannel(store, guild, BANS_CHANNEL, chosen.bans ?? null, current.bansChannelId, reason, pace);
    const logging = await resolveChannel(store, guild, LOGGING_CHANNEL_NAMES, chosen.logging ?? null, eventLogConfig(store, guild.id).channelId, reason, pace);
    if (bans.channel.id === logging.channel.id)
        throw new Error('Ban logs and server logs need two different channels.');
    const category = await resolveLogCategory(store, guild, reason, pace);
    await pace.beforeChange();
    await category.category.setPosition(0, { reason });
    await placeInLogCategory([bans, logging], category.category, reason, pace);
    const { routes, skipped } = await activateLegacyRoutes(store, guild, category.category, reason, pace);
    const { created, failed } = options.separate !== false ? await createMissingRoutes(store, guild, category.category, routes, reason, pace) : { created: [], failed: null };
    const archivedCategories = await archiveLegacyLogCategories(guild, reason, pace);
    setLogChannels(store, guild.id, { bansChannelId: bans.channel.id, routes }, by);
    configureEventLog(store, guild.id, { enabled: true, channelId: logging.channel.id });
    // Bot actions (anti-nuke, backups, restores, configuration changes, errors) go to the logging channel too.
    const settings = store.settings(guild.id);
    const previousAlerts = settings.logChannelId;
    if (previousAlerts !== logging.channel.id) {
        settings.logChannelId = logging.channel.id;
        store.save(settings, by);
    }
    return { bans, logging, category: category.category, categoryCreated: category.created, archivedCategories, routes, skipped, created, failed, previousAlerts: previousAlerts !== logging.channel.id ? previousAlerts : null };
}
/** Log types that still post to the combined log (or, for voice and commands, nowhere) for lack of a channel. */
export function routesWithoutChannel(store, guild) {
    const saved = logChannels(store, guild).routes ?? {};
    return Object.keys(LEGACY_LOG_ROUTES).filter(route => !saved[route]);
}
/** What setup did for each log type, for the reply to /setup logs setup and the welcome panel button. */
export function describeRouteSetup(result) {
    const lines = [];
    const known = Object.keys(result.routes).filter(route => Object.hasOwn(LEGACY_LOG_ROUTES, route));
    const mention = (route) => `<#${result.routes[route]}>`;
    const reused = known.filter(route => !result.created.includes(route));
    if (result.created.length)
        lines.push(`**Created, one per log type:** ${result.created.map(mention).join(' ')} · private, staff only`);
    if (reused.length)
        lines.push(`**Existing log channels reused:** ${reused.map(mention).join(' ')} · their permissions and message history were preserved.`);
    let attention = !!result.failed;
    for (const { route, check } of result.skipped) {
        const replaced = result.created.includes(route);
        attention ||= !replaced;
        lines.push(`**${replaced ? `Not reused (a new private #${LEGACY_LOG_ROUTES[route]} was created instead)` : 'Not activated'}:** ${describeCheck(`#${LEGACY_LOG_ROUTES[route]}`, check)}`);
    }
    if (result.failed) {
        const left = Object.keys(LEGACY_LOG_ROUTES).filter(route => !result.routes[route]);
        lines.push(`**Could not create #${LEGACY_LOG_ROUTES[result.failed.route]}:** ${result.failed.error}`, `**Still without a channel:** ${left.join(', ')}. Check that Vanguard has Manage Channels and that the category has room, then run \`/setup logs setup\` again. The channels made so far are kept.`);
    }
    return { lines, attention };
}
// ------------------------------------------------------------ merging scattered log channels
/**
 * Where Vanguard's log channels are allowed to be taken from: its own category and the old Veil ones it
 * inherited. A channel outside this area is never claimed on a name match alone — another bot's
 * `join-logs`, `modlogs` or `veil-utilities-logging` must keep working exactly as it does now.
 */
function findLogCategory(guild) {
    return [...guild.channels.cache.values()].find((c) => c.type === ChannelType.GuildCategory && normalizedCategoryName(c.name) === normalizedCategoryName(LOG_CATEGORY)) ?? null;
}
function logAreaCategoryNames() {
    return new Set([LOG_CATEGORY, ...LEGACY_CATEGORIES.logs, ARCHIVED_LOG_CATEGORY].map(normalizedCategoryName));
}
function inLogArea(guild, parentId) {
    if (!parentId)
        return false;
    const parent = guild.channels.cache.get(parentId);
    return !!parent && parent.type === ChannelType.GuildCategory && logAreaCategoryNames().has(normalizedCategoryName(parent.name));
}
/**
 * Work out what a merge would change, without changing anything.
 *
 * Vanguard's own channels are the ones it is configured to post in (ban logs, server logs, the security
 * log, saved route channels) plus the recognized Veil log channels inside an old log category. Everything
 * else — including look-alike names another bot may be using — is listed and left exactly as it is.
 */
export function planLogMerge(store, guild) {
    const settings = store.settings(guild.id);
    const saved = logChannels(store, guild.id);
    const events = eventLogConfig(store, guild.id);
    const configured = new Map();
    const claim = (id, why) => { if (id && !configured.has(id))
        configured.set(id, why); };
    claim(saved.bansChannelId, 'ban logs');
    claim(events.channelId, 'server logs');
    // The security log may be a separate channel chosen with /setup security.
    claim(settings.logChannelId, 'security log');
    for (const [route, id] of Object.entries(saved.routes ?? {}))
        claim(id, `${route} logs`);
    const category = findLogCategory(guild);
    const moves = [], renames = [];
    const untouched = new Map();
    const describeParent = (parentId) => (parentId ? guild.channels.cache.get(parentId)?.name ?? 'another category' : null);
    for (const channel of guild.channels.cache.values()) {
        if (channel.type !== ChannelType.GuildText)
            continue;
        const why = configured.get(channel.id);
        const inherited = !why && inLogArea(guild, channel.parentId) && RECOGNIZED_LOG_NAMES.has(channel.name);
        if (!why && !inherited) {
            if (RECOGNIZED_LOG_NAMES.has(channel.name)) {
                const parent = describeParent(channel.parentId);
                untouched.set(channel.id, { channelId: channel.id, name: channel.name,
                    why: parent ? `stays in **${parent}**, outside Vanguard's log area, so it may belong to another bot`
                        : 'has no category, so Vanguard cannot tell who owns it' });
            }
            continue;
        }
        if (category?.id && channel.parentId === category.id)
            continue; // already grouped
        moves.push({ channelId: channel.id, name: channel.name, from: describeParent(channel.parentId),
            why: why ?? 'old Veil log channel' });
    }
    // A second channel for the same log type (two #vanguard-security channels, or #midtown-vanguard-logging
    // next to #ghost-vanguard-logging) is never deleted or moved by Vanguard: it is reported so a human can
    // archive it. This is what earlier releases left behind.
    const roleOf = (name) => (LOGGING_CHANNEL_NAMES.includes(name) ? 'server logs' : name);
    const byRole = new Map();
    for (const channel of guild.channels.cache.values()) {
        if (channel.type !== ChannelType.GuildText || !RECOGNIZED_LOG_NAMES.has(channel.name))
            continue;
        if (moves.some(m => m.channelId === channel.id))
            continue; // being grouped, not a leftover
        byRole.set(roleOf(channel.name), [...(byRole.get(roleOf(channel.name)) ?? []), { id: channel.id, name: channel.name }]);
    }
    for (const [role, found] of byRole) {
        if (found.length < 2)
            continue;
        const keeper = found.find(c => configured.has(c.id)) ?? found.find(c => inLogArea(guild, guild.channels.cache.get(c.id)?.parentId ?? null)) ?? found[0];
        for (const extra of found) {
            if (extra.id === keeper.id)
                continue;
            // A same-named channel in another category (staff, or another bot's logs) keeps its own
            // explanation above: it is not a leftover of Vanguard's, so nobody is told to remove it.
            const parentId = guild.channels.cache.get(extra.id)?.parentId ?? null;
            if (parentId && !inLogArea(guild, parentId))
                continue;
            untouched.set(extra.id, { channelId: extra.id, name: extra.name,
                why: `another ${role} channel next to <#${keeper.id}>; Vanguard never deletes a channel, so archive or remove it yourself` });
        }
    }
    const logging = events.channelId ? guild.channels.cache.get(events.channelId) : null;
    if (logging?.type === ChannelType.GuildText && LEGACY_LOGGING_CHANNELS.includes(logging.name))
        renames.push({ channelId: logging.id, from: logging.name, to: LOGGING_CHANNEL });
    return { categoryId: category?.id ?? null, moves, renames, untouched: [...untouched.values()] };
}
/**
 * Apply the confirmed merge: group Vanguard's log channels under Ghost Vanguard Logs and, for the
 * logging channel only, replace an old default name with the current one. No channel is deleted, no
 * permission override is copied (`lockPermissions: false`) and no message history moves.
 */
export async function applyLogMerge(store, guild, by) {
    store.assertAuthorized(guild.id);
    const reason = `Ghost Vanguard log merge by ${by}`;
    const pace = new Pacer(() => store.assertAuthorized(guild.id));
    const plan = planLogMerge(store, guild);
    const found = plan.categoryId ? guild.channels.cache.get(plan.categoryId) : null;
    const target = found?.type === ChannelType.GuildCategory ? found : (await resolveLogCategory(store, guild, reason, pace)).category;
    await pace.beforeChange();
    await target.setPosition(0, { reason });
    let moved = 0, renamed = 0;
    const skipped = [];
    for (const move of plan.moves) {
        store.assertAuthorized(guild.id);
        const channel = guild.channels.cache.get(move.channelId);
        if (channel?.type !== ChannelType.GuildText || channel.parentId === target.id)
            continue;
        await pace.beforeChange();
        try {
            await channel.setParent(target.id, { lockPermissions: false, reason });
            moved++;
        }
        catch (e) {
            skipped.push(`<#${move.channelId}>: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    for (const rename of plan.renames) {
        store.assertAuthorized(guild.id);
        const channel = guild.channels.cache.get(rename.channelId);
        // Only rename the exact legacy default Vanguard created; a custom name is never touched.
        if (channel?.type !== ChannelType.GuildText || channel.name !== rename.from)
            continue;
        await pace.beforeChange();
        try {
            await channel.edit({ name: rename.to, reason });
            renamed++;
        }
        catch (e) {
            skipped.push(`<#${rename.channelId}>: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return { categoryId: target.id, moved, renamed, skipped, untouched: plan.untouched };
}
/** The result of a merge, for the confirmation message. */
export function describeMerge(result) {
    const lines = [`**${LOG_CATEGORY}:** <#${result.categoryId}>`, `**Channels grouped:** ${result.moved}`];
    if (result.renamed)
        lines.push(`**Legacy names updated:** ${result.renamed} (same channel, same ID, same history)`);
    if (result.untouched.length)
        lines.push('', '**Left alone:**', ...result.untouched.slice(0, 15).map(u => `• <#${u.channelId}> — ${u.why}`), ...(result.untouched.length > 15 ? [`• Plus ${result.untouched.length - 15} more channels.`] : []));
    if (result.skipped.length)
        lines.push('', '**Could not be moved:**', ...result.skipped.slice(0, 10).map(s => `• ${s}`));
    lines.push('', 'Nothing was deleted or overwritten: every channel kept its permissions and message history, and channels Vanguard does not own were left untouched.');
    return lines.join('\n');
}
