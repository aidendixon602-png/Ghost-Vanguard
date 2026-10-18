import { Colors, MessageFlags } from 'discord.js';
import { failure, logEvent } from '../errors.js';
import { embed } from '../ui/ui.js';
export async function acknowledge(i, ephemeral = true) {
    if (i.isAutocomplete())
        return;
    if (!i.deferred && !i.replied)
        await i.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
}
export async function respond(i, message, title = '✓ Action completed', color = Colors.Green, ephemeral = true) {
    const payload = { embeds: [embed(title, message, color)], allowedMentions: { parse: [] }, components: [] };
    if (i.deferred || i.replied)
        await i.editReply(payload);
    else
        await i.reply({ ...payload, ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}) });
}
export async function commandFailure(i, error, command, context = {}, ephemeral = true) {
    const f = failure(error);
    logEvent('command_failure', { reference: f.reference, command, userId: i.user.id, guildId: i.guildId, channelId: i.channelId,
        category: f.category, details: f.details, ...context });
    try {
        if (i.isAutocomplete()) {
            if (!i.responded)
                await i.respond([]);
        }
        else
            await respond(i, `${f.message}\n\nReference: **${f.reference}**`, f.category === 'PERMISSION_ERROR' ? '✕ Permission denied' : f.category === 'AUTHORIZATION_ERROR' ? '⚠ Authorization required' : '✕ Command failed', Colors.Red, ephemeral);
    }
    catch {
        logEvent('interaction_response_unavailable', { reference: f.reference, interactionId: i.id });
    }
    return f;
}
