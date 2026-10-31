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
export const LOG_CATEGORY = DEFAULT_CATEGORIES.logs;
export const ARCHIVED_LOG_CATEGORY = LEGACY_CATEGORIES.archivedLogs;
/**
 * Names used by older releases. A server that already has one keeps using it instead of getting a
 * second log channel; the name is only reported, Vanguard never renames a server's channels by itself.
 */
export const LEGACY_LOGGING_CHANNELS = [...LEGACY_CHANNELS.logging];
export const LOGGING_CHANNEL_NAMES = [LOGGING_CHANNEL, ...LEGACY_LOGGING_CHANNELS];
const DEFAULTS = { bansChannelId: null, excludedChannels: [], ignoreBotRoutine: true };
export const logChannels = (store, guild) => getFeature(store, guild, 'log_channels', DEFAULTS);
export const setLogChannels = (store, guild, change, by) => setFeature(store, guild, 'log_channels', DEFAULTS, change, by);
export const isExcluded = (store, guild, channelId) => !!channelId && logChannels(store, guild).excludedChannels.includes(channelId);
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
    const named = text(guild.channels.cache.find(c => c.type === ChannelType.GuildText && wanted.includes(c.name)));
    if (named)
        return { channel: named, created: false, how: named.name === wanted[0] ? 'existing channel reused' : `existing channel reused (still named #${named.name})` };
    const created = await guild.channels.create({ name: wanted[0], type: ChannelType.GuildText, permissionOverwrites: privateOverwrites(store, guild), reason });
    return { channel: created, created: true, how: 'created (private: staff only)' };
}
const normalizedCategoryName = (name) => name.trim().toLowerCase().replace(/[_-]+/g, ' ');
/** Find or create the category for active Ghost Vanguard logs. */
async function resolveLogCategory(store, guild, reason) {
    const category = [...guild.channels.cache.values()].find(c => c.type === ChannelType.GuildCategory && normalizedCategoryName(c.name) === normalizedCategoryName(LOG_CATEGORY));
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
    await placeInLogCategory([bans, logging], category.category, reason);
    const archivedCategories = await archiveLegacyLogCategories(guild, reason);
    setLogChannels(store, guild.id, { bansChannelId: bans.channel.id }, by);
    configureEventLog(store, guild.id, { enabled: true, channelId: logging.channel.id });
    // Bot actions (anti-nuke, backups, restores, configuration changes, errors) go to the logging channel too.
    const settings = store.settings(guild.id);
    const previousAlerts = settings.logChannelId;
    if (previousAlerts !== logging.channel.id) {
        settings.logChannelId = logging.channel.id;
        store.save(settings, by);
    }
    return { bans, logging, category: category.category, categoryCreated: category.created, archivedCategories, previousAlerts: previousAlerts !== logging.channel.id ? previousAlerts : null };
}
