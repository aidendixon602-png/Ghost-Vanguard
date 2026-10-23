import { SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { canUsePrefixRestart, requestPrefixRestart } from '../../bot/prefix-restart.js';
import { clearRestartNotice, restartInProgressText, restartNoticeText, saveRestartNotice } from '../../bot/restart-notice.js';
import { prefixDeleteDelayMs, schedulePrefixMessageDeletion } from '../../bot/prefix-cleanup.js';
import { AppError } from '../../errors.js';
export default defineCommand(new SlashCommandBuilder()
    .setName('restart')
    .setDescription('Gracefully restart the bot and update this message with downtime'), { category: 'developer', developerOnly: true, requiresAuthorization: false, responseKind: 'info', cooldown: 5000 }, async (ctx, i) => {
    if (!canUsePrefixRestart(i.user.id))
        throw new AppError('PERMISSION_ERROR', 'This command is restricted to IDs listed in `DEVELOPER_IDS`.');
    const requestedAt = Date.now();
    const text = restartNoticeText(requestedAt);
    // The interaction is already deferred by Interactions.handle (ephemeral based on policy).
    // Edit the deferred reply to show the restarting notice and capture its message for later update.
    let message = null;
    try {
        // Try to edit the deferred reply; fetchReply explicitly to get the message
        await i.editReply({ content: text });
        try {
            message = await i.fetchReply();
        }
        catch { }
    }
    catch {
        // Fallback: direct reply if not deferred
        try {
            message = await i.reply({ content: text, fetchReply: true });
        }
        catch { }
    }
    const channelId = i.channelId ?? i.channel?.id;
    const messageId = message?.id ?? null;
    // If we got a message, persist it; otherwise still try with channel fallback (will be updated if possible)
    if (channelId && messageId) {
        if (!saveRestartNotice(ctx.store, channelId, messageId, requestedAt)) {
            await i.editReply({ content: restartInProgressText() }).catch(() => { });
            schedulePrefixMessageDeletion(ctx.client, ctx.store, channelId, messageId, Date.now() + prefixDeleteDelayMs());
            return;
        }
        schedulePrefixMessageDeletion(ctx.client, ctx.store, channelId, messageId, requestedAt + prefixDeleteDelayMs());
    }
    else if (channelId) {
        // No message ID — still store with a placeholder so restart still happens; notice won't be edited back
        // but we at least don't block restarts. Try to store with interaction id as fallback.
        saveRestartNotice(ctx.store, channelId, (messageId ?? i.id), requestedAt);
    }
    const result = await requestPrefixRestart(i.user.id);
    const failureText = {
        'not-authorized': '⛔ This command is restricted to IDs listed in `DEVELOPER_IDS`.',
        busy: 'A restart or update is already in progress. Try again in a minute.',
        'too-soon': 'The bot started less than 3 minutes ago. Wait a minute, then try `/restart` again.',
        'no-launcher': 'I can’t restart from Discord because the launcher is not available. Use **Restart** in your host panel (e.g. Wispbyte → Restart). Keep the startup command `cd /home/container && node launch.js`.',
    };
    if (result === 'restarting')
        return; // keep notice as-is; new process will edit it via completeRestartNotice
    if (result === 'scheduled') {
        await i.editReply({ content: `${text}\nℹ️ Using the backup restart route; the host will relaunch the bot.` }).catch(() => { });
        return;
    }
    // Failure — clear the notice we saved and show error
    clearRestartNotice(ctx.store);
    const msg = failureText[result] ?? 'The restart could not be scheduled.';
    await i.editReply({ content: msg }).catch(() => { });
    if (channelId && messageId)
        schedulePrefixMessageDeletion(ctx.client, ctx.store, channelId, messageId, Date.now() + prefixDeleteDelayMs());
});
