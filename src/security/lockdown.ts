import { ChannelType, Colors, PermissionFlagsBits, type Guild } from 'discord.js';
import type { Store } from '../database/db.js';
import { AppError } from '../errors.js';
import type { LogQueue } from '../logging.js';
import { embed } from '../ui/ui.js';

const P = PermissionFlagsBits;
const bits = (...flags: bigint[]) => flags.reduce((all, flag) => all | BigInt(flag), 0n);
/** What a lockdown removes in text-style channels: posting, threads and reactions. */
export const TEXT_LOCK = bits(P.SendMessages, P.SendMessagesInThreads, P.CreatePublicThreads, P.CreatePrivateThreads, P.AddReactions);
/** What a lockdown removes in voice and stage channels: joining, speaking and their text chat. */
export const VOICE_LOCK = bits(P.Connect, P.Speak, P.SendMessages, P.AddReactions);
/** Roles and members with any of these keep their access during a lockdown. */
const STAFF = bits(P.Administrator, P.ManageGuild, P.ManageChannels, P.ManageMessages, P.ModerateMembers);
const TEXT_TYPES = new Set<number>([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia]);
const VOICE_TYPES = new Set<number>([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);
/** Channels that can show the lockdown notice as an ordinary message. */
const NOTICE_TYPES = new Set<number>([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
export const lockMask = (type: number) => TEXT_TYPES.has(type) ? TEXT_LOCK : VOICE_TYPES.has(type) ? VOICE_LOCK : 0n;

export interface Overwrite {
    id: string;
    type: number;
    allow: bigint;
    deny: bigint;
}

/** The original state of exactly the bits a lockdown changed on one overwrite. */
export interface LockRecord {
    targetId: string;
    type: number;
    existed: boolean;
    allow: bigint;
    deny: bigint;
    bits: bigint;
}

/**
 * Lock one channel's overwrites: @everyone is denied the locked permissions, and any other
 * role or member overwrite that grants them back has that grant removed, except staff
 * (see STAFF) and the bot. Returns the new overwrites and what to remember for unlocking.
 */
export function planLock(current: Overwrite[], everyoneId: string, mask: bigint, exempt: (o: Overwrite) => boolean) {
    const next = current.map(o => ({ ...o }));
    const records: LockRecord[] = [];
    let everyone = next.find(o => o.id === everyoneId);
    const existed = !!everyone;
    if (!everyone) {
        everyone = { id: everyoneId, type: 0, allow: 0n, deny: 0n };
        next.push(everyone);
    }
    records.push({ targetId: everyoneId, type: 0, existed, allow: everyone.allow & mask, deny: everyone.deny & mask, bits: mask });
    everyone.allow &= ~mask;
    everyone.deny |= mask;
    for (const o of next) {
        const granted = o.allow & mask;
        if (o.id === everyoneId || !granted || exempt(o))
            continue;
        records.push({ targetId: o.id, type: o.type, existed: true, allow: granted, deny: o.deny & granted, bits: granted });
        o.allow &= ~granted;
    }
    return { next, records };
}

/**
 * Undo a lockdown on one channel: put back exactly the bits it changed, keep every other
 * permission edit made since, and remove an @everyone overwrite the lockdown had to create.
 */
export function planUnlock(current: Overwrite[], records: LockRecord[]): Overwrite[] {
    let next = current.map(o => ({ ...o }));
    for (const record of records) {
        const o = next.find(x => x.id === record.targetId);
        if (!o)
            continue; // Removed by staff during the lockdown; nothing of ours is left on it.
        o.allow = (o.allow & ~record.bits) | (record.allow & record.bits);
        o.deny = (o.deny & ~record.bits) | (record.deny & record.bits);
        if (!record.existed && o.allow === 0n && o.deny === 0n)
            next = next.filter(x => x !== o);
    }
    return next;
}

const same = (a: Overwrite[], b: Overwrite[]) => a.length === b.length && a.every(x => b.some(y => y.id === x.id && y.allow === x.allow && y.deny === x.deny));
const read = (channel: any): Overwrite[] => [...channel.permissionOverwrites.cache.values()].map((o: any) => ({ id: o.id, type: o.type, allow: BigInt(o.allow.bitfield), deny: BigInt(o.deny.bitfield) }));
const write = (channel: any, list: Overwrite[], reason: string) => channel.permissionOverwrites.set(list.map(o => ({ id: o.id, type: o.type, allow: o.allow.toString(), deny: o.deny.toString() })), reason);

function exemptFor(guild: Guild) {
    const botId = guild.members.me?.id ?? guild.client.user?.id;
    const botRole = guild.members.me?.roles?.botRole?.id;
    return (o: Overwrite) => {
        if (o.type === 1) {
            if (o.id === botId || o.id === guild.ownerId)
                return true;
            const member = guild.members.cache.get(o.id);
            return !!member && (BigInt(member.permissions.bitfield) & STAFF) !== 0n;
        }
        if (o.id === botRole)
            return true;
        const role = guild.roles.cache.get(o.id);
        return !!role && (BigInt(role.permissions.bitfield) & STAFF) !== 0n;
    };
}

const canManage = (guild: Guild, channel: any) => {
    const me = guild.members.me;
    return !me || !!channel.permissionsFor?.(me)?.has([P.ViewChannel, P.ManageChannels, P.ManageRoles]);
};

const isPublic = (guild: Guild, channel: any) => channel.permissionsFor?.(guild.roles.everyone)?.has(P.ViewChannel) ?? true;

const canPost = (guild: Guild, channel: any) => {
    const me = guild.members.me;
    return !me || !!channel.permissionsFor?.(me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks]);
};

export interface LockdownContext {
    store: Store;
    logs: LogQueue;
}

export function lockdownState(store: Store, guildId: string) {
    return store.get('SELECT * FROM lockdowns WHERE guild_id=?', guildId) ?? null;
}

/** Lock every text, voice and forum channel, posting `notice` in public text channels first. */
export async function lockGuild(ctx: LockdownContext, guild: Guild, actorId: string, notice: string, reason: string, progress?: (done: number, total: number) => Promise<void>) {
    const { store } = ctx;
    const active = lockdownState(store, guild.id);
    if (active)
        throw new AppError('VALIDATION_ERROR', `This server has been in lockdown since <t:${Math.floor(active.started_at / 1000)}:R>. Use /raid unlock first.`);
    const channels = [...guild.channels.cache.values()].filter((c: any) => lockMask(c.type) !== 0n)
        .sort((a: any, b: any) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0));
    // Recorded first, so /raid unlock works even if the bot stops partway through.
    store.run('INSERT INTO lockdowns(guild_id,started_by,started_at,reason,message) VALUES(?,?,?,?,?)', guild.id, actorId, Date.now(), reason, notice);
    const auditReason = `Ghost Vanguard lockdown by ${actorId}: ${reason}`.slice(0, 500);
    const exempt = exemptFor(guild);
    const result = { locked: 0, notices: 0, skipped: 0, failed: 0, total: channels.length };
    for (const [index, channel] of channels.entries() as IterableIterator<[number, any]>) {
        if (!canManage(guild, channel)) {
            result.skipped++;
            continue;
        }
        const current = read(channel);
        const { next, records } = planLock(current, guild.id, lockMask(channel.type), exempt);
        store.transaction(() => {
            for (const r of records)
                store.run('INSERT OR IGNORE INTO lockdown_overwrites(guild_id,channel_id,target_id,target_type,existed,allow,deny,bits) VALUES(?,?,?,?,?,?,?,?)', guild.id, channel.id, r.targetId, r.type, r.existed ? 1 : 0, r.allow.toString(), r.deny.toString(), r.bits.toString());
        });
        try {
            if (notice && NOTICE_TYPES.has(channel.type) && isPublic(guild, channel) && canPost(guild, channel)) {
                const sent = await channel.send({ embeds: [embed('🔒 This channel is locked', notice, Colors.Red)], allowedMentions: { parse: [] } }).catch(() => null);
                if (sent) {
                    store.run('INSERT OR REPLACE INTO lockdown_notices(guild_id,channel_id,message_id) VALUES(?,?,?)', guild.id, channel.id, sent.id);
                    result.notices++;
                }
            }
            if (!same(current, next))
                await write(channel, next, auditReason);
            result.locked++;
        } catch {
            // Nothing changed on this channel, so there is nothing to restore later.
            store.run('DELETE FROM lockdown_overwrites WHERE guild_id=? AND channel_id=?', guild.id, channel.id);
            result.failed++;
        }
        if (progress && (index + 1) % 10 === 0)
            await progress(index + 1, channels.length).catch(() => { });
    }
    store.run('UPDATE lockdowns SET channel_count=? WHERE guild_id=?', result.locked, guild.id);
    return result;
}

/** Restore every locked channel exactly, optionally remove the notices and post `message`. */
export async function unlockGuild(ctx: LockdownContext, guild: Guild, actorId: string, message: string | null, removeNotices: boolean, progress?: (done: number, total: number) => Promise<void>) {
    const { store } = ctx;
    if (!lockdownState(store, guild.id))
        throw new AppError('VALIDATION_ERROR', 'This server is not in lockdown.');
    const rows = store.all('SELECT * FROM lockdown_overwrites WHERE guild_id=? ORDER BY channel_id', guild.id);
    const byChannel = new Map<string, LockRecord[]>();
    for (const r of rows)
        byChannel.set(r.channel_id, [...(byChannel.get(r.channel_id) ?? []), { targetId: r.target_id, type: Number(r.target_type), existed: !!r.existed, allow: BigInt(r.allow), deny: BigInt(r.deny), bits: BigInt(r.bits) }]);
    const auditReason = `Ghost Vanguard lockdown lifted by ${actorId}`;
    const result = { restored: 0, missing: 0, failed: 0, noticesRemoved: 0, messages: 0, total: byChannel.size };
    let done = 0;
    for (const [channelId, records] of byChannel) {
        const channel: any = guild.channels.cache.get(channelId);
        if (!channel)
            result.missing++;
        else {
            try {
                const current = read(channel);
                const next = planUnlock(current, records);
                if (!same(current, next))
                    await write(channel, next, auditReason);
                result.restored++;
            } catch {
                result.failed++;
                continue; // Keep the records so /raid unlock can be run again.
            }
        }
        store.run('DELETE FROM lockdown_overwrites WHERE guild_id=? AND channel_id=?', guild.id, channelId);
        if (progress && ++done % 10 === 0)
            await progress(done, byChannel.size).catch(() => { });
    }
    const notices = store.all('SELECT * FROM lockdown_notices WHERE guild_id=?', guild.id);
    for (const n of notices) {
        const channel: any = guild.channels.cache.get(n.channel_id);
        if (!channel)
            continue;
        if (removeNotices && await channel.messages?.delete(n.message_id).then(() => true, () => false))
            result.noticesRemoved++;
        if (message && await channel.send({ embeds: [embed('🔓 This channel is unlocked', message, Colors.Green)], allowedMentions: { parse: [] } }).then(() => true, () => false))
            result.messages++;
    }
    if (!result.failed) {
        store.run('DELETE FROM lockdown_notices WHERE guild_id=?', guild.id);
        store.run('DELETE FROM lockdowns WHERE guild_id=?', guild.id);
    }
    return result;
}
