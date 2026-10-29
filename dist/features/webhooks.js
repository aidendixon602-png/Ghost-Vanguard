import { ActionRowBuilder, AuditLogEvent, ButtonBuilder, ButtonStyle, Colors, StringSelectMenuBuilder } from 'discord.js';
import { embed } from '../ui/ui.js';
import { defaults } from '../bot/registry.js';
import { AppError } from '../errors.js';
import { RANKS, rankOf } from '../bot/ranks.js';
import { staffReason } from '../security/raidmode.js';
import { isTrustedBot } from '../bot/trusted-bots.js';
/**
 * Webhook guard. Webhooks can post as anyone, so they are a favourite nuke tool. Anti-nuke already
 * deletes webhooks made by people who are not whitelisted; on top of that, every new webhook (even
 * one made by staff) is reported with a Delete button, and /raid webhooks lists them all.
 */
export function reportWebhook(store, logs, entry, guild) {
    if (entry.action !== AuditLogEvent.WebhookCreate || !entry.targetId || entry.executorId === guild.client.user?.id || isTrustedBot(entry.executorId))
        return;
    const channel = entry.target?.channelId ?? entry.changes?.find(c => c.key === 'channel_id')?.new;
    logs.push(guild.id, embed('🔗 New webhook created', `**By:** ${entry.executorId ? `<@${entry.executorId}>` : 'unknown'}\n**Webhook:** ${entry.target?.name ?? entry.targetId} (\`${entry.targetId}\`)${channel ? `\n**Channel:** <#${channel}>` : ''}\n\nWebhooks can post messages as anyone. If nobody on staff expected this, delete it.`, Colors.Orange), [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`webhook:delete:${entry.targetId}`).setLabel('Delete webhook').setStyle(ButtonStyle.Danger))]);
}
export async function webhookList(guild) {
    const hooks = [...(await guild.fetchWebhooks()).values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    const lines = hooks.slice(0, 25).map(h => `• **${h.name}** · <#${h.channelId}> · ${h.owner ? `made by <@${h.owner.id}>` : 'owner unknown'} · <t:${Math.floor(h.createdTimestamp / 1000)}:R>${h.applicationId ? ' · app' : ''}`);
    return {
        embeds: [embed(`Webhooks · ${hooks.length}`, `${lines.join('\n') || 'This server has no webhooks.'}${hooks.length > 25 ? `\n…and ${hooks.length - 25} more` : ''}\n\n-# Pick one below to delete it.`, Colors.Blurple)],
        components: hooks.length ? [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('webhook:pick').setPlaceholder('Delete a webhook…')
                .addOptions(...hooks.slice(0, 25).map(h => ({ label: h.name.slice(0, 100), value: h.id, description: `#${h.channel?.name ?? h.channelId}`.slice(0, 100) }))))] : [],
        allowedMentions: { parse: [] },
    };
}
export function registerWebhookControls(registry) {
    registry.component({ prefix: 'webhook:', kinds: ['button', 'select'], metadata: { ...defaults, category: 'security', access: 'member', cooldown: 1000 }, execute: async (ctx, i) => {
            if (rankOf(ctx.store, i.guildId, i.user.id, ctx.actor) < RANKS.admin && i.user.id !== i.guild.ownerId)
                throw new AppError('PERMISSION_ERROR', 'Only Admins and above can delete webhooks.');
            const id = i.customId === 'webhook:pick' ? i.values?.[0] : i.customId.split(':')[2];
            if (!id || !/^\d{17,20}$/.test(id))
                throw new AppError('VALIDATION_ERROR', 'Unknown webhook.');
            const hook = (await i.guild.fetchWebhooks()).get(id);
            if (!hook)
                return 'That webhook is already gone.';
            await hook.delete(staffReason(i.user.id, 'webhook deleted from Vanguard'));
            ctx.logs.push(i.guildId, embed('Webhook deleted', `By <@${i.user.id}> · **${hook.name}** in <#${hook.channelId}>`, Colors.Green));
            if (i.customId.startsWith('webhook:delete:'))
                await i.message?.edit({ components: [] }).catch(() => { });
            return `Deleted webhook **${hook.name}**.`;
        } });
}
