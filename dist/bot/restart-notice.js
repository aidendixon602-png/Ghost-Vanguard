import { logEvent } from '../errors.js';
/** ETA shown in Discord. This is informational only; it does not delay the restart. */
export const RESTART_ETA_MS = 30_000;
const NOTICE_ROW_ID = 1;
export function restartNoticeText(requestedAt) {
    const eta = Math.floor((requestedAt + RESTART_ETA_MS) / 1000);
    return [
        '⏳ Ghost Vanguard is restarting',
        '🔄 I’m shutting down safely and reconnecting to Discord.',
        `Estimated return: <t:${eta}:R>`,
        'This is an estimate, not a forced wait. I’ll update this message when startup is complete.',
    ].join('\n');
}
export function restartInProgressText() {
    return '⏳ A restart is already in progress. I’ll update the existing status message when Ghost Vanguard is back online.';
}
export function clearRestartNotice(store) {
    store.run('DELETE FROM restart_notices WHERE id=?', NOTICE_ROW_ID);
}
/** Persist the reply coordinates so the new process can update the same message. */
export function saveRestartNotice(store, channelId, messageId, requestedAt) {
    return store.transaction(() => {
        const existing = store.get('SELECT requested_at FROM restart_notices WHERE id=?', NOTICE_ROW_ID);
        if (existing && requestedAt - Number(existing.requested_at) < 120_000)
            return false;
        store.run(`INSERT INTO restart_notices(id,channel_id,message_id,requested_at) VALUES(?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET channel_id=excluded.channel_id,message_id=excluded.message_id,requested_at=excluded.requested_at`, NOTICE_ROW_ID, channelId, messageId, requestedAt);
        return true;
    });
}
/** Edit the original plain-text reply after Discord, commands, and startup checks are ready. */
export async function completeRestartNotice(client, store, now, servers, commands) {
    const row = store.get('SELECT channel_id,message_id,requested_at FROM restart_notices WHERE id=?', NOTICE_ROW_ID);
    if (!row)
        return false;
    // Consume it before making network calls, so a missing/deleted message cannot block a later restart.
    clearRestartNotice(store);
    const channel = await client.channels.fetch(String(row.channel_id)).catch(() => null);
    if (!channel?.isTextBased?.() || !channel.messages?.fetch) {
        logEvent('restart_notice_unavailable', { reason: 'channel unavailable or not text-based' });
        return false;
    }
    const message = await channel.messages.fetch(String(row.message_id)).catch(() => null);
    if (!message?.edit) {
        logEvent('restart_notice_unavailable', { reason: 'message unavailable' });
        return false;
    }
    const elapsedSeconds = Math.max(0, Math.floor((now - Number(row.requested_at)) / 1000));
    try {
        await message.edit([
            '✅ Ghost Vanguard is back online',
            `⏱️ Actual downtime: ${formatDowntime(elapsedSeconds)}`,
            `📡 ${servers} servers connected · ${commands} commands ready`,
            '🟢 Startup checks and command sync are complete.',
            'Use `/info ping` to verify the bot is responsive.',
        ].join('\n'));
        return true;
    }
    catch (error) {
        logEvent('restart_notice_edit_failure', { error: error instanceof Error ? error.message : String(error) });
        return false;
    }
}
export function formatDowntime(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    if (hours)
        return `${hours}h ${minutes}m ${remainder}s`;
    if (minutes)
        return `${minutes}m ${remainder}s`;
    return `${remainder}s`;
}
