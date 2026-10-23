import { randomUUID } from 'node:crypto';
import { logEvent } from '../errors.js';
/**
 * How long comma commands (`,restart`, `,help`…) and the bot's replies stay before they are deleted.
 * COMMA_DELETE_SECONDS in .env: default 60; `0` keeps them (never deleted). Deleting keeps developer
 * commands out of public channels.
 */
export const DEFAULT_PREFIX_DELETE_SECONDS = 60;
export function prefixDeleteDelayMs() {
    const raw = process.env.COMMA_DELETE_SECONDS?.trim();
    const seconds = raw === undefined || raw === '' ? DEFAULT_PREFIX_DELETE_SECONDS : Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 86_400) * 1000 : DEFAULT_PREFIX_DELETE_SECONDS * 1000;
}
const RETRY_DELETE_MS = 30_000;
/** Save a deletion job before scheduling it, so it survives a bot restart. */
export function schedulePrefixMessageDeletion(client, store, channelId, messageId, deleteAt = Date.now() + prefixDeleteDelayMs()) {
    // COMMA_DELETE_SECONDS=0: keep comma commands and replies.
    if (prefixDeleteDelayMs() === 0)
        return null;
    const id = randomUUID();
    store.run('INSERT INTO prefix_message_cleanup(id,channel_id,message_id,delete_at) VALUES(?,?,?,?)', id, channelId, messageId, deleteAt);
    arm(client, store, id, deleteAt);
    return id;
}
/** Restore outstanding auto-delete timers after a process restart. */
export function restorePrefixMessageDeletions(client, store) {
    const jobs = store.all('SELECT id,delete_at FROM prefix_message_cleanup');
    for (const job of jobs)
        arm(client, store, String(job.id), Number(job.delete_at));
    return jobs.length;
}
function arm(client, store, id, deleteAt) {
    const delay = Math.max(0, Math.min(deleteAt - Date.now(), 2_147_000_000));
    const timer = setTimeout(() => {
        void deleteMessage(client, store, id).catch(error => {
            logEvent('prefix_message_delete_failure', { error: error instanceof Error ? error.message : String(error) });
        });
    }, delay);
    timer.unref?.();
}
async function deleteMessage(client, store, id) {
    const job = store.get('SELECT channel_id,message_id,delete_at FROM prefix_message_cleanup WHERE id=?', id);
    if (!job)
        return;
    const deleteAt = Number(job.delete_at);
    if (deleteAt > Date.now()) {
        arm(client, store, id, deleteAt);
        return;
    }
    try {
        const channel = await client.channels.fetch(String(job.channel_id));
        if (!channel?.isTextBased?.() || !channel.messages?.fetch) {
            logEvent('prefix_message_delete_failure', { reason: 'channel unavailable or not text-based', channelId: String(job.channel_id) });
            store.run('DELETE FROM prefix_message_cleanup WHERE id=?', id);
            return;
        }
        const message = await channel.messages.fetch(String(job.message_id));
        await message.delete();
        store.run('DELETE FROM prefix_message_cleanup WHERE id=?', id);
    }
    catch (error) {
        const code = Number(error?.code);
        const status = Number(error?.status);
        // Missing messages/channels and permission failures cannot be repaired by retrying.
        if ([10003, 10008, 50001, 50013].includes(code) || [403, 404].includes(status)) {
            logEvent('prefix_message_delete_failure', { code, status, reason: error instanceof Error ? error.message : String(error) });
            store.run('DELETE FROM prefix_message_cleanup WHERE id=?', id);
            return;
        }
        logEvent('prefix_message_delete_retry', { code: Number.isFinite(code) ? code : undefined, status: Number.isFinite(status) ? status : undefined,
            error: error instanceof Error ? error.message : String(error) });
        const retryAt = Date.now() + RETRY_DELETE_MS;
        store.run('UPDATE prefix_message_cleanup SET delete_at=? WHERE id=?', retryAt, id);
        arm(client, store, id, retryAt);
    }
}
