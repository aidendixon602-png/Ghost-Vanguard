import { AuditLogEvent, Colors, EmbedBuilder, PermissionsBitField, type Guild, type GuildAuditLogsEntry, type GuildMember, type PartialGuildMember, type VoiceState } from 'discord.js';
import { PRODUCT_NAME } from '../branding.js';
import { redact } from './redact.js';
import { isExcluded, logChannels, logRoute, type LogRoute } from './log-setup.js';
import type { Store } from '../database/db.js';
import type { LogQueue } from '../logging.js';
import { responsibleActor } from '../security/security.js';
import { embed } from '../ui/ui.js';

export const LOG_CATEGORIES = ['moderation', 'members', 'roles', 'channels', 'server', 'messages'] as const;

export type LogCategory = typeof LOG_CATEGORIES[number];

export const LOG_RETENTION_DAYS = 30;
export const LOG_PAGE_SIZE = 10;

const CATEGORY_COLOR: Record<LogCategory, number> = {
    moderation: Colors.Red, members: Colors.Blue, roles: Colors.Purple,
    channels: Colors.DarkAqua, server: Colors.Grey, messages: Colors.Yellow,
};

export interface EventLogConfig {
    enabled: boolean;
    channelId: string | null;
    categories: Set<LogCategory>;
}

export interface LogEvent {
    category: LogCategory;
    route?: LogRoute;
    action: string;
    actorId?: string | null;
    targetId?: string | null;
    /** How the target is shown, e.g. "<#123>" or "#general". */
    target?: string | null;
    /** Extra detail lines (changes, reason). "**Name:** value" lines become embed fields. */
    details?: string[];
    at?: number;
    /** The person shown at the top of the embed (name and avatar). */
    author?: { name: string; iconURL?: string | null } | null;
    /** Channel the event happened in, used for logging exclusions. */
    channelId?: string | null;
    /** Who did it could not be verified: shown as "Unavailable" instead of guessing. */
    actorUnverified?: boolean;
    /** Label for the actor field (default "By"). */
    actorLabel?: string;
    /** Use mentions as the only actor/target identifiers instead of repeating raw IDs in the footer. */
    compact?: boolean;
    /** Label for the target field (default "Target"). */
    targetLabel?: string;
    color?: number;
    image?: string | null;
}

export function eventLogConfig(store: Store, guildId: string): EventLogConfig {
    const row = store.get('SELECT * FROM event_log_config WHERE guild_id=?', guildId);
    const categories = new Set(String(row?.categories ?? LOG_CATEGORIES.join(',')).split(',').filter(c => (LOG_CATEGORIES as readonly string[]).includes(c)) as LogCategory[]);
    return { enabled: !!row?.enabled, channelId: row?.channel_id ?? null, categories };
}

export function configureEventLog(store: Store, guildId: string, change: {
    enabled?: boolean;
    channelId?: string | null;
    category?: [LogCategory, boolean];
}) {
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
export function logsCategory(store: Store, guildId: string, category: LogCategory): boolean {
    const config = eventLogConfig(store, guildId);
    return config.enabled && config.categories.has(category);
}

const FIELD = /^\*\*(.+?):\*\*\s?([\s\S]*)$/;

/** Render a log embed with actor, target, details, and timestamp; compact cards avoid repeated IDs. */
export function renderEvent(event: LogEvent): EmbedBuilder {
    const at = event.at ?? Date.now();
    const e = new EmbedBuilder().setColor(event.color ?? CATEGORY_COLOR[event.category]).setTitle(event.action.slice(0, 256)).setTimestamp(at);
    if (event.author && !event.compact) e.setAuthor({ name: event.author.name.slice(0, 256), iconURL: event.author.iconURL ?? undefined });
    const fields: { name: string; value: string; inline?: boolean }[] = [];
    const loose: string[] = [];
    if (event.target) fields.push({ name: event.targetLabel ?? 'Target', value: event.target, inline: true });
    if (event.actorId) fields.push({ name: event.actorLabel ?? 'By', value: event.compact ? `<@${event.actorId}>` : `<@${event.actorId}> (\`${event.actorId}\`)`, inline: true });
    else if (event.actorUnverified) fields.push({ name: event.actorLabel ?? 'By', value: 'Unavailable (could not be verified)', inline: true });
    for (const line of event.details ?? []) {
        const m = FIELD.exec(line);
        if (m && fields.length < 24) fields.push({ name: m[1]!.slice(0, 256), value: (m[2]!.trim() || '—').slice(0, 1024), inline: m[2]!.length <= 60 && !m[2]!.includes('\n') });
        else if (line.trim()) loose.push(line);
    }
    if (loose.length) e.setDescription(loose.join('\n').slice(0, 3900));
    if (fields.length) e.addFields(fields);
    if (event.image) e.setImage(event.image);
    const ids = event.compact ? '' : [event.targetId && `${event.targetLabel ? `${event.targetLabel} ` : ''}ID: ${event.targetId}`, event.actorId && `By: ${event.actorId}`].filter(Boolean).join(' · ');
    e.setFooter({ text: ids || PRODUCT_NAME });
    return e;
}

function compactTarget(target: string | null | undefined) {
    const mention = /^(<@\d+>)(?:\s+\([\s\S]*\))?$/.exec(target ?? '');
    return mention ? mention[1]! : target;
}

/** Store an event and post it to the event log channel, if logging is on for its category. */
export function recordEvent(store: Store, logs: LogQueue, guildId: string, event: LogEvent, options: { post?: boolean; compact?: boolean } = {}): boolean {
    const config = eventLogConfig(store, guildId);
    if (!config.enabled || !config.categories.has(event.category))
        return false;
    if (isExcluded(store, guildId, event.channelId))
        return false;
    const at = event.at ?? Date.now();
    const clean: LogEvent = { ...event, at, details: (event.details ?? []).map(d => redact(d)), target: redact(event.target) };
    const lines = [
        ...(clean.actorId ? [`**By:** <@${clean.actorId}>`] : clean.actorUnverified ? ['**By:** unavailable'] : []),
        ...(clean.target ? [`**Target:** ${clean.target}`] : []),
        ...(clean.details ?? []),
    ];
    store.run('INSERT INTO event_log(guild_id,at,category,action,actor_id,target_id,target,summary) VALUES(?,?,?,?,?,?,?,?)', guildId, at, event.category, event.action, event.actorId ?? null, event.targetId ?? null, clean.target ?? null, lines.join('\n') || event.action);
    if (options.post !== false) {
        const display = options.compact ? { ...clean, compact: true, author: null, target: compactTarget(clean.target) } : clean;
        logs.push(guildId, renderEvent(display), [], logRoute(store, guildId, event.route ?? event.category) ?? config.channelId);
    }
    return true;
}

export function recentEvents(store: Store, guildId: string, filter: {
    category?: LogCategory | null;
    userId?: string | null;
    page?: number;
} = {}) {
    const where = ['guild_id=?'], args: (string | number)[] = [guildId];
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
// ---- Turning Discord audit entries into readable events ----

type Kind = 'user' | 'channel' | 'role' | 'other';

const AUDIT: Record<number, [LogCategory, string, Kind]> = {
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

const shown = (value: unknown): string => {
    if (value === undefined || value === null || value === '')
        return 'none';
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return text.length > 60 ? `${text.slice(0, 57)}...` : text;
};

const PERMISSION_NAMES: Record<string, string> = { ManageGuild: 'manage server', CreateInstantInvite: 'create invite', ModerateMembers: 'timeout members', ViewAuditLog: 'view audit log', SendTTSMessages: 'send TTS messages', UseVAD: 'use voice activity' };
const permissionName = (flag: string) => PERMISSION_NAMES[flag] ?? flag.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

function bits(value: unknown): bigint | null {
    try { return value === undefined || value === null || value === '' ? 0n : BigInt(String(value)); } catch { return null; }
}

/** "`kick members` granted, `ban members` revoked" from two permission bitfields. */
export function permissionDiff(oldValue: unknown, newValue: unknown, key: 'permissions' | 'allow' | 'deny' | string = 'permissions'): string | null {
    const before = bits(oldValue), after = bits(newValue);
    if (before === null || after === null) return null;
    const on = key === 'deny' ? 'denied' : key === 'allow' ? 'allowed' : 'granted';
    const off = key === 'permissions' ? 'revoked' : 'reset';
    const parts: string[] = [];
    for (const [flag, bit] of Object.entries(PermissionsBitField.Flags)) {
        if ((after & bit) && !(before & bit)) parts.push(`\`${permissionName(flag)}\` ${on}`);
        else if ((before & bit) && !(after & bit)) parts.push(`\`${permissionName(flag)}\` ${off}`);
    }
    if (!parts.length) return null;
    return parts.length > 25 ? `${parts.slice(0, 25).join(', ')} and ${parts.length - 25} more` : parts.join(', ');
}

/** Permissions worth calling out when a whole role is created or deleted (the everyday ones are just counted). */
const NOTABLE = ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'BanMembers', 'KickMembers', 'ModerateMembers', 'ManageWebhooks', 'ManageMessages', 'MentionEveryone', 'ManageNicknames', 'ViewAuditLog'] as const;
export function notablePermissions(value: unknown): string | null {
    const all = bits(value);
    if (all === null) return null;
    const flags = Object.entries(PermissionsBitField.Flags).filter(([, bit]) => all & bit);
    const notable = flags.filter(([flag]) => (NOTABLE as readonly string[]).includes(flag)).map(([flag]) => `\`${permissionName(flag)}\``);
    const rest = flags.length - notable.length;
    if (!flags.length) return 'none';
    return [notable.join(', '), rest && `${rest} everyday permission${rest === 1 ? '' : 's'}`].filter(Boolean).join(' + ');
}

/** One line per channel permission whose state changed: allowed, denied or reset. */
export function overwriteDiff(entry: GuildAuditLogsEntry): string | null {
    const changes = (entry.changes ?? []) as { key: string; old?: unknown; new?: unknown }[];
    const allow = changes.find(c => c.key === 'allow'), deny = changes.find(c => c.key === 'deny');
    if (!allow && !deny) return null;
    const created = entry.action === AuditLogEvent.ChannelOverwriteCreate, removed = entry.action === AuditLogEvent.ChannelOverwriteDelete;
    const pick = (c: typeof allow, side: 'old' | 'new') => bits(c ? c[side] : 0) ?? 0n;
    // Discord only lists the side that changed; the unchanged side keeps its value (unknown to us), so treat it as unchanged.
    const before = { a: pick(allow, created ? 'new' : 'old'), d: pick(deny, created ? 'new' : 'old') };
    const after = { a: pick(allow, removed ? 'old' : 'new'), d: pick(deny, removed ? 'old' : 'new') };
    if (created) { before.a = 0n; before.d = 0n; }
    if (removed) { after.a = 0n; after.d = 0n; }
    const parts: string[] = [];
    for (const [flag, bit] of Object.entries(PermissionsBitField.Flags)) {
        const was = before.a & bit ? 'allowed' : before.d & bit ? 'denied' : 'reset';
        const now = after.a & bit ? 'allowed' : after.d & bit ? 'denied' : 'reset';
        if (was !== now) parts.push(`\`${permissionName(flag)}\` ${now}`);
    }
    if (!parts.length) return null;
    return parts.length > 25 ? `${parts.slice(0, 25).join(', ')} and ${parts.length - 25} more` : parts.join(', ');
}

function changeLines(entry: GuildAuditLogsEntry): string[] {
    const lines: string[] = [];
    const overwrite = overwriteDiff(entry);
    if (overwrite) lines.push(`🔐 **Permissions:** ${overwrite}`);
    for (const change of (entry.changes ?? []) as {
        key: string;
        old?: any;
        new?: any;
    }[]) {
        if (change.key === '$add' || change.key === '$remove') {
            const roles = (change.new ?? []).map((r: {
                id: string;
            }) => `<@&${r.id}>`).join(', ');
            lines.push(`**${change.key === '$add' ? 'Roles added' : 'Roles removed'}:** ${roles}`);
        } else if (change.key === 'communication_disabled_until')
            continue;
        else if (change.key === 'permissions') {
            const diff = entry.action === AuditLogEvent.RoleCreate || entry.action === AuditLogEvent.RoleDelete
                ? notablePermissions(change.new ?? change.old) : permissionDiff(change.old, change.new);
            if (diff) lines.unshift(`🔐 **Permissions:** ${diff}`);
        } else if (change.key === 'allow' || change.key === 'deny')
            continue;
        else if (!HIDDEN_KEYS.has(change.key))
            lines.push(`**${change.key.replaceAll('_', ' ')}:** ${shown(change.old)} → ${shown(change.new)}`);
        if (lines.length >= 6)
            break;
    }
    return lines;
}

function targetText(entry: GuildAuditLogsEntry, kind: Kind): string | null {
    const id = entry.targetId;
    const named = (entry.changes ?? []).find((c: any) => c.key === 'name') as {
        old?: string;
        new?: string;
    } | undefined;
    const label = (entry.target as any)?.tag ?? (entry.target as any)?.name ?? named?.new ?? named?.old;
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
const ACTION_COLOR: Record<string, number> = {
    'Member Banned': Colors.Red, 'Member Kicked': Colors.DarkOrange, 'Member Unbanned': Colors.Green,
    'Timeout Added': Colors.Orange, 'Timeout Removed': Colors.Green, 'Nickname Changed': Colors.Blue, 'Roles Updated': Colors.Purple, 'Role Updated': Colors.Orange,
};

export function duration(ms: number): string {
    const minutes = Math.round(ms / 60000);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    const hours = Math.round(minutes / 6) / 10;
    if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
    const days = Math.round(hours / 2.4) / 10;
    return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * Describe an audit entry as a log event, or null if it is not logged. Discord's audit log names
 * who did it, so the actor is always verified. Vanguard's own actions are skipped: commands,
 * anti-nuke, restores and the ban log already report them (with the staff member who ran them),
 * so they are not posted twice.
 */
export function describeAudit(entry: GuildAuditLogsEntry, guild: Guild, options: { ignoreBotRoutine?: boolean } = {}): LogEvent | null {
    const known = AUDIT[entry.action as number];
    if (!known)
        return null;
    const actor = responsibleActor(entry, guild);
    if (!actor || actor === guild.client.user?.id || entry.executorId === guild.client.user?.id)
        return null;
    let [category, action] = known;
    const kind = known[2];
    const changes = (entry.changes ?? []) as { key: string; old?: any; new?: any }[];
    const executor = (entry as any).executor ?? guild.client.users?.cache?.get(actor);
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
    } else if (entry.action === AuditLogEvent.MemberUpdate && nick) {
        action = 'Nickname Changed';
        details = [`**Old nickname:** ${nick.old ? shown(nick.old) : '*none*'}`, `**New nickname:** ${nick.new ? shown(nick.new) : '*none*'}`];
    }
    const extra = entry.extra as any;
    if (entry.action === AuditLogEvent.MemberPrune && extra?.removed !== undefined)
        details.unshift(`**Removed:** ${extra.removed} member(s) inactive for ${extra.days} day(s)`);
    if (entry.action === AuditLogEvent.MessageBulkDelete && extra?.count !== undefined)
        details.unshift(`**Messages:** ${extra.count}`);
    if (entry.action === AuditLogEvent.MessageDelete && extra?.channel)
        details.unshift(`**In:** <#${extra.channel.id ?? extra.channel}>${extra.count > 1 ? ` · ${extra.count} messages` : ''}`);
    const reason = entry.reason?.replace(/^\d{17,20}: /, '');
    if (reason)
        details.push(`**Reason:** ${shown(reason)}`);
    const target = entry.target as any;
    const user = kind === 'user' && target && typeof target.displayAvatarURL === 'function' ? target : null;
    const channelId = kind === 'channel' ? entry.targetId : extra?.channel ? String(extra.channel.id ?? extra.channel) : null;
    return { category, action, actorId: actor, targetId: entry.targetId ?? null, target: targetText(entry, kind), details, at: entry.createdTimestamp,
        actorLabel: category === 'moderation' ? 'Moderator' : kind === 'role' ? (entry.action === AuditLogEvent.RoleCreate ? 'Created By' : entry.action === AuditLogEvent.RoleDelete ? 'Deleted By' : 'Updated By') : 'Changed by', color: ACTION_COLOR[action],
        targetLabel: kind === 'role' ? 'Role' : undefined,
        author: user ? { name: user.tag ?? user.username, iconURL: user.displayAvatarURL() } : null, channelId };
}

const ROLE_CHANGE_GROUP_WINDOW_MS = 4000;

interface PendingRoleChangeLog {
    store: Store;
    logs: LogQueue;
    guildId: string;
    event: LogEvent;
    added: Set<string>;
    removed: Set<string>;
    otherDetails: Set<string>;
    count: number;
    timer: ReturnType<typeof setTimeout>;
}

const pendingRoleChangeLogs = new Map<string, PendingRoleChangeLog>();

function addRoleEventDetails(batch: PendingRoleChangeLog, event: LogEvent) {
    for (const line of event.details ?? []) {
        const match = FIELD.exec(line);
        if (!match) {
            if (line.trim()) batch.otherDetails.add(line);
            continue;
        }
        const label = match[1]!.toLowerCase();
        const roles = label === 'roles added' ? batch.added : label === 'roles removed' ? batch.removed : null;
        if (!roles) {
            batch.otherDetails.add(line);
            continue;
        }
        for (const role of match[2]!.split(/,\s*/).map(value => value.trim()).filter(Boolean))
            roles.add(role);
    }
}

function flushRoleChangeLog(key: string) {
    const batch = pendingRoleChangeLogs.get(key);
    if (!batch) return;
    clearTimeout(batch.timer);
    pendingRoleChangeLogs.delete(key);

    const config = eventLogConfig(batch.store, batch.guildId);
    if (!config.enabled || !config.categories.has(batch.event.category) || isExcluded(batch.store, batch.guildId, batch.event.channelId)) return;

    const details: string[] = [];
    if (batch.added.size) details.push(`**Added:** ${[...batch.added].join(', ')}`);
    if (batch.removed.size) details.push(`**Removed:** ${[...batch.removed].join(', ')}`);
    details.push(...batch.otherDetails);
    const summary: LogEvent = {
        ...batch.event,
        action: batch.count > 1 ? `Role changes · ${batch.count} updates` : 'Role changes',
        details,
        target: batch.event.targetId ? `<@${batch.event.targetId}>` : compactTarget(batch.event.target),
        author: null,
        compact: true,
        color: Colors.Purple,
    };
    const clean: LogEvent = { ...summary, details: (summary.details ?? []).map(detail => redact(detail)), target: redact(summary.target) };
    batch.logs.push(batch.guildId, renderEvent(clean), [], logRoute(batch.store, batch.guildId, 'roles') ?? config.channelId);
}

function queueRoleChangeLog(store: Store, logs: LogQueue, guildId: string, event: LogEvent) {
    const key = `${guildId}:${event.actorId}:${event.targetId}`;
    let batch = pendingRoleChangeLogs.get(key);
    if (!batch) {
        batch = { store, logs, guildId, event, added: new Set(), removed: new Set(), otherDetails: new Set(), count: 0,
            timer: setTimeout(() => flushRoleChangeLog(key), ROLE_CHANGE_GROUP_WINDOW_MS) };
        pendingRoleChangeLogs.set(key, batch);
    }
    batch.event = { ...event, author: event.author ?? batch.event.author, target: event.target ?? batch.event.target };
    batch.count++;
    addRoleEventDetails(batch, event);
}

/** Flush pending role summaries immediately, for shutdown and deterministic tests. */
export function flushPendingRoleChangeLogs() {
    for (const key of [...pendingRoleChangeLogs.keys()]) flushRoleChangeLog(key);
}

export function recordAuditEvent(store: Store, logs: LogQueue, entry: GuildAuditLogsEntry, guild: Guild) {
    const event = describeAudit(entry, guild, { ignoreBotRoutine: logChannels(store, guild.id).ignoreBotRoutine });
    if (!event) return;
    if (event.action === 'Roles Updated' && event.actorId && event.targetId) {
        // Preserve every audit event in history, but post rapid same-actor/same-target edits as one card.
        if (recordEvent(store, logs, guild.id, event, { post: false }))
            queueRoleChangeLog(store, logs, guild.id, event);
        return;
    }
    recordEvent(store, logs, guild.id, event, { compact: true });
}

export function recordMemberEvent(store: Store, logs: LogQueue, member: GuildMember | PartialGuildMember, joined: boolean) {
    const user = member.user;
    const created = user?.createdTimestamp ? ` · account created <t:${Math.floor(user.createdTimestamp / 1000)}:R>` : '';
    recordEvent(store, logs, member.guild.id, {
        category: 'members', route: 'joins', action: joined ? 'Member joined' : 'Member left',
        targetId: member.id, target: `<@${member.id}>${user?.tag ? ` (${user.tag})` : ''}`,
        details: joined && created ? [`**Account:**${created.replace(' · account', '')}`] : [],
    }, { compact: true });
}

/** Voice state changes are recorded only for servers that configured the dedicated channel. */
export function recordVoiceEvent(store: Store, logs: LogQueue, old: VoiceState, state: VoiceState) {
    const changes = (['serverMute', 'serverDeaf', 'selfMute', 'selfDeaf', 'streaming', 'selfVideo'] as const)
        .filter(key => typeof old[key] === 'boolean' && typeof state[key] === 'boolean' && old[key] !== state[key]).map(key => `**${key}:** ${state[key] ? 'on' : 'off'}`);
    if (old.channelId === state.channelId && (!state.channelId || !changes.length)) return;
    if (isExcluded(store, state.guild.id, old.channelId) || isExcluded(store, state.guild.id, state.channelId)) return;
    const action = old.channelId === state.channelId ? 'Voice state updated' : !old.channelId ? 'Voice channel joined' : !state.channelId ? 'Voice channel left' : 'Voice channel changed';
    const details = [old.channelId ? `**From:** <#${old.channelId}>` : '', state.channelId ? `**To:** <#${state.channelId}>` : ''].filter(Boolean);
    recordEvent(store, logs, state.guild.id, { category: 'members', route: 'voice', action, targetId: state.id, target: `<@${state.id}>`, channelId: state.channelId ?? old.channelId, details: [...details, ...changes] }, { compact: true });
}
