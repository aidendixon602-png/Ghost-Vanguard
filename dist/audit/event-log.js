import { AuditLogEvent, Colors, EmbedBuilder, PermissionsBitField } from 'discord.js';
import { redact } from './redact.js';
import { isExcluded, logChannels } from './log-setup.js';
import { responsibleActor } from '../security/security.js';
export const LOG_CATEGORIES = ['moderation', 'members', 'roles', 'channels', 'server', 'messages'];
export const LOG_RETENTION_DAYS = 30;
export const LOG_PAGE_SIZE = 10;
const CATEGORY_COLOR = {
    moderation: Colors.Red, members: Colors.Blue, roles: Colors.Purple,
    channels: Colors.DarkAqua, server: Colors.Grey, messages: Colors.Yellow,
};
export function eventLogConfig(store, guildId) {
    const row = store.get('SELECT * FROM event_log_config WHERE guild_id=?', guildId);
    const categories = new Set(String(row?.categories ?? LOG_CATEGORIES.join(',')).split(',').filter(c => LOG_CATEGORIES.includes(c)));
    return { enabled: !!row?.enabled, channelId: row?.channel_id ?? null, categories };
}
export function configureEventLog(store, guildId, change) {
    const current = eventLogConfig(store, guildId);
    if (change.category) {
        const [name, on] = change.category;
        on ? current.categories.add(name) : current.categories.delete(name);
    }
    const enabled = change.enabled ?? current.enabled;
    const channelId = change.channelId !== undefined ? change.channelId : current.channelId;
    const categories = LOG_CATEGORIES.filter(c => current.categories.has(c)).join(',');
    store.run('INSERT INTO event_log_config(guild_id,enabled,channel_id,categories) VALUES(?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET enabled=excluded.enabled,channel_id=excluded.channel_id,categories=excluded.categories', guildId, enabled ? 1 : 0, channelId, categories);
    return eventLogConfig(store, guildId);
}
/** True when this category is being logged, so other code can avoid posting duplicates. */
export function logsCategory(store, guildId, category) {
    const config = eventLogConfig(store, guildId);
    return config.enabled && config.categories.has(category);
}
const FIELD = /^\*\*(.+?):\*\*\s?([\s\S]*)$/;
/** Compact embed: coloured sidebar, the person's avatar, one field per detail, IDs and a timestamp. */
export function renderEvent(event) {
    const at = event.at ?? Date.now();
    const e = new EmbedBuilder().setColor(event.color ?? CATEGORY_COLOR[event.category]).setTitle(event.action.slice(0, 256)).setTimestamp(at);
    if (event.author)
        e.setAuthor({ name: event.author.name.slice(0, 256), iconURL: event.author.iconURL ?? undefined });
    const fields = [];
    const loose = [];
    if (event.target)
        fields.push({ name: event.targetLabel ?? 'Target', value: event.target, inline: true });
    if (event.actorId)
        fields.push({ name: event.actorLabel ?? 'By', value: `<@${event.actorId}> (\`${event.actorId}\`)`, inline: true });
    else if (event.actorUnverified)
        fields.push({ name: event.actorLabel ?? 'By', value: 'Unavailable (could not be verified)', inline: true });
    for (const line of event.details ?? []) {
        const m = FIELD.exec(line);
        if (m && fields.length < 24)
            fields.push({ name: m[1].slice(0, 256), value: (m[2].trim() || '—').slice(0, 1024), inline: m[2].length <= 60 && !m[2].includes('\n') });
        else if (line.trim())
            loose.push(line);
    }
    if (loose.length)
        e.setDescription(loose.join('\n').slice(0, 3900));
    if (fields.length)
        e.addFields(fields);
    if (event.image)
        e.setImage(event.image);
    const ids = [event.targetId && `${event.targetLabel ? `${event.targetLabel} ` : ''}ID: ${event.targetId}`, event.actorId && `By: ${event.actorId}`].filter(Boolean).join(' · ');
    e.setFooter({ text: ids || 'Midtown Vanguard' });
    return e;
}
/** Store an event and post it to the event log channel, if logging is on for its category. */
export function recordEvent(store, logs, guildId, event) {
    const config = eventLogConfig(store, guildId);
    if (!config.enabled || !config.categories.has(event.category))
        return false;
    if (isExcluded(store, guildId, event.channelId))
        return false;
    const at = event.at ?? Date.now();
    const clean = { ...event, at, details: (event.details ?? []).map(d => redact(d)), target: redact(event.target) };
    const lines = [
        ...(clean.actorId ? [`**By:** <@${clean.actorId}>`] : clean.actorUnverified ? ['**By:** unavailable'] : []),
        ...(clean.target ? [`**Target:** ${clean.target}`] : []),
        ...(clean.details ?? []),
    ];
    store.run('INSERT INTO event_log(guild_id,at,category,action,actor_id,target_id,target,summary) VALUES(?,?,?,?,?,?,?,?)', guildId, at, event.category, event.action, event.actorId ?? null, event.targetId ?? null, clean.target ?? null, lines.join('\n') || event.action);
    logs.push(guildId, renderEvent(clean), [], config.channelId);
    return true;
}
export function recentEvents(store, guildId, filter = {}) {
    const where = ['guild_id=?'], args = [guildId];
    if (filter.category) {
        where.push('category=?');
        args.push(filter.category);
    }
    if (filter.userId) {
        where.push('(actor_id=? OR target_id=?)');
        args.push(filter.userId, filter.userId);
    }
    const total = Number(store.get(`SELECT COUNT(*) AS n FROM event_log WHERE ${where.join(' AND ')}`, ...args)?.n ?? 0);
    const pages = Math.max(1, Math.ceil(total / LOG_PAGE_SIZE));
    const page = Math.min(Math.max(1, filter.page ?? 1), pages);
    const rows = store.all(`SELECT * FROM event_log WHERE ${where.join(' AND ')} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`, ...args, LOG_PAGE_SIZE, (page - 1) * LOG_PAGE_SIZE);
    return { rows, total, page, pages };
}
const AUDIT = {
    [AuditLogEvent.GuildUpdate]: ['server', 'Server settings changed', 'other'],
    [AuditLogEvent.ChannelCreate]: ['channels', 'Channel created', 'channel'],
    [AuditLogEvent.ChannelUpdate]: ['channels', 'Channel Updated', 'channel'],
    [AuditLogEvent.ChannelDelete]: ['channels', 'Channel deleted', 'channel'],
    [AuditLogEvent.ChannelOverwriteCreate]: ['channels', 'Channel permissions added', 'channel'],
    [AuditLogEvent.ChannelOverwriteUpdate]: ['channels', 'Channel permissions changed', 'channel'],
    [AuditLogEvent.ChannelOverwriteDelete]: ['channels', 'Channel permissions removed', 'channel'],
    [AuditLogEvent.ThreadCreate]: ['channels', 'Thread created', 'channel'],
    [AuditLogEvent.ThreadDelete]: ['channels', 'Thread deleted', 'channel'],
    [AuditLogEvent.MemberKick]: ['moderation', 'Member Kicked', 'user'],
    [AuditLogEvent.MemberPrune]: ['moderation', 'Members pruned', 'other'],
    [AuditLogEvent.MemberBanAdd]: ['moderation', 'Member Banned', 'user'],
    [AuditLogEvent.MemberBanRemove]: ['moderation', 'Member Unbanned', 'user'],
    [AuditLogEvent.MemberUpdate]: ['members', 'Member updated', 'user'],
    [AuditLogEvent.MemberRoleUpdate]: ['members', 'Roles Updated', 'user'],
    [AuditLogEvent.BotAdd]: ['server', 'Bot added', 'user'],
    [AuditLogEvent.RoleCreate]: ['roles', 'Role created', 'role'],
    [AuditLogEvent.RoleUpdate]: ['roles', 'Role Updated', 'role'],
    [AuditLogEvent.RoleDelete]: ['roles', 'Role deleted', 'role'],
    [AuditLogEvent.InviteCreate]: ['server', 'Invite created', 'other'],
    [AuditLogEvent.InviteDelete]: ['server', 'Invite deleted', 'other'],
    [AuditLogEvent.WebhookCreate]: ['server', 'Webhook created', 'other'],
    [AuditLogEvent.WebhookUpdate]: ['server', 'Webhook updated', 'other'],
    [AuditLogEvent.WebhookDelete]: ['server', 'Webhook deleted', 'other'],
    [AuditLogEvent.EmojiCreate]: ['server', 'Emoji added', 'other'],
    [AuditLogEvent.EmojiUpdate]: ['server', 'Emoji updated', 'other'],
    [AuditLogEvent.EmojiDelete]: ['server', 'Emoji deleted', 'other'],
    [AuditLogEvent.StickerCreate]: ['server', 'Sticker added', 'other'],
    [AuditLogEvent.StickerDelete]: ['server', 'Sticker deleted', 'other'],
    [AuditLogEvent.IntegrationCreate]: ['server', 'Integration added', 'other'],
    [AuditLogEvent.IntegrationDelete]: ['server', 'Integration removed', 'other'],
    [AuditLogEvent.AutoModerationRuleCreate]: ['server', 'AutoMod rule created', 'other'],
    [AuditLogEvent.AutoModerationRuleUpdate]: ['server', 'AutoMod rule updated', 'other'],
    [AuditLogEvent.AutoModerationRuleDelete]: ['server', 'AutoMod rule deleted', 'other'],
    [AuditLogEvent.MessageDelete]: ['messages', 'Message deleted by a moderator', 'user'],
    [AuditLogEvent.MessageBulkDelete]: ['messages', 'Messages bulk-deleted', 'channel'],
    [AuditLogEvent.MessagePin]: ['messages', 'Message pinned', 'user'],
    [AuditLogEvent.MessageUnpin]: ['messages', 'Message unpinned', 'user'],
};
const HIDDEN_KEYS = new Set(['id', 'type', 'position', 'permission_overwrites', 'flags', 'icon_hash', 'avatar_hash', 'splash_hash', 'banner_hash', 'colors']);
const shown = (value) => {
    if (value === undefined || value === null || value === '')
        return 'none';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return text.length > 60 ? `${text.slice(0, 57)}...` : text;
};
const PERMISSION_NAMES = { ManageGuild: 'manage server', CreateInstantInvite: 'create invite', ModerateMembers: 'timeout members', ViewAuditLog: 'view audit log', SendTTSMessages: 'send TTS messages', UseVAD: 'use voice activity' };
const permissionName = (flag) => PERMISSION_NAMES[flag] ?? flag.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
function bits(value) {
    try {
        return value === undefined || value === null || value === '' ? 0n : BigInt(String(value));
    }
    catch {
        return null;
    }
}
/** "`kick members` granted, `ban members` revoked" from two permission bitfields. */
export function permissionDiff(oldValue, newValue, key = 'permissions') {
    const before = bits(oldValue), after = bits(newValue);
    if (before === null || after === null)
        return null;
    const on = key === 'deny' ? 'denied' : key === 'allow' ? 'allowed' : 'granted';
    const off = key === 'permissions' ? 'revoked' : 'reset';
    const parts = [];
    for (const [flag, bit] of Object.entries(PermissionsBitField.Flags)) {
        if ((after & bit) && !(before & bit))
            parts.push(`\`${permissionName(flag)}\` ${on}`);
        else if ((before & bit) && !(after & bit))
            parts.push(`\`${permissionName(flag)}\` ${off}`);
    }
    if (!parts.length)
        return null;
    return parts.length > 25 ? `${parts.slice(0, 25).join(', ')} and ${parts.length - 25} more` : parts.join(', ');
}
function changeLines(entry) {
    const lines = [];
    for (const change of (entry.changes ?? [])) {
        if (change.key === '$add' || change.key === '$remove') {
            const roles = (change.new ?? []).map((r) => `<@&${r.id}>`).join(', ');
            lines.push(`**${change.key === '$add' ? 'Roles added' : 'Roles removed'}:** ${roles}`);
        }
        else if (change.key === 'communication_disabled_until')
            continue;
        else if (change.key === 'permissions' || change.key === 'allow' || change.key === 'deny') {
            const diff = permissionDiff(change.old, change.new, change.key);
            if (diff)
                lines.unshift(`🔐 **Permissions:** ${diff}`);
        }
        else if (!HIDDEN_KEYS.has(change.key))
            lines.push(`**${change.key.replaceAll('_', ' ')}:** ${shown(change.old)} → ${shown(change.new)}`);
        if (lines.length >= 6)
            break;
    }
    return lines;
}
function targetText(entry, kind) {
    const id = entry.targetId;
    const named = (entry.changes ?? []).find((c) => c.key === 'name');
    const label = entry.target?.tag ?? entry.target?.name ?? named?.new ?? named?.old;
    if (!id)
        return label ? String(label) : null;
    const deleted = entry.action === AuditLogEvent.ChannelDelete || entry.action === AuditLogEvent.RoleDelete || entry.action === AuditLogEvent.ThreadDelete;
    if (kind === 'user')
        return `<@${id}>${label ? ` (${label})` : ''}`;
    if (kind === 'channel')
        return deleted ? `#${label ?? id}` : `<#${id}>`;
    if (kind === 'role')
        return deleted ? `@${label ?? id}` : `<@&${id}>`;
    return label ? `${label}` : null;
}
/** Channel renames and topic edits: what member-count and status bots do all day. */
const ROUTINE_KEYS = new Set(['name', 'topic']);
const ACTION_COLOR = {
    'Member Banned': Colors.Red, 'Member Kicked': Colors.DarkOrange, 'Member Unbanned': Colors.Green,
    'Timeout Added': Colors.Orange, 'Timeout Removed': Colors.Green, 'Nickname Changed': Colors.Blue, 'Roles Updated': Colors.Purple, 'Role Updated': Colors.Orange,
};
export function duration(ms) {
    const minutes = Math.round(ms / 60000);
    if (minutes < 60)
        return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    const hours = Math.round(minutes / 6) / 10;
    if (hours < 48)
        return `${hours} hour${hours === 1 ? '' : 's'}`;
    const days = Math.round(hours / 2.4) / 10;
    return `${days} day${days === 1 ? '' : 's'}`;
}
/**
 * Describe an audit entry as a log event, or null if it is not logged. Discord's audit log names
 * who did it, so the actor is always verified. Vanguard's own actions are skipped: commands,
 * anti-nuke, restores and the ban log already report them (with the staff member who ran them),
 * so they are not posted twice.
 */
export function describeAudit(entry, guild, options = {}) {
    const known = AUDIT[entry.action];
    if (!known)
        return null;
    const actor = responsibleActor(entry, guild);
    if (!actor || actor === guild.client.user?.id || entry.executorId === guild.client.user?.id)
        return null;
    let [category, action] = known;
    const kind = known[2];
    const changes = (entry.changes ?? []);
    const executor = entry.executor ?? guild.client.users?.cache?.get(actor);
    if ((options.ignoreBotRoutine ?? true) && executor?.bot && entry.action === AuditLogEvent.ChannelUpdate && changes.length && changes.every(c => ROUTINE_KEYS.has(c.key)))
        return null;
    let details = changeLines(entry);
    const timeout = changes.find(c => c.key === 'communication_disabled_until');
    const nick = changes.find(c => c.key === 'nick');
    if (entry.action === AuditLogEvent.MemberUpdate && timeout) {
        category = 'moderation';
        action = timeout.new ? 'Timeout Added' : 'Timeout Removed';
        if (timeout.new) {
            const until = Date.parse(timeout.new);
            details.unshift(`**Until:** <t:${Math.floor(until / 1000)}:f>`, `**Duration:** ${duration(until - entry.createdTimestamp)}`);
        }
    }
    else if (entry.action === AuditLogEvent.MemberUpdate && nick) {
        action = 'Nickname Changed';
        details = [`**Old nickname:** ${nick.old ? shown(nick.old) : '*none*'}`, `**New nickname:** ${nick.new ? shown(nick.new) : '*none*'}`];
    }
    const extra = entry.extra;
    if (entry.action === AuditLogEvent.MemberPrune && extra?.removed !== undefined)
        details.unshift(`**Removed:** ${extra.removed} member(s) inactive for ${extra.days} day(s)`);
    if (entry.action === AuditLogEvent.MessageBulkDelete && extra?.count !== undefined)
        details.unshift(`**Messages:** ${extra.count}`);
    if (entry.action === AuditLogEvent.MessageDelete && extra?.channel)
        details.unshift(`**In:** <#${extra.channel.id ?? extra.channel}>${extra.count > 1 ? ` · ${extra.count} messages` : ''}`);
    const reason = entry.reason?.replace(/^\d{17,20}: /, '');
    if (reason)
        details.push(`**Reason:** ${shown(reason)}`);
    const target = entry.target;
    const user = kind === 'user' && target && typeof target.displayAvatarURL === 'function' ? target : null;
    const channelId = kind === 'channel' ? entry.targetId : extra?.channel ? String(extra.channel.id ?? extra.channel) : null;
    return { category, action, actorId: actor, targetId: entry.targetId ?? null, target: targetText(entry, kind), details, at: entry.createdTimestamp,
        actorLabel: category === 'moderation' ? 'Moderator' : kind === 'role' ? 'Updated By' : 'Changed by', color: ACTION_COLOR[action],
        targetLabel: kind === 'role' ? 'Role' : undefined,
        author: user ? { name: user.tag ?? user.username, iconURL: user.displayAvatarURL() } : null, channelId };
}
export function recordAuditEvent(store, logs, entry, guild) {
    const event = describeAudit(entry, guild, { ignoreBotRoutine: logChannels(store, guild.id).ignoreBotRoutine });
    if (event)
        recordEvent(store, logs, guild.id, event);
}
export function recordMemberEvent(store, logs, member, joined) {
    const user = member.user;
    const created = user?.createdTimestamp ? ` · account created <t:${Math.floor(user.createdTimestamp / 1000)}:R>` : '';
    recordEvent(store, logs, member.guild.id, {
        category: 'members', action: joined ? 'Member joined' : 'Member left',
        targetId: member.id, target: `<@${member.id}>${user?.tag ? ` (${user.tag})` : ''}`,
        details: joined && created ? [`**Account:**${created.replace(' · account', '')}`] : [],
    });
}
