import { ChannelType } from 'discord.js';
import { ARCHIVED_LOG_CATEGORY, logChannels } from './log-setup.js';
import { eventLogConfig } from './event-log.js';
function activeIds(store, guild) {
    const saved = logChannels(store, guild);
    return new Set([saved.bansChannelId, eventLogConfig(store, guild).channelId,
        store.settings(guild).logChannelId, ...Object.values(saved.routes ?? {})].filter(Boolean));
}
/** Snapshot only the bot's branded archive. Confirmation never expands this set. */
export function archivePlan(guild, store) {
    const active = activeIds(store, guild.id);
    const categories = [...guild.channels.cache.values()].filter(c => c.type === ChannelType.GuildCategory && c.name === ARCHIVED_LOG_CATEGORY);
    const parents = new Set(categories.map(c => c.id));
    const channels = [...guild.channels.cache.values()].filter(c => c.parentId && parents.has(c.parentId) && !active.has(c.id));
    return { categories: categories.map(c => c.id), channels: channels.map(c => ({ id: c.id, parent: c.parentId })) };
}
export async function deleteArchive(guild, store, plan, by) {
    await guild.channels.fetch();
    let deleted = 0, skipped = 0, failed = 0;
    const reason = `Ghost Vanguard archive cleanup by ${by}`;
    for (const saved of plan.channels) {
        store.assertAuthorized(guild.id);
        const channel = guild.channels.cache.get(saved.id);
        const parent = guild.channels.cache.get(saved.parent);
        if (!channel || channel.parentId !== saved.parent || parent?.name !== ARCHIVED_LOG_CATEGORY || activeIds(store, guild.id).has(saved.id)) {
            skipped++;
            continue;
        }
        try {
            await channel.delete(reason);
            deleted++;
        }
        catch {
            failed++;
        }
    }
    for (const id of plan.categories) {
        store.assertAuthorized(guild.id);
        // Fetch again: a channel added after the preview must keep its category.
        await guild.channels.fetch();
        const category = guild.channels.cache.get(id);
        if (!category || category.type !== ChannelType.GuildCategory || category.name !== ARCHIVED_LOG_CATEGORY || guild.channels.cache.some(c => c.parentId === id)) {
            skipped++;
            continue;
        }
        try {
            await category.delete(reason);
            deleted++;
        }
        catch {
            failed++;
        }
    }
    return `Archive cleanup: **${deleted} deleted**, **${skipped} skipped**, **${failed} failed**. Deleted message history cannot be recovered.`;
}
