import { withRecoveryApi, isRecoveryLimit, waitMs } from './recovery-api.js';
import { ChannelType, Guild, OverwriteType, type GuildChannelCreateOptions, type GuildEditOptions } from 'discord.js';
import { createHash } from 'node:crypto';
import type { Store } from '../database/db.js';
import { config } from '../config.js';
import { ActionPacer, RecoveryLocks, selectComponents, type Component } from './recovery.js';
import { isBlacklisted } from '../security/role-blacklist.js';
import { AppError, logEvent } from '../errors.js';

const SUPPORTED = new Set<number>([ChannelType.GuildCategory, ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement, ChannelType.GuildStageVoice, ChannelType.GuildForum, ChannelType.GuildMedia]);

export interface RoleData {
    id: string;
    name: string;
    color: number;
    hoist: boolean;
    mentionable: boolean;
    permissions: string;
    position: number;
    managed: boolean;
}

export interface ChannelData {
    id: string;
    name: string;
    type: number;
    parent: string | null;
    position: number;
    topic?: string | null;
    nsfw?: boolean;
    rateLimitPerUser?: number;
    bitrate?: number;
    userLimit?: number;
    rtcRegion?: string | null;
    defaultAutoArchiveDuration?: number;
    defaultThreadRateLimitPerUser?: number;
    defaultSortOrder?: number | null;
    defaultForumLayout?: number;
    defaultReactionEmoji?: {
        emojiId: string | null;
        emojiName: string | null;
    } | null;
    availableTags?: {
        id?: string;
        name: string;
        moderated: boolean;
        emoji: {
            id: string | null;
            name: string | null;
        } | null;
    }[];
    overwrites: {
        id: string;
        type: number;
        allow: string;
        deny: string;
    }[];
}

export interface Snapshot {
    version: 1;
    guildId: string;
    name: string;
    roles: RoleData[];
    channels: ChannelData[];
    unsupported: string[];
    sourceGuildId?: string;
    settings?: {
        afkTimeout: number;
        verificationLevel: number;
        explicitContentFilter: number;
        defaultMessageNotifications: number;
        preferredLocale: string;
        afkChannelId: string | null;
        systemChannelId: string | null;
        rulesChannelId: string | null;
        publicUpdatesChannelId: string | null;
    };
    roleMap: Record<string, string>;
    channelMap: Record<string, string>;
}

export interface Plan {
    fingerprint: string;
    roleCreate: number;
    roleUpdate: number;
    channelCreate: number;
    channelUpdate: number;
    settingsUpdate: number;
    roleUpdates: string[];
    channelUpdates: string[];
    roleDelete: string[];
    channelDelete: string[];
    skipped: string[];
    roleMap: Record<string, string>;
    channelMap: Record<string, string>;
    blockedRoles: string[];
    blockedChannels: string[];
}

const mapped = (map: Record<string, string>, id: string) => map[id] ?? id;
/** Ranges such as 1-20 may include numbers that were already deleted; single numbers must exist. */
const range0 = (value: string) => /\d-\d/.test(value);
export function recoveryLabel(kind: string, purpose: string | null): string {
    if (kind === 'copy') return 'Layout copy';
    if (purpose === 'baseline') return 'Anti-nuke baseline';
    if (purpose === 'scheduled') return 'Scheduled backup';
    if (purpose === 'rollback') return 'Pre-restore backup';
    return kind === 'backup' ? 'Backup' : 'Snapshot';
}

export function remapOverwrites(items: ChannelData['overwrites'], roles: Record<string, string>, validRoles: Set<string>) {
    return items.flatMap(o => {
        const id = o.type === OverwriteType.Role ? mapped(roles, o.id) : o.id;
        return o.type === OverwriteType.Role && !validRoles.has(id) ? [] : [{ id, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) }];
    });
}

export class Snapshots {
    readonly locks: RecoveryLocks;
    onAudit?: (guildId: string, title: string, detail: string) => void;

    audit(guildId: string, actor: string, event: string, snapshotId: number | null, detail: string) {
        // Audit records remain available even when authorization is revoked during an operation.
        this.store.db.prepare('INSERT INTO recovery_events(guild_id,actor_id,event,snapshot_id,at,detail) VALUES(?,?,?,?,?,?)').run(guildId, actor, event, snapshotId, Date.now(), detail);
        logEvent('recovery_activity', { guildId, actor, event, snapshotId });
        try {
            this.onAudit?.(guildId, event.replaceAll('_', ' '), `Actor: ${actor}\n${detail}`);
        } catch (error) {
            logEvent('recovery_log_delivery_failure', { guildId, event });
        }
    }

    /** The per-server number shown to staff (#1, #2, ...) for an internal snapshot row ID. */
    numberOf(guildId: string, id: number): number {
        return Number(this.store.get('SELECT number FROM snapshots WHERE guild_id=? AND id=?', guildId, id)?.number ?? id);
    }
    /** Resolve a per-server number typed by staff to the internal row ID. */
    idFor(guildId: string, number: number): number {
        const row = this.store.get('SELECT id FROM snapshots WHERE guild_id=? AND number=?', guildId, number);
        if (!row)
            throw new AppError('VALIDATION_ERROR', `Recovery point #${number} was not found in this server. Use /recovery snapshot list.`);
        return Number(row.id);
    }
    /** Parse "3", "3,5,7", "2-6" or "all" into existing per-server numbers. */
    resolveNumbers(guildId: string, text: string, kinds?: 'backups'): number[] {
        const existing = this.store.all("SELECT s.number, COALESCE(m.kind,'snapshot') AS kind FROM snapshots s LEFT JOIN snapshot_metadata m ON m.snapshot_id=s.id WHERE s.guild_id=? ORDER BY s.number", guildId)
            .filter(r => !kinds || r.kind === 'backup').map(r => Number(r.number));
        const value = text.trim().toLowerCase().replace(/#/g, '');
        if (value === 'all') return existing;
        const wanted = new Set<number>();
        for (const part of value.split(/[\s,]+/).filter(Boolean)) {
            const range = /^(\d{1,7})-(\d{1,7})$/.exec(part), single = /^\d{1,7}$/.test(part);
            if (!range && !single)
                throw new AppError('VALIDATION_ERROR', 'Use numbers like 3, 3,5,7, 2-6 or all.');
            const [from, to] = range ? [Number(range[1]), Number(range[2])] : [Number(part), Number(part)];
            if (to < from || to - from > 500)
                throw new AppError('VALIDATION_ERROR', 'Use a range like 2-6 (at most 500 at once).');
            for (let n = from; n <= to; n++) wanted.add(n);
        }
        const found = existing.filter(n => wanted.has(n));
        const missing = [...wanted].filter(n => !existing.includes(n));
        if (!found.length)
            throw new AppError('VALIDATION_ERROR', `None of those recovery points exist in this server${kinds ? ' as backups' : ''}. Use /recovery snapshot list.`);
        if (missing.length && !range0(value))
            throw new AppError('VALIDATION_ERROR', `Not found${kinds ? ' as backups' : ''}: #${missing.slice(0, 10).join(', #')}. Use /recovery snapshot list.`);
        return found;
    }

    page(guildId: string, requested = 1, size = 8, onlyBackups = false) {
        this.store.assertAuthorized(guildId);
        if (!Number.isSafeInteger(requested) || requested < 1 || !Number.isSafeInteger(size) || size < 1 || size > 8)
            throw new AppError('VALIDATION_ERROR', 'Choose a valid snapshot page.');
        const filter = onlyBackups ? " AND COALESCE(m.kind,'snapshot')='backup'" : '';
        const total = Number(this.store.get(`SELECT COUNT(*) AS n FROM snapshots s LEFT JOIN snapshot_metadata m ON m.snapshot_id=s.id WHERE s.guild_id=?${filter}`, guildId)?.n ?? 0);
        const pages = Math.max(1, Math.ceil(total / size)), page = Math.min(requested, pages);
        const rows = this.store.all(`SELECT s.id,s.number,s.at,s.by_id,s.json,COALESCE(m.kind,'snapshot') AS kind,m.source_guild,m.purpose FROM snapshots s LEFT JOIN snapshot_metadata m ON m.snapshot_id=s.id AND m.guild_id=s.guild_id WHERE s.guild_id=?${filter} ORDER BY s.id DESC LIMIT ? OFFSET ?`, guildId, size, (page - 1) * size);
        const latest = this.store.get('SELECT MAX(id) AS id FROM snapshots WHERE guild_id=?', guildId)?.id;
        return { total, pages, page, rows: rows.map(row => {
                let roles: number | null = null, categories: number | null = null, channels: number | null = null;
                try {
                    const data = JSON.parse(row.json);
                    roles = data.roles.length;
                    categories = data.channels.filter((c: any) => c.type === ChannelType.GuildCategory).length;
                    channels = data.channels.length - categories!;
                } catch { /* Invalid older records can still be inspected/deleted. */ }
                return { id: Number(row.id), number: Number(row.number ?? row.id), label: recoveryLabel(String(row.kind), row.purpose ?? 'manual'), at: Number(row.at), actor: String(row.by_id), kind: String(row.kind), purpose: row.purpose ?? 'manual', source: row.source_guild, older: row.id !== latest, roles, categories, channels };
            }) };
    }

    /** Preview deleting one or more recovery points, by internal ID. The digest pins exactly what was reviewed. */
    deletionPreview(guildId: string, ids: number | number[]) {
        this.store.assertAuthorized(guildId);
        const list = (Array.isArray(ids) ? ids : [ids]);
        const rows = list.map(id => this.store.get("SELECT s.id,s.number,s.at,s.by_id,s.json,COALESCE(m.kind,'snapshot') AS kind,m.purpose FROM snapshots s LEFT JOIN snapshot_metadata m ON m.snapshot_id=s.id WHERE s.guild_id=? AND s.id=?", guildId, id));
        if (!rows.length || rows.some(r => !r))
            throw new AppError('VALIDATION_ERROR', 'Snapshot not found in this server.');
        const hash = createHash('sha256');
        for (const r of rows) hash.update(`${r!.id}:${r!.number}:`).update(r!.json);
        const first = rows[0]!;
        return { id: Number(first.id), number: Number(first.number ?? first.id), at: Number(first.at), actor: String(first.by_id), digest: hash.digest('hex'),
            items: rows.map(r => ({ id: Number(r!.id), number: Number(r!.number ?? r!.id), at: Number(r!.at), label: recoveryLabel(String(r!.kind), r!.purpose ?? 'manual') })) };
    }

    async delete(guildId: string, ids: number | number[], actor: string, expectedDigest: string) {
        return this.locks.run([guildId], async () => {
            const preview = this.deletionPreview(guildId, ids);
            if (preview.digest !== expectedDigest)
                throw new AppError('VALIDATION_ERROR', 'These recovery points changed after confirmation. Run the delete command again.');
            this.store.transaction(() => {
                for (const item of preview.items) {
                    this.store.run('DELETE FROM snapshots WHERE guild_id=? AND id=?', guildId, item.id);
                    this.audit(guildId, actor, 'snapshot_deleted', item.id, `Deleted ${item.label.toLowerCase()} #${item.number}. Server objects and mappings were preserved.`);
                }
            });
            const numbers = preview.items.map(item => `#${item.number}`).join(', ');
            return `${preview.items.length === 1 ? `Recovery point **${numbers}**` : `**${preview.items.length}** recovery points (${numbers.length > 300 ? numbers.slice(0, 300) + '…' : numbers})`} deleted. Server roles, categories, channels, and existing restore mappings were preserved.`;
        });
    }

    constructor(private store: Store, private delay = config.snapshotActionDelayMs) {
        this.locks = new RecoveryLocks(store);
    }

    async capture(guild: Guild): Promise<Snapshot> {
        this.store.assertAuthorized(guild.id);
        const [liveRoles, liveChannels] = await Promise.all([guild.roles.fetch(), guild.channels.fetch()]);
        // Full fetches add to discord.js caches but do not evict deleted objects.
        for (const id of guild.roles.cache.keys())
            if (!liveRoles.has(id))
                guild.roles.cache.delete(id);
        for (const [id, c] of guild.channels.cache)
            if (!c.isThread() && !liveChannels.has(id))
                guild.channels.cache.delete(id);
        const roles = liveRoles.map(r => ({ id: r.id, name: r.name, color: r.color, hoist: r.hoist,
            mentionable: r.mentionable, permissions: r.permissions.bitfield.toString(), position: r.rawPosition, managed: r.managed })).sort((a, b) => b.position - a.position || a.id.localeCompare(b.id));
        const channels: ChannelData[] = [], unsupported: string[] = [];
        for (const c of liveChannels.values()) {
            if (!c)
                continue;
            if (c.isThread())
                continue;
            if (!SUPPORTED.has(c.type)) {
                unsupported.push(`${c.id}:${c.name}`);
                continue;
            }
            const row: ChannelData = { id: c.id, name: c.name, type: c.type, parent: c.parentId,
                position: c.rawPosition, overwrites: c.permissionOverwrites.cache.map(o => ({ id: o.id, type: o.type, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() })).sort((a, b) => a.id.localeCompare(b.id)) };
            if ('topic' in c)
                row.topic = c.topic;
            if ('nsfw' in c)
                row.nsfw = c.nsfw;
            if ('rateLimitPerUser' in c && c.rateLimitPerUser !== null)
                row.rateLimitPerUser = c.rateLimitPerUser;
            if ('bitrate' in c)
                row.bitrate = c.bitrate;
            if ('userLimit' in c)
                row.userLimit = c.userLimit;
            if ('rtcRegion' in c)
                row.rtcRegion = c.rtcRegion;
            for (const key of ['defaultAutoArchiveDuration', 'defaultThreadRateLimitPerUser', 'defaultSortOrder', 'defaultForumLayout', 'defaultReactionEmoji', 'availableTags'] as const)
                if (key in c)
                    (row as any)[key] = structuredClone((c as any)[key]);
            channels.push(row);
        }
        channels.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
        unsupported.sort();
        return { version: 1, guildId: guild.id, name: guild.name, roles, channels, unsupported, roleMap: {}, channelMap: {}, settings: {
                afkTimeout: guild.afkTimeout, verificationLevel: guild.verificationLevel, explicitContentFilter: guild.explicitContentFilter,
                defaultMessageNotifications: guild.defaultMessageNotifications, preferredLocale: guild.preferredLocale,
                afkChannelId: guild.afkChannelId, systemChannelId: guild.systemChannelId, rulesChannelId: guild.rulesChannelId,
                publicUpdatesChannelId: guild.publicUpdatesChannelId
            } };
    }

    fingerprint(snapshot: Snapshot) {
        return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
    }

    async save(guild: Guild, actor: string, kind: 'snapshot' | 'backup' = 'snapshot', purpose: 'manual' | 'scheduled' | 'rollback' | 'baseline' = 'manual'): Promise<number> {
        const data = await this.capture(guild);
        this.validate(data, guild.id);
        const id = this.store.transaction(() => {
            const id = Number(this.store.run('INSERT INTO snapshots(guild_id,by_id,at,json) VALUES(?,?,?,?)', guild.id, actor, Date.now(), JSON.stringify(data)).lastInsertRowid);
            this.store.run('INSERT INTO snapshot_metadata(snapshot_id,guild_id,kind,purpose) VALUES(?,?,?,?)', id, guild.id, kind, purpose);
            this.load(guild.id, id);
            return id;
        });
        this.audit(guild.id, actor, kind === 'backup' ? 'backup_created' : 'snapshot_created', id, `Saved ${recoveryLabel(kind, purpose).toLowerCase()} #${this.numberOf(guild.id, id)}: ${data.roles.length} roles, ${data.channels.length} categories/channels; ${data.unsupported.length} unsupported channels skipped.`);
        return id;
    }

    load(guildId: string, id?: number): {
        id: number;
        data: Snapshot;
    } {
        const row = id ? this.store.get('SELECT * FROM snapshots WHERE guild_id=? AND id=?', guildId, id)
            : this.store.get('SELECT * FROM snapshots WHERE guild_id=? ORDER BY id DESC LIMIT 1', guildId);
        if (!row)
            throw new AppError('VALIDATION_ERROR', 'No snapshot found. Enable anti-nuke or run /recovery snapshot create first.');
        const data = JSON.parse(row.json) as Snapshot;
        if (data.version !== 1 || data.guildId !== guildId)
            throw new AppError('VALIDATION_ERROR', 'Snapshot version or server mismatch.');
        this.validate(data, guildId);
        return { id: row.id, data };
    }

    validate(data: Snapshot, guildId: string) {
        const fail = () => {
            throw new AppError('VALIDATION_ERROR', 'Invalid or unsupported snapshot. No server changes were made.');
        };
        if (!data || data.version !== 1 || data.guildId !== guildId || !Array.isArray(data.roles) || !Array.isArray(data.channels) || !Array.isArray(data.unsupported))
            fail();
        const ids = new Set<string>();
        for (const r of data.roles) {
            if (!r || typeof r.id !== 'string' || ids.has(r.id) || typeof r.name !== 'string' || !r.name || r.name.length > 100 || !/^\d+$/.test(r.permissions) || !Number.isInteger(r.position) || r.position < 0 || !Number.isInteger(r.color) || r.color < 0 || r.color > 0xffffff || typeof r.managed !== 'boolean' || typeof r.hoist !== 'boolean' || typeof r.mentionable !== 'boolean')
                fail();
            ids.add(r.id);
        }
        ids.clear();
        for (const c of data.channels) {
            if (!c || typeof c.id !== 'string' || ids.has(c.id) || typeof c.name !== 'string' || !c.name || c.name.length > 100 || !Number.isInteger(c.type) || !Number.isInteger(c.position) || c.position < 0 || !(c.parent === null || typeof c.parent === 'string') || !Array.isArray(c.overwrites))
                fail();
            for (const o of c.overwrites)
                if (!o || typeof o.id !== 'string' || ![0, 1].includes(o.type) || !/^\d+$/.test(o.allow) || !/^\d+$/.test(o.deny))
                    fail();
            ids.add(c.id);
        }
        if (data.channels.some(c => c.parent && !data.channels.some(p => p.id === c.parent && p.type === ChannelType.GuildCategory)))
            fail();
        if (data.settings) {
            const allowed = ['afkTimeout', 'verificationLevel', 'explicitContentFilter', 'defaultMessageNotifications', 'preferredLocale', 'afkChannelId', 'systemChannelId', 'rulesChannelId', 'publicUpdatesChannelId'];
            if (Object.keys(data.settings).some(k => !allowed.includes(k)))
                fail();
            for (const [key, value] of Object.entries(data.settings)) {
                if (key.endsWith('ChannelId')) {
                    if (value !== null && typeof value !== 'string')
                        fail();
                } else if (key === 'preferredLocale') {
                    if (typeof value !== 'string' || value.length > 20)
                        fail();
                } else if (!Number.isInteger(value) || Number(value) < 0)
                    fail();
            }
            if (![60, 300, 900, 1800, 3600].includes(data.settings.afkTimeout) || data.settings.verificationLevel > 4 || data.settings.explicitContentFilter > 2 || data.settings.defaultMessageNotifications > 1)
                fail();
        }
        data.roleMap ??= {};
        data.channelMap ??= {};
        for (const map of [data.roleMap, data.channelMap])
            if (!map || Array.isArray(map) || typeof map !== 'object' || Object.values(map).some(v => typeof v !== 'string'))
                fail();
    }

    private matches(guild: Guild, data: Snapshot) {
        const source = data.sourceGuildId ?? data.guildId;
        const roles: Record<string, string> = {}, channels: Record<string, string> = {};
        const blockedRoles = new Set<string>(), blockedChannels = new Set<string>(), skipped: string[] = [];
        const stored = this.store.all('SELECT kind,source_id,destination_id FROM recovery_mappings WHERE destination_guild=? AND source_guild=?', guild.id, source);
        const roleMappings = Object.fromEntries(stored.filter(r => r.kind === 'role').map(r => [r.source_id, r.destination_id]));
        const channelMappings = Object.fromEntries(stored.filter(r => r.kind === 'channel').map(r => [r.source_id, r.destination_id]));
        const usedRoles = new Set<string>(), usedChannels = new Set<string>();
        const roleSignature = (r: any) => JSON.stringify([r.name, r.color, r.hoist, r.mentionable, typeof r.permissions === 'string' ? r.permissions : r.permissions.bitfield.toString()]);
        for (const r of [...data.roles].sort((a, b) => b.position - a.position)) {
            if (r.id === source) {
                roles[r.id] = guild.id;
                usedRoles.add(guild.id);
                continue;
            }
            const id = roleMappings[r.id] ?? data.roleMap[r.id] ?? (source === guild.id ? r.id : undefined);
            let found = id ? guild.roles.cache.get(id) : undefined;
            if (found && (found.managed !== r.managed || found.id === guild.id)) {
                blockedRoles.add(r.id);
                skipped.push(`Mapped role type/management mismatch: ${r.name}`);
                continue;
            }
            if (r.managed) {
                if (source === guild.id && found?.managed)
                    roles[r.id] = found.id;
                blockedRoles.add(r.id);
                skipped.push(`Managed/integration/bot role: ${r.name}`);
                continue;
            }
            if (!found) {
                const candidates = [...guild.roles.cache.values()].filter(v => !v.managed && v.id !== guild.id && v.name === r.name);
                // Name alone is insufficient: require an exact property signature and a unique candidate.
                const snapshotDuplicates = data.roles.filter(v => !v.managed && roleSignature(v) === roleSignature(r)).length;
                if (candidates.length || snapshotDuplicates > 1) {
                    if (candidates.length === 1 && snapshotDuplicates === 1 && roleSignature(candidates[0]) === roleSignature(r))
                        found = candidates[0];
                    else {
                        blockedRoles.add(r.id);
                        skipped.push(`Ambiguous existing role: ${r.name}`);
                        continue;
                    }
                }
            }
            if (found) {
                if (usedRoles.has(found.id)) {
                    blockedRoles.add(r.id);
                    skipped.push(`Conflicting role mapping: ${r.name}`);
                    continue;
                }
                usedRoles.add(found.id);
                roles[r.id] = found.id;
                if (!found.editable) {
                    blockedRoles.add(r.id);
                    skipped.push(`Role cannot be managed below Vanguard's highest role: ${r.name}`);
                }
            }
        }
        for (const c of orderedChannels(data.channels)) {
            if (!SUPPORTED.has(c.type)) {
                blockedChannels.add(c.id);
                skipped.push(`Unsupported channel: ${c.name}`);
                continue;
            }
            if (c.parent && (blockedChannels.has(c.parent) || !channels[c.parent])) {
                // If the category is to be created, matching its children waits until the next matching pass.
                const parentNames = [...guild.channels.cache.values()].filter(v => !v.isThread() && v.type === ChannelType.GuildCategory && v.name === data.channels.find(p => p.id === c.parent)?.name);
                if (blockedChannels.has(c.parent) || parentNames.length) {
                    blockedChannels.add(c.id);
                    skipped.push(`Unresolved parent category: ${c.name}`);
                    continue;
                }
            }
            const id = channelMappings[c.id] ?? data.channelMap[c.id] ?? (source === guild.id ? c.id : undefined);
            let found = id ? guild.channels.cache.get(id) : undefined;
            if (found && (found.isThread() || found.type !== c.type)) {
                blockedChannels.add(c.id);
                skipped.push(`Mapped channel type mismatch: ${c.name}`);
                continue;
            }
            if (!found) {
                const candidates = [...guild.channels.cache.values()].filter(v => !v.isThread() && v.name === c.name && v.type === c.type);
                const expectedParent = c.parent ? channels[c.parent] : null;
                const matches = candidates.filter(v => v.parentId === expectedParent);
                const duplicates = data.channels.filter(v => v.name === c.name && v.type === c.type && v.parent === c.parent).length;
                if (candidates.length || duplicates > 1) {
                    if (matches.length === 1 && duplicates === 1)
                        found = matches[0];
                    else {
                        blockedChannels.add(c.id);
                        skipped.push(`Ambiguous existing channel/category: ${c.name}`);
                        continue;
                    }
                }
            }
            if (found) {
                if (usedChannels.has(found.id)) {
                    blockedChannels.add(c.id);
                    skipped.push(`Conflicting channel mapping: ${c.name}`);
                    continue;
                }
                usedChannels.add(found.id);
                channels[c.id] = found.id;
                if ('manageable' in found && !found.manageable) {
                    blockedChannels.add(c.id);
                    skipped.push(`Channel/category cannot be managed: ${c.name}`);
                }
            }
        }
        return { roles, channels, blockedRoles, blockedChannels, skipped };
    }

    async plan(guild: Guild, data: Snapshot, prune = false, components: Component[] = selectComponents()): Promise<Plan> {
        this.validate(data, guild.id);
        const live = await this.capture(guild), match = this.matches(guild, data);
        const p: Plan = { fingerprint: this.fingerprint(live), roleCreate: 0, roleUpdate: 0, channelCreate: 0, channelUpdate: 0, settingsUpdate: 0, roleUpdates: [], channelUpdates: [], roleDelete: [], channelDelete: [], skipped: [...data.unsupported.map(v => `Unsupported channel ${v}`), ...match.skipped], roleMap: match.roles, channelMap: match.channels, blockedRoles: [...match.blockedRoles], blockedChannels: [...match.blockedChannels] };
        for (const r of data.roles) {
            if (match.blockedRoles.has(r.id))
                continue;
            const current = guild.roles.cache.get(match.roles[r.id] ?? '');
            if (!current) {
                if (components.includes('roles'))
                    p.roleCreate++;
                continue;
            }
            const propsChanged = components.includes('roles') && current.id !== guild.id && JSON.stringify(roleProps(current)) !== JSON.stringify(roleProps(r));
            const permissionsChanged = components.includes('permissions') && current.permissions.bitfield.toString() !== r.permissions;
            if (propsChanged || permissionsChanged || components.includes('roles') && current.rawPosition !== r.position) {
                p.roleUpdate++;
                p.roleUpdates.push(current.id);
            }
        }
        for (const c of data.channels) {
            if (match.blockedChannels.has(c.id))
                continue;
            const selected = components.includes(c.type === ChannelType.GuildCategory ? 'categories' : 'channels');
            const current = guild.channels.cache.get(match.channels[c.id] ?? '');
            if (!current) {
                if (selected)
                    p.channelCreate++;
                continue;
            }
            if (current.isThread())
                continue;
            const changed = selected && (JSON.stringify(channelProps(current)) !== JSON.stringify(channelProps(c)) || current.parentId !== (c.parent ? match.channels[c.parent] : null) || current.rawPosition !== c.position);
            const overwriteChanged = components.includes('permissions') && overwriteKey(current.permissionOverwrites.cache.map(o => ({ id: o.id, type: o.type, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() }))) !== overwriteKey(c.overwrites.map(o => ({ ...o, id: o.type === OverwriteType.Role ? match.roles[o.id] ?? o.id : o.id })));
            if (changed || overwriteChanged) {
                p.channelUpdate++;
                p.channelUpdates.push(current.id);
            }
        }
        if (components.includes('settings') && data.settings) {
            for (const [key, value] of Object.entries(data.settings)) {
                const desired = key.endsWith('ChannelId') && value !== null ? match.channels[String(value)] : value;
                if (desired !== undefined && (guild as any)[key] !== desired)
                    p.settingsUpdate++;
            }
        }
        if (prune) {
            const settings = this.store.settings(guild.id), me = await guild.members.fetchMe();
            const knownRoles = new Set(Object.values(match.roles)), knownChannels = new Set(Object.values(match.channels));
            const log = settings.logChannelId ? guild.channels.cache.get(settings.logChannelId) : undefined;
            if (components.includes('roles'))
                for (const r of guild.roles.cache.values())
                    if (!knownRoles.has(r.id) && !data.roles.some(v => v.name === r.name) && !r.managed && r.id !== guild.id && r.editable && !me.roles.cache.has(r.id) && ![settings.quarantineRoleId, settings.verifiedRoleId].includes(r.id))
                        p.roleDelete.push(r.id);
            for (const c of guild.channels.cache.values())
                if (!c.isThread() && SUPPORTED.has(c.type) && components.includes(c.type === ChannelType.GuildCategory ? 'categories' : 'channels') && !knownChannels.has(c.id) && !data.channels.some(v => v.name === c.name) && c.id !== settings.logChannelId && c.id !== log?.parentId)
                    p.channelDelete.push(c.id);
        }
        return p;
    }

    async restore(guild: Guild, snapshotId: number, prune: boolean, expectedFingerprint: string, options: RestoreOptions = {}): Promise<string> {
        try {
            return await this.locks.run([guild.id], async (check) => {
                this.audit(guild.id, options.actor ?? 'recovery', 'restore_started', snapshotId, `Components: ${(options.components ?? selectComponents()).join(', ')}; prune: ${prune}`);
                return withRecoveryApi(guild.id, options.progress, () => this.performRestore(guild, snapshotId, prune, expectedFingerprint, options, check));
            });
        } catch (error) {
            this.audit(guild.id, options.actor ?? 'recovery', 'restore_failed', snapshotId, `Recovery aborted: ${error instanceof Error ? error.message : 'Unknown error'}`);
            throw error;
        }
    }

    async copy(source: Guild, destination: Guild, snapshotId: number, expectedFingerprint: string, options: RestoreOptions): Promise<string> {
        try {
            return await this.locks.run([source.id, destination.id], async (check) => {
                // Source authorization remains checked independently throughout the destination restore.
                check();
                const result = await this.store.withAuthorized(destination.id, async () => {
                    this.audit(destination.id, options.actor ?? 'recovery', 'layout_copy_started', snapshotId, `Source: ${source.id}; destination: ${destination.id}; components: ${(options.components ?? selectComponents()).join(', ')}`);
                    return withRecoveryApi(destination.id, options.progress, () => this.performRestore(destination, snapshotId, false, expectedFingerprint, options, check));
                });
                this.audit(source.id, options.actor ?? 'recovery', 'layout_copy_finished', snapshotId, `Layout copied from ${source.id} to ${destination.id}. Destination report:\n${result}`);
                return result;
            });
        } catch (error) {
            this.audit(destination.id, options.actor ?? 'recovery', 'layout_copy_failed', snapshotId, `Source: ${source.id}; recovery aborted: ${error instanceof Error ? error.message : 'Unknown error'}`);
            throw error;
        }
    }

    async prepareCopy(source: Guild, destination: Guild, actor: string) {
        this.store.assertAuthorized(source.id);
        const data = await this.capture(source);
        data.sourceGuildId = source.id;
        data.guildId = destination.id;
        data.roleMap = {};
        data.channelMap = {};
        return this.store.withAuthorized(destination.id, async () => {
            const id = Number(this.store.run('INSERT INTO snapshots(guild_id,by_id,at,json) VALUES(?,?,?,?)', destination.id, actor, Date.now(), JSON.stringify(data)).lastInsertRowid);
            this.store.run('INSERT INTO snapshot_metadata(snapshot_id,guild_id,kind,source_guild) VALUES(?,?,?,?)', id, destination.id, 'copy', source.id);
            this.audit(destination.id, actor, 'layout_copy_prepared', id, `Source: ${source.id}; destination: ${destination.id}. Awaiting user confirmation; no layout changes yet.`);
            return { id, data };
        });
    }

    private async performRestore(guild: Guild, snapshotId: number, prune: boolean, expectedFingerprint: string, options: RestoreOptions, checkLock: () => void): Promise<string> {
        const { data } = this.load(guild.id, snapshotId), components = options.components ?? selectComponents();
        const check = () => {
            checkLock();
            this.store.assertAuthorized(guild.id);
        };
        const pacer = new ActionPacer(this.delay, check);
        const counts = { Created: 0, Updated: 0, Reused: 0, Reordered: 0, Unchanged: 0, Skipped: 0, Failed: 0 };
        const details: string[] = [], touched = new Set<string>(), existing = new Set<string>();
        const progress = async (message: string) => {
            logEvent('recovery_progress', { guildId: guild.id, snapshotId, stage: message });
            try {
                await options.progress?.(message);
            } catch { /* Progress delivery must not abort recovery. */ }
        };
        await progress('Preparing restore...');
        const plan = await this.plan(guild, data, prune, components);
        if (plan.fingerprint !== expectedFingerprint)
            throw new AppError('VALIDATION_ERROR', 'The server changed after the preview. Run /recovery snapshot restore again to review a fresh plan.');
        check();
        const backup = await this.save(guild, options.actor ?? 'recovery', 'backup', 'rollback');
        // Backup is read back and validated before any mutation; failures abort recovery.
        this.load(guild.id, backup);
        const source = data.sourceGuildId ?? data.guildId;
        const saveMap = (kind: 'role' | 'channel', from: string, to: string) => {
            check();
            this.store.transaction(() => {
                this.store.run('DELETE FROM recovery_mappings WHERE destination_guild=? AND source_guild=? AND kind=? AND source_id=?', guild.id, source, kind, from);
                this.store.run('INSERT INTO recovery_mappings VALUES(?,?,?,?,?,?)', guild.id, source, kind, from, to, Date.now());
                (kind === 'role' ? data.roleMap : data.channelMap)[from] = to;
                this.store.run('UPDATE snapshots SET json=? WHERE guild_id=? AND id=?', JSON.stringify(data), guild.id, snapshotId);
            });
        };
        await progress('Matching existing objects...');
        const m = this.matches(guild, data);
        details.push(...plan.skipped);
        counts.Skipped = plan.skipped.length;
        data.roleMap = { ...m.roles };
        data.channelMap = { ...m.channels };
        for (const [from, to] of Object.entries(m.roles)) {
            saveMap('role', from, to);
            existing.add(`role:${to}`);
        }
        for (const [from, to] of Object.entries(m.channels)) {
            saveMap('channel', from, to);
            existing.add(`channel:${to}`);
        }
        const skipped = (message: string) => {
            counts.Skipped++;
            details.push(message);
        };
        const action = async (label: string, key: string, kind: 'Created' | 'Updated' | 'Reordered', fn: () => Promise<unknown>) => {
            check();
            try {
                logEvent('recovery_action', { guildId: guild.id, snapshotId, action: label, status: 'started' });
                await pacer.run(fn);
                counts[kind]++;
                touched.add(key);
                logEvent('recovery_action', { guildId: guild.id, snapshotId, action: label, status: 'finished' });
                return true;
            } catch (error: any) {
                check();
                if (isRecoveryLimit(error)) {
                    counts.Failed++;
                    const retryAt = new Date(Date.now() + waitMs(error)).toISOString();
                    const report = `Snapshot #${this.numberOf(guild.id, snapshotId)} recovery stopped at ${label}.\nBackup: #${this.numberOf(guild.id, backup)}.\nDiscord requires ${Math.ceil(waitMs(error) / 1000)} seconds; retry after ${retryAt}.\n${Object.entries(counts).map(([key, n]) => `${key}: ${n}`).join('\n')}\nCompleted changes and object mappings were saved. Run the restore again after Discord's wait; existing objects will be reused.\n${details.join('\n')}`;
                    this.store.run('INSERT INTO recovery_history(guild_id,source_guild,snapshot_id,actor_id,backup_id,at,report) VALUES(?,?,?,?,?,?,?)', guild.id, source, snapshotId, options.actor ?? 'recovery', backup, Date.now(), report);
                    this.audit(guild.id, options.actor ?? 'recovery', 'recovery_api_stopped', snapshotId, report);
                    await progress('Recovery stopped: Discord imposed a long API wait. Completed mappings saved; operation locks are being released.');
                    throw new AppError('RATE_LIMIT_ERROR', report, { cause: error });
                }
                logEvent('recovery_action_failed', { guildId: guild.id, snapshotId, action: label, message: error?.message });
                if ([50001, 50013, 50024].includes(error?.code))
                    skipped(`${label}: Discord denied access or management permissions.`);
                else {
                    counts.Failed++;
                    details.push(`${label}: ${error?.message ?? 'Discord action failed'}`);
                }
                return false;
            }
        };
        const reason = `Ghost Vanguard restore #${this.numberOf(guild.id, snapshotId)}; actor ${options.actor ?? 'recovery'}`;
        const roles = [...data.roles].sort((a, b) => b.position - a.position || a.id.localeCompare(b.id));
        const me = await guild.members.fetchMe();
        if (components.includes('roles')) {
            let done = 0;
            for (const r of roles) {
                await progress(`Restoring roles... ${++done}/${roles.length}`);
                if (m.blockedRoles.has(r.id) || r.id === source)
                    continue;
                let current = guild.roles.cache.get(data.roleMap[r.id] ?? '');
                if (!current) {
                    await action(`Create role ${r.name}`, `source-role:${r.id}`, 'Created', async () => {
                        // Create with no permissions; apply saved permissions in the permissions phase.
                        current = await guild.roles.create({ ...roleProps(r), permissions: 0n, reason });
                        saveMap('role', r.id, current.id);
                    });
                } else if (current.editable && JSON.stringify(roleProps(current)) !== JSON.stringify(roleProps(r))) {
                    await action(`Update role ${r.name}`, `role:${current.id}`, 'Updated', () => current!.edit({ ...roleProps(r), reason }));
                }
            }
            await progress('Restoring role hierarchy...');
            // Reserve fixed/managed slots and assign descending positions so clamping never reverses roles.
            const movable = roles.flatMap(r => {
                const current = guild.roles.cache.get(data.roleMap[r.id] ?? '');
                return r.id !== source && !m.blockedRoles.has(r.id) && current?.editable && !current.managed ? [{ r, current }] : [];
            });
            const fixed = new Set([...guild.roles.cache.values()].filter(r => !movable.some(v => v.current.id === r.id)).map(r => r.position));
            let ceiling = me.roles.highest.position - 1;
            const positions: {
                role: string;
                position: number;
            }[] = [];
            for (const { r, current } of movable) {
                let target = Math.min(r.position, ceiling);
                while (target > 0 && fixed.has(target))
                    target--;
                if (target < 1) {
                    skipped(`No valid hierarchy slot for role ${r.name}`);
                    continue;
                }
                ceiling = target - 1;
                if (target !== r.position)
                    details.push(`Role ${r.name}: original position ${r.position}; closest valid position ${target}.`);
                if (current.position !== target)
                    positions.push({ role: current.id, position: target });
            }
            if (positions.length)
                await action('Role hierarchy', 'role-hierarchy', 'Reordered', () => guild.roles.setPositions(positions));
        }
        const ordered = orderedChannels(data.channels);
        for (const phase of ['categories', 'channels'] as const) {
            if (!components.includes(phase))
                continue;
            const list = ordered.filter(c => (c.type === ChannelType.GuildCategory) === (phase === 'categories'));
            let done = 0;
            for (const c of list) {
                await progress(`Restoring ${phase}... ${++done}/${list.length}`);
                if (m.blockedChannels.has(c.id))
                    continue;
                if ([ChannelType.GuildForum, ChannelType.GuildMedia].includes(c.type) && !guild.features?.includes('COMMUNITY')) {
                    skipped(`Community-only forum/media channel cannot be restored: ${c.name}`);
                    continue;
                }
                const parent = c.parent ? data.channelMap[c.parent] : null;
                if (c.parent && (!parent || guild.channels.cache.get(parent)?.type !== ChannelType.GuildCategory)) {
                    skipped(`Missing category for ${c.name}; select Categories as well.`);
                    continue;
                }
                const current = guild.channels.cache.get(data.channelMap[c.id] ?? '');
                if (!current) {
                    await action(`Create ${c.name}`, `source-channel:${c.id}`, 'Created', async () => {
                        // New channels start private until their saved overwrite set is applied.
                        const created = await guild.channels.create({ ...channelProps(c), type: c.type, parent, permissionOverwrites: [{ id: guild.id, deny: ['ViewChannel'] }, { id: me.id, allow: ['ViewChannel', 'ManageChannels'] }], reason } as GuildChannelCreateOptions);
                        saveMap('channel', c.id, created.id);
                    });
                } else if (!current.isThread() && (JSON.stringify(channelProps(current)) !== JSON.stringify(channelProps(c)) || current.parentId !== parent)) {
                    if (c.availableTags && 'availableTags' in current && c.availableTags.some(t => (current as any).availableTags.filter((v: any) => v.name === t.name).length > 1)) {
                        skipped(`Ambiguous forum/media tags on ${c.name}; channel settings preserved.`);
                        continue;
                    }
                    await action(`Update ${c.name}`, `channel:${current.id}`, 'Updated', () => current.edit({ ...channelProps(c, current), parent, reason }));
                }
            }
        }
        await progress('Reordering server layout...');
        const channelPositions = ordered.flatMap(c => {
            if (!components.includes(c.type === ChannelType.GuildCategory ? 'categories' : 'channels') || m.blockedChannels.has(c.id))
                return [];
            const current = guild.channels.cache.get(data.channelMap[c.id] ?? '');
            return current && !current.isThread() && current.rawPosition !== c.position ? [{ channel: current.id, position: c.position }] : [];
        });
        if (channelPositions.length)
            await action('Category/channel order', 'channel-order', 'Reordered', () => guild.channels.setPositions(channelPositions));
        await progress('Applying permissions...');
        if (components.includes('permissions')) {
            for (const r of roles) {
                if (m.blockedRoles.has(r.id))
                    continue;
                const current = guild.roles.cache.get(data.roleMap[r.id] ?? '');
                if (!current) {
                    skipped(`Missing role for permissions: ${r.name}`);
                    continue;
                }
                if (current.permissions.bitfield.toString() !== r.permissions && (current.id === guild.id || current.editable))
                    await action(`Role permissions ${r.name}`, `role:${current.id}`, 'Updated', () => current.edit({ permissions: BigInt(r.permissions), reason }));
            }
            for (const c of ordered) {
                if (m.blockedChannels.has(c.id))
                    continue;
                const current = guild.channels.cache.get(data.channelMap[c.id] ?? '');
                if (!current || current.isThread()) {
                    skipped(`Missing channel for permissions: ${c.name}`);
                    continue;
                }
                const overwrites: ReturnType<typeof remapOverwrites> = [];
                let unresolved = false;
                for (const o of c.overwrites) {
                    const id = o.type === OverwriteType.Role ? data.roleMap[o.id] : o.id;
                    if (!id || o.type === OverwriteType.Role && !guild.roles.cache.has(id)) {
                        skipped(`Unresolved overwrite role ${o.id} on ${c.name}`);
                        unresolved = true;
                        continue;
                    }
                    if (o.type === OverwriteType.Member && !await pacer.run(() => guild.members.fetch(id)).catch(() => null)) {
                        skipped(`Missing overwrite member ${id} on ${c.name}`);
                        unresolved = true;
                        continue;
                    }
                    overwrites.push({ id, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) });
                }
                if (unresolved) {
                    skipped(`Permissions unchanged for ${c.name}: overwrite subjects could not be resolved safely.`);
                    continue;
                }
                const live = current.permissionOverwrites.cache.map(o => ({ id: o.id, type: o.type, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() }));
                if (overwriteKey(live) !== overwriteKey(overwrites))
                    await action(`Channel permissions ${c.name}`, `channel:${current.id}`, 'Updated', () => current.permissionOverwrites.set(overwrites, reason));
            }
        } else if (counts.Created && (components.includes('channels') || components.includes('categories'))) {
            details.push('New channels/categories were created private because Permissions was not selected.');
        }
        await progress('Restoring settings...');
        if (components.includes('settings')) {
            if (!data.settings)
                skipped('This older snapshot does not contain supported guild settings.');
            else if (!me.permissions?.has('ManageGuild'))
                skipped('Guild settings require Manage Server permission.');
            else {
                const settings: Record<string, unknown> = {};
                for (const [key, value] of Object.entries(data.settings)) {
                    if (key.endsWith('ChannelId')) {
                        const mappedId = value === null ? null : data.channelMap[String(value)];
                        if (value !== null && (!mappedId || !guild.channels.cache.has(mappedId))) {
                            skipped(`Unresolved setting ${key}`);
                            continue;
                        }
                        const apiKey = key.replace(/Id$/, '');
                        if ((guild as any)[key] !== mappedId)
                            settings[apiKey] = mappedId;
                    } else if ((guild as any)[key] !== value)
                        settings[key] = value;
                }
                if (Object.keys(settings).length)
                    await action('Guild settings', 'settings', 'Updated', () => guild.edit({ ...settings, reason } as GuildEditOptions));
            }
        }
        // Retain the existing explicit prune option; do not prune after any skipped or failed object.
        if (prune) {
            if (counts.Failed || counts.Skipped)
                skipped('Deletion of extras withheld because restoration had skipped objects or failures.');
            else {
                for (const id of plan.channelDelete)
                    await action(`Delete extra channel ${id}`, `channel:${id}`, 'Updated', async () => {
                        await guild.channels.cache.get(id)?.delete(reason);
                    });
                for (const id of plan.roleDelete) {
                    // A blacklisted role is never pruned: it is protected from deletion on purpose.
                    if (isBlacklisted(this.store, guild.id, id)) { skipped(`Kept blacklisted role ${id}.`); continue; }
                    await action(`Delete extra role ${id}`, `role:${id}`, 'Updated', async () => {
                        await guild.roles.cache.get(id)?.delete(reason);
                    });
                }
            }
        }
        await progress('Verifying restore...');
        // Fresh fetches verify Discord's actual layout rather than trusting local mutation results.
        const final = await this.plan(guild, data, false, components);
        const differences = final.roleCreate + final.roleUpdate + final.channelCreate + final.channelUpdate + final.settingsUpdate;
        for (const key of existing) {
            const [kind, id] = key.split(':');
            const selected = kind === 'role' ? components.includes('roles') || components.includes('permissions') : components.includes('permissions') || components.includes(guild.channels.cache.get(id!)?.type === ChannelType.GuildCategory ? 'categories' : 'channels');
            if (selected) {
                counts.Reused++;
                if (!touched.has(key))
                    counts.Unchanged++;
            }
        }
        for (const [from, to] of Object.entries(data.roleMap))
            saveMap('role', from, to);
        for (const [from, to] of Object.entries(data.channelMap))
            saveMap('channel', from, to);
        if (source === guild.id) {
            const settings = this.store.settings(guild.id);
            let changed = false;
            for (const key of ['verifiedRoleId', 'quarantineRoleId'] as const) {
                const old = settings[key], replacement = old ? data.roleMap[old] : undefined;
                if (replacement && replacement !== old) {
                    settings[key] = replacement;
                    changed = true;
                }
            }
            const log = settings.logChannelId ? data.channelMap[settings.logChannelId] : undefined;
            if (log && log !== settings.logChannelId) {
                settings.logChannelId = log;
                changed = true;
            }
            if (changed)
                this.store.save(settings);
        }
        for (const id of final.roleUpdates) {
            const current = guild.roles.cache.get(id);
            details.push(`Verification: role ${current?.name ?? id} still differs from the snapshot (position ${current?.position ?? 'unknown'}).`);
        }
        for (const id of final.channelUpdates)
            details.push(`Verification: channel/category ${guild.channels.cache.get(id)?.name ?? id} still differs from the snapshot.`);
        const report = `Snapshot #${this.numberOf(guild.id, snapshotId)} restoration ${counts.Failed || differences || counts.Skipped ? 'finished with items to review' : 'complete'}.\n**Backup:** #${backup}\n**Components:** ${components.join(', ')}\n${Object.entries(counts).map(([key, n]) => `**${key}:** ${n}`).join('\n')}\n**Failures:** ${counts.Failed}\n**Remaining structural differences:** ${differences}\n${details.join('\n') || 'No reported failures or skipped objects.'}`;
        this.audit(guild.id, options.actor ?? 'recovery', data.sourceGuildId ? 'layout_copy_finished' : 'restore_finished', snapshotId, report);
        this.store.run('INSERT INTO recovery_history(guild_id,source_guild,snapshot_id,actor_id,backup_id,at,report) VALUES(?,?,?,?,?,?,?)', guild.id, source, snapshotId, options.actor ?? 'recovery', backup, Date.now(), report);
        await progress(counts.Failed || differences || counts.Skipped ? 'Restore finished with items to review.' : 'Restore complete.');
        return report;
    }
}

export interface RestoreOptions {
    components?: Component[];
    actor?: string;
    progress?: (message: string) => Promise<void>;
}

export function orderedChannels(channels: ChannelData[]) {
    const categories = channels.filter(c => c.type === ChannelType.GuildCategory).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    const rank = new Map(categories.map((c, i) => [c.id, i]));
    const other = channels.filter(c => c.type !== ChannelType.GuildCategory).sort((a, b) => (a.parent ? rank.get(a.parent) ?? 9999 : -1) - (b.parent ? rank.get(b.parent) ?? 9999 : -1) || a.position - b.position || a.id.localeCompare(b.id));
    return [...categories, ...other];
}

function roleProps(r: {
    name: string;
    color: number;
    hoist: boolean;
    mentionable: boolean;
}) {
    return { name: r.name, colors: { primaryColor: r.color }, hoist: r.hoist, mentionable: r.mentionable };
}

function channelProps(c: any, current?: any) {
    const props: any = { name: c.name };
    for (const key of ['topic', 'nsfw', 'rateLimitPerUser', 'bitrate', 'userLimit', 'rtcRegion', 'defaultAutoArchiveDuration', 'defaultThreadRateLimitPerUser', 'defaultSortOrder', 'defaultForumLayout', 'defaultReactionEmoji'])
        if (c[key] !== undefined)
            props[key] = c[key];
    if (c.availableTags)
        props.availableTags = c.availableTags.map((tag: any) => {
            const existing = current?.availableTags?.filter((v: any) => v.name === tag.name) ?? [];
            return { ...(existing.length === 1 ? { id: existing[0].id } : {}), name: tag.name, moderated: tag.moderated, emoji: tag.emoji };
        });
    return props;
}

function overwriteKey(items: {
    id: string;
    type: number;
    allow: string | bigint;
    deny: string | bigint;
}[]) {
    return JSON.stringify(items.map(o => [o.id, o.type, String(o.allow), String(o.deny)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}
