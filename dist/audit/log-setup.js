import { ChannelType, Colors, EmbedBuilder, OverwriteType, PermissionFlagsBits } from 'discord.js';
import { DEFAULT_CATEGORIES, DEFAULT_CHANNELS, LEGACY_CATEGORIES, LEGACY_CHANNELS } from '../branding.js';
import { getFeature, setFeature } from '../features/settings.js';
import { configureEventLog, eventLogConfig } from './event-log.js';
/**
 * Where Vanguard's logs go in each server:
 *   #bans                      one record per ban, with server-owner / Developer Unban and Reban buttons
 *   #ghost-vanguard-logging    server events (messages, roles, channels, members) and bot actions
 * Settings are saved per server; existing channels are reused, never duplicated.
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
export const LEGACY_LOG_ROUTES = {
    joins: 'join-logs', commands: 'command-logs', antinuke: 'antinuke-logs', messages: 'message-logs',
    members: 'member-logs', roles: 'role-logs', channels: 'channel-logs', voice: 'voice-logs',
    server: 'server-logs', moderation: 'mod-logs',
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
 * Use the chosen channel, the saved one, one with an expected name (the current name or a legacy
 * one), or create a private one. A legacy name is reused as it is: Vanguard never renames channels.
 */
async function resolveChannel(store, guild, names, chosen, saved, reason) {
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
    const created = await guild.channels.create({ name: wanted[0], type: ChannelType.GuildText, permissionOverwrites: privateOverwrites(store, guild), reason });
    return { channel: created, created: true, how: 'created (private: staff only)' };
}
const normalizedCategoryName = (name) => name.trim().toLowerCase().replace(/[_-]+/g, ' ');
/** Find or create the category for active Ghost Vanguard logs. */
async function resolveLogCategory(store, guild, reason) {
    const category = findLogCategory(guild);
    if (category)
        return { category, created: false };
    const created = await guild.channels.create({ name: LOG_CATEGORY, type: ChannelType.GuildCategory, permissionOverwrites: privateOverwrites(store, guild), reason });
    return { category: created, created: true };
}
/** Move only the two active log channels. Keep their channel overrides and every old log message intact. */
async function placeInLogCategory(channels, category, reason) {
    for (const { channel } of channels)
        if (channel.parentId !== category.id)
            await channel.setParent(category.id, { lockPermissions: false, reason });
}
/** Rename the old Veil category so it is clearly archived; never delete its channels or messages. */
async function archiveLegacyLogCategories(guild, reason) {
    const legacyNames = new Set(LEGACY_CATEGORIES.logs.map(normalizedCategoryName));
    const archived = [];
    for (const channel of guild.channels.cache.values()) {
        if (channel.type !== ChannelType.GuildCategory || !legacyNames.has(normalizedCategoryName(channel.name)))
            continue;
        await channel.edit({ name: ARCHIVED_LOG_CATEGORY, reason });
        archived.push(channel.id);
    }
    return archived;
}
/** Reuse recognized channels from Veil's old category; preserve their overrides and history. */
async function activateLegacyRoutes(store, guild, category, reason) {
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
        if (existing.parentId !== category.id)
            await existing.setParent(category.id, { lockPermissions: false, reason });
        routes[route] = existing.id;
    }
    return { routes, skipped };
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
/** Set up (or repair) both channels and save them. */
export async function setupLogChannels(store, guild, by, chosen = {}) {
    const reason = `Ghost Vanguard log setup by ${by}`;
    const current = logChannels(store, guild.id);
    const bans = await resolveChannel(store, guild, BANS_CHANNEL, chosen.bans ?? null, current.bansChannelId, reason);
    const logging = await resolveChannel(store, guild, LOGGING_CHANNEL_NAMES, chosen.logging ?? null, eventLogConfig(store, guild.id).channelId, reason);
    if (bans.channel.id === logging.channel.id)
        throw new Error('Ban logs and server logs need two different channels.');
    const category = await resolveLogCategory(store, guild, reason);
    await category.category.setPosition(0, { reason });
    await placeInLogCategory([bans, logging], category.category, reason);
    const { routes, skipped } = await activateLegacyRoutes(store, guild, category.category, reason);
    const archivedCategories = await archiveLegacyLogCategories(guild, reason);
    setLogChannels(store, guild.id, { bansChannelId: bans.channel.id, routes }, by);
    configureEventLog(store, guild.id, { enabled: true, channelId: logging.channel.id });
    // Bot actions (anti-nuke, backups, restores, configuration changes, errors) go to the logging channel too.
    const settings = store.settings(guild.id);
    const previousAlerts = settings.logChannelId;
    if (previousAlerts !== logging.channel.id) {
        settings.logChannelId = logging.channel.id;
        store.save(settings, by);
    }
    return { bans, logging, category: category.category, categoryCreated: category.created, archivedCategories, routes, skipped, previousAlerts: previousAlerts !== logging.channel.id ? previousAlerts : null };
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
    const plan = planLogMerge(store, guild);
    const found = plan.categoryId ? guild.channels.cache.get(plan.categoryId) : null;
    const target = found?.type === ChannelType.GuildCategory ? found : (await resolveLogCategory(store, guild, reason)).category;
    await target.setPosition(0, { reason });
    let moved = 0, renamed = 0;
    const skipped = [];
    for (const move of plan.moves) {
        store.assertAuthorized(guild.id);
        const channel = guild.channels.cache.get(move.channelId);
        if (channel?.type !== ChannelType.GuildText || channel.parentId === target.id)
            continue;
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
