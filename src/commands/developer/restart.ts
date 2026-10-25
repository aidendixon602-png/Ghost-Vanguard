import { SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { canUseRestart, requestRestart } from '../../bot/restart-request.js';
import { clearRestartNotice, restartInProgressText, restartNoticeText, saveRestartNotice } from '../../bot/restart-notice.js';
import { AppError } from '../../errors.js';

export default defineCommand(
    new SlashCommandBuilder()
        .setName('restart')
        .setDescription('Gracefully restart the bot and update this message with downtime'),
    { category: 'developer', developerOnly: true, requiresAuthorization: false, responseKind: 'info', cooldown: 5000 },
    async (ctx, i) => {
        if (!canUseRestart(i.user.id)) throw new AppError('PERMISSION_ERROR', 'This command is restricted to IDs listed in `DEVELOPER_IDS`.');

        const requestedAt = Date.now();
        const text = restartNoticeText(requestedAt);

        // The interaction is already deferred by Interactions.handle (ephemeral based on policy).
        // Edit the deferred reply to show the restarting notice and capture its message for later update.
        let message: any = null;
        try {
            await i.editReply({ content: text });
            try { message = await (i as any).fetchReply(); } catch { }
        } catch {
            // Fallback: direct reply if not deferred.
            try { message = await (i as any).reply({ content: text, fetchReply: true }); } catch { }
        }

        const channelId = (i as any).channelId ?? i.channel?.id;
        const messageId = message?.id ?? null;

        if (channelId && messageId) {
            if (!saveRestartNotice(ctx.store, channelId, messageId, requestedAt)) {
                await i.editReply({ content: restartInProgressText() }).catch(() => { });
                return;
            }
        } else if (channelId) {
            // Restart can still proceed if Discord did not return a message ID; only the completion edit is lost.
            saveRestartNotice(ctx.store, channelId, (messageId ?? i.id) as string, requestedAt);
        }

        const result = await requestRestart(i.user.id);

        const failureText: Record<string, string> = {
            'not-authorized': '⛔ This command is restricted to IDs listed in `DEVELOPER_IDS`.',
            busy: 'A restart or update is already in progress. Try again in a minute.',
            'too-soon': 'The bot started less than 3 minutes ago. Wait a minute, then try `/restart` again.',
            'no-launcher': 'I can’t restart from Discord because the launcher is not available. Use **Restart** in your host panel (e.g. Wispbyte → Restart). Keep the startup command `cd /home/container && node launch.js`.',
        };

        if (result === 'restarting') return; // The new process updates the saved notice when startup completes.
        if (result === 'scheduled') {
            await i.editReply({ content: `${text}\nℹ️ Using the backup restart route; the host will relaunch the bot.` }).catch(() => { });
            return;
        }

        clearRestartNotice(ctx.store);
        const msg = failureText[result] ?? 'The restart could not be scheduled.';
        await i.editReply({ content: msg }).catch(() => { });
    },
);
