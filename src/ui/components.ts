import { registerWelcomePanel } from './welcome-panel.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, PermissionFlagsBits } from 'discord.js';
import { AppError } from '../errors.js';
import { defaults, type CommandContext, type Registry } from '../bot/registry.js';
import { checkDestination, showLayoutReview, restoreProgress, showRestoreReport } from './layout-ui.js';
import { selectComponents } from '../recovery/recovery.js';
import { registerHelpControls } from './help-ui.js';
import { registerAntinukePanel } from './antinuke-panel.js';
import { registerTrustPanel } from './trust-panel.js';
import { registerAppealControls } from '../features/appeals.js';
import { registerWelcomeControls } from '../features/joins.js';
import { registerEmergencyControls } from '../features/emergency.js';
import { registerWebhookControls } from '../features/webhooks.js';
import { registerAiModControls } from '../features/ai-moderation.js';
import { registerBotQuarantineControls } from '../features/antinuke-plus.js';
import { registerNewAccountControls } from '../security/new-accounts.js';
import { registerIncidentControls } from './incident-ui.js';
import { registerHistory } from './config-history.js';
import { registerPermControls } from './perm-ui.js';
import { registerDangerConfirm } from './danger-ui.js';
import { serverInfo } from './info-ui.js';
import { snapshotPage } from './snapshot-ui.js';
import { embed } from './ui.js';

export function serverPage(ctx: CommandContext, user: string, requested: number) {
    const rows = ctx.store.all("SELECT * FROM guild_authorization WHERE state='AUTHORIZED' AND guild_id NOT IN (SELECT guild_id FROM server_bans) ORDER BY authorized_at DESC,guild_id");
    const pages = Math.max(1, Math.ceil(rows.length / 5));
    const page = Math.min(Math.max(0, requested), pages - 1);
    const text = rows.slice(page * 5, page * 5 + 5).map(r => `**${r.name}**\nID: ${r.guild_id} · Members: ${ctx.client.guilds.cache.get(r.guild_id)?.memberCount ?? 'Unavailable'}\nAuthorized: <t:${Math.floor(r.authorized_at / 1000)}:f> · By: ${r.authorized_by}`).join('\n\n') || 'No authorized servers.';
    return { embeds: [embed(`Authorized servers · ${page + 1}/${pages}`, text)], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`servers:${user}:${page - 1}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0), new ButtonBuilder().setCustomId(`servers:${user}:${page + 1}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page === pages - 1))], allowedMentions: { parse: [] as never[] } };
}

export function registerComponents(registry: Registry) {
    registerHelpControls(registry);
    registerAntinukePanel(registry);
    registerTrustPanel(registry);
    registerAppealControls(registry);
    registerWelcomeControls(registry);
    registerWelcomePanel(registry);
    registerEmergencyControls(registry);
    registerWebhookControls(registry);
    registerAiModControls(registry);
    registerBotQuarantineControls(registry);
    registerNewAccountControls(registry);
    registerIncidentControls(registry);
    registerHistory(registry);
    registerPermControls(registry);
    registerDangerConfirm(registry);
    registry.component({ prefix: 'serverinfo:', kinds: ['button'], metadata: { ...defaults, requiresAuthorization: false, responseKind: 'info' }, execute: async (ctx, i) => {
            const match = /^serverinfo:(\d{17,20}):(-?\d{1,2})$/.exec(i.customId);
            if (!match || match[1] !== i.user.id)
                throw new AppError('PERMISSION_ERROR', 'This information browser belongs to another user.');
            await i.editReply(serverInfo(ctx, i.guild, i.user.id, Number(match[2])));
        } });
    registry.component({ prefix: 'servers:', kinds: ['button'], metadata: { ...defaults, category: 'developer', developerOnly: true, requiresAuthorization: false },
        execute: async (ctx, i) => {
            const match = /^servers:(\d{17,20}):(-?\d{1,6})$/.exec(i.customId);
            if (!match || match[1] !== i.user.id)
                throw new AppError('PERMISSION_ERROR', 'This control belongs to another developer.');
            await i.editReply(serverPage(ctx, i.user.id, Number(match[2])));
        } });
    registry.component({ prefix: 'snapshotpage:', kinds: ['button'], metadata: { ...defaults, category: 'security', access: 'security' },
        execute: async (ctx, i) => {
            const match = /^snapshotpage:(\d{17,20}):(\d{1,9})(:b)?$/.exec(i.customId);
            if (!match || match[1] !== i.user.id)
                throw new AppError('PERMISSION_ERROR', 'This snapshot browser belongs to another user.');
            await i.editReply(snapshotPage(ctx, i.guildId, i.user.id, Math.max(1, Number(match[2])), !!match[3]));
        } });
    registry.component({ prefix: 'snapshotdelete:', kinds: ['button'], metadata: { ...defaults, category: 'security', access: 'security' },
        execute: async (ctx, i) => {
            const key = i.customId.slice('snapshotdelete:'.length), p = ctx.confirmations.get(key);
            if (!p || p.action !== 'delete' || p.expires < Date.now() || p.guild !== i.guildId || p.user !== i.user.id)
                throw new AppError('VALIDATION_ERROR', 'This deletion confirmation expired or belongs to another user/server.');
            ctx.confirmations.delete(key);
            const result = await ctx.snapshots.delete(i.guildId, p.snapshots ?? [p.snapshot], i.user.id, p.fingerprint);
            ctx.logs.push(i.guildId, embed('Recovery points deleted', `By <@${i.user.id}> · ${result.replace(/\*\*/g, '').split('. ')[0]}`, Colors.Orange));
            await i.editReply({ content: result, embeds: [], components: [], attachments: [], allowedMentions: { parse: [] } });
        } });
    registry.component({ prefix: 'snapshotcancel:', kinds: ['button'], metadata: { ...defaults, category: 'security', access: 'security' },
        execute: async (ctx, i) => {
            const key = i.customId.slice('snapshotcancel:'.length), p = ctx.confirmations.get(key);
            if (!p || p.action !== 'delete' || p.guild !== i.guildId || p.user !== i.user.id)
                throw new AppError('VALIDATION_ERROR', 'This cancellation control belongs to another user/server.');
            ctx.confirmations.delete(key);
            await i.editReply({ content: 'Snapshot deletion cancelled.', embeds: [], components: [] });
        } });
    registry.component({ prefix: 'layoutselect:', kinds: ['select'], metadata: { ...defaults, category: 'security', access: 'security' },
        execute: async (ctx, i) => {
            const key = i.customId.slice('layoutselect:'.length), p = ctx.confirmations.get(key);
            if (!p || p.action || p.expires < Date.now() || p.guild !== i.guildId || p.user !== i.user.id)
                throw new AppError('VALIDATION_ERROR', 'This selector expired or belongs to another user/server.');
            p.components = selectComponents(i.values);
            p.pruneConfirmed = false;
            await showLayoutReview(ctx, i, key, p);
        } });
    registry.component({ prefix: 'layoutcancel:', kinds: ['button'], metadata: { ...defaults, category: 'security', access: 'security' },
        execute: async (ctx, i) => {
            const key = i.customId.slice('layoutcancel:'.length), p = ctx.confirmations.get(key);
            if (!p || p.action || p.guild !== i.guildId || p.user !== i.user.id)
                throw new AppError('VALIDATION_ERROR', 'This control belongs to another user/server.');
            ctx.confirmations.delete(key);
            await i.editReply({ content: 'Recovery cancelled. No server changes were made.', embeds: [], components: [], attachments: [] });
        } });
    registry.component({ prefix: 'restore:', kinds: ['button'], metadata: { ...defaults, category: 'security', access: 'security', botPermissions: [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels] },
        execute: async (ctx, i) => {
            const key = i.customId.slice('restore:'.length), p = ctx.confirmations.get(key);
            if (!p || p.action || p.expires < Date.now() || p.guild !== i.guildId || p.user !== i.user.id)
                throw new AppError('VALIDATION_ERROR', 'This confirmation is expired or belongs to another user/server. Run /recovery snapshot restore again.');
            if (p.prune && !p.pruneConfirmed) {
                p.pruneConfirmed = true;
                p.expires = Date.now() + 120000;
                await i.editReply({ embeds: [embed('Additional destructive confirmation', 'Pruning permanently deletes the extra roles and channels listed in your reviewed preview. This cannot restore their original IDs, messages, or member assignments. Confirm deletion of those extras as well as restoration.')], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`restore:${key}`).setLabel('Confirm restore and permanent deletion').setStyle(ButtonStyle.Danger))], allowedMentions: { parse: [] } });
                return;
            }
            ctx.confirmations.delete(key);
            ctx.assertActive();
            const options = { components: p.components, actor: i.user.id, progress: restoreProgress(i) };
            let result: string;
            if (p.destination) {
                const destination = ctx.client.guilds.cache.get(p.destination);
                if (!destination)
                    throw new AppError('VALIDATION_ERROR', 'Destination server is no longer connected.');
                await checkDestination(ctx, destination, i.user.id, p.components ?? selectComponents());
                result = await ctx.snapshots.copy(i.guild, destination, p.snapshot, p.fingerprint, options);
                await ctx.store.withAuthorized(destination.id, async () => showRestoreReport(ctx, i, destination.id, result));
            } else {
                result = await ctx.snapshots.restore(i.guild, p.snapshot, p.prune, p.fingerprint, options);
                await showRestoreReport(ctx, i, i.guildId, result);
            }
        } });
}
