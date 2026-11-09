import { AuditLogEvent, ChannelType } from 'discord.js';
import { configuredLogIds, findLogCategory, pacing, ROUTE_CHANNEL_NAMES } from './log-setup.js';
/**
 * The IDs of channels this bot created, from the audit log (Discord keeps 45 days, and the bot's 100 newest
 * creations are asked for). A permission overwrite proves nothing, since anyone can add one. `null` when the
 * audit log cannot be read.
 */
async function createdByVanguard(guild) {
    const me = guild.client.user?.id;
    if (!me)
        return null;
    try {
        const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.ChannelCreate, user: me, limit: 100 });
        return new Set([...logs.entries.values()].filter(e => e.executorId === me && !!e.targetId).map(e => e.targetId));
    }
    catch {
        return null;
    }
}
const sameNameAs = (guild, channel, parentId) => [...guild.channels.cache.values()].filter((c) => c.type === ChannelType.GuildText && c.parentId === parentId && c.name === channel.name && c.id !== channel.id);
/** What a cleanup would delete and what it would leave. Changes nothing. */
export async function duplicatePlan(store, guild) {
    const plan = { remove: [], keep: [] };
    const category = findLogCategory(guild);
    if (!category)
        return plan;
    const configured = configuredLogIds(store, guild.id);
    const groups = new Map();
    for (const c of guild.channels.cache.values()) {
        if (c.type !== ChannelType.GuildText || c.parentId !== category.id || !ROUTE_CHANNEL_NAMES.has(c.name))
            continue;
        groups.set(c.name, [...(groups.get(c.name) ?? []), c]);
    }
    let made;
    for (const [name, channels] of groups) {
        if (channels.length < 2)
            continue;
        const used = channels.filter(c => configured.has(c.id));
        for (const c of channels.filter(c => !configured.has(c.id))) {
            if (!used.length) {
                plan.keep.push({ id: c.id, name, why: 'Vanguard is not logging to any channel with this name yet. Run `/setup logs setup` so it picks one, then run this again.' });
                continue;
            }
            made ??= await createdByVanguard(guild);
            if (!made)
                plan.keep.push({ id: c.id, name, why: 'Vanguard could not read the audit log to confirm it made this channel. It needs View Audit Log.' });
            else if (!made.has(c.id))
                plan.keep.push({ id: c.id, name, why: 'Vanguard cannot show that it made this channel, so it may belong to another bot or to staff.' });
            else
                plan.remove.push({ id: c.id, name, keeper: used[0].id, empty: !c.lastMessageId });
        }
    }
    return plan;
}
/**
 * Delete what the confirmed plan lists, checking each channel again first: it must still be in the log
 * category, still unused, still next to a twin that is used, and still provably Vanguard's.
 */
export async function deleteDuplicates(guild, store, plan, by) {
    await guild.channels.fetch();
    const made = await createdByVanguard(guild);
    const category = findLogCategory(guild);
    const reason = `Ghost Vanguard duplicate log cleanup by ${by}`;
    let deleted = 0, skipped = 0, failed = 0, first = true;
    for (const planned of plan.remove) {
        store.assertAuthorized(guild.id);
        const channel = guild.channels.cache.get(planned.id);
        const configured = configuredLogIds(store, guild.id);
        const safe = !!made && !!category && channel?.type === ChannelType.GuildText && channel.parentId === category.id && !configured.has(channel.id)
            && made.has(channel.id) && sameNameAs(guild, channel, category.id).some(twin => configured.has(twin.id));
        if (!safe || !channel) {
            skipped++;
            continue;
        }
        // Discord rate limits writes to a server, so deletions are paced like setup's changes.
        if (!first)
            await pacing.sleep(pacing.pauseMs);
        first = false;
        store.assertAuthorized(guild.id);
        try {
            await channel.delete(reason);
            deleted++;
        }
        catch {
            failed++;
        }
    }
    return `Duplicate cleanup: **${deleted} deleted**, **${skipped} skipped**, **${failed} failed**. Deleted message history cannot be recovered.`;
}
