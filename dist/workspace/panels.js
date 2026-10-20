import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { AppError } from '../errors.js';
import { activeWorkspaceConfig, getWorkspaceConfig } from './config.js';
import { assertPanelPermissions, selectedChannel } from './permissions.js';
import { WorkspaceStore } from './store.js';
import { embed } from '../ui/ui.js';
const button = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label.slice(0, 80)).setStyle(style);
export function memberPanelPayload(cfg) {
    const labels = cfg.branding.buttonLabels;
    const buttons = [];
    if (cfg.modules.submissions)
        buttons.push(button('wsopen:submission', labels.submit || 'Submit', ButtonStyle.Primary));
    if (cfg.modules.submissions)
        buttons.push(button('wsmember:mine', labels.mine || 'My Submissions'));
    buttons.push(button('wsmember:help', labels.help || 'Help'));
    return { embeds: [embed(cfg.branding.memberPanelTitle, cfg.branding.memberPanelDescription, cfg.branding.primaryColor)], components: [new ActionRowBuilder().addComponents(...buttons)], allowedMentions: { parse: [] } };
}
export function staffPanelPayload(cfg) {
    const labels = cfg.branding.buttonLabels;
    const buttons = [];
    if (cfg.modules.reviews)
        buttons.push(button('wsstaff:queue', labels.queue || 'Review Queue', ButtonStyle.Primary));
    if (cfg.modules.records)
        buttons.push(button('wsstaff:records', labels.records || 'Records'));
    if (cfg.modules.tasks)
        buttons.push(button('wsstaff:tasks', labels.tasks || 'Tasks'));
    if (cfg.modules.staff)
        buttons.push(button('wsstaff:staff', labels.staff || 'Staff'));
    if (cfg.modules.reports)
        buttons.push(button('wsstaff:reports', labels.reports || 'Reports'));
    buttons.push(button('wsstaff:settings', labels.settings || 'Settings'));
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5)
        rows.push(new ActionRowBuilder().addComponents(...buttons.slice(i, i + 5)));
    return { embeds: [embed(cfg.branding.staffPanelTitle, cfg.branding.staffPanelDescription, cfg.branding.primaryColor)], components: rows, allowedMentions: { parse: [] } };
}
export function taskPanelPayload(cfg) {
    return { embeds: [embed(`${cfg.branding.shortName} · Directives`, 'Create and review tasks from this focused entry point.', cfg.branding.primaryColor)], components: [new ActionRowBuilder().addComponents(button('wsopen:task', 'Create Task', ButtonStyle.Primary), button('wstask:open', 'Open Tasks'), button('wstask:blocked', 'Blocked'), button('wstask:overdue', 'Overdue'))], allowedMentions: { parse: [] } };
}
async function updateOrSend(store, guild, kind, channelId, payload, actor) {
    const channel = await selectedChannel(guild, channelId, `${kind} panel channel`);
    const me = guild.members.me ?? await guild.members.fetchMe();
    assertPanelPermissions(channel, me);
    const existing = store.get('SELECT * FROM workspace_panels WHERE guild_id=? AND kind=?', guild.id, kind);
    let message = null;
    if (existing)
        message = await channel.messages.fetch(String(existing.message_id)).catch(() => null);
    if (message)
        await message.edit(payload);
    else
        message = await channel.send(payload);
    store.run('INSERT INTO workspace_panels(guild_id,kind,channel_id,message_id,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(guild_id,kind) DO UPDATE SET channel_id=excluded.channel_id,message_id=excluded.message_id,updated_at=excluded.updated_at', guild.id, kind, channel.id, message.id, Date.now());
    new WorkspaceStore(store).audit(guild.id, actor, `panel/${kind}`, message.id, `Published in ${channel.id}`);
    return message;
}
export async function publishWorkspacePanels(store, guild, actor, kinds = ['member', 'staff', 'tasks']) {
    const cfg = activeWorkspaceConfig(store, guild.id);
    if (!cfg)
        throw new AppError('VALIDATION_ERROR', 'Workspace setup is incomplete. Save a valid workbook, channels, roles, and mappings before publishing panels.');
    const posted = [];
    if (kinds.includes('member')) {
        if (!cfg.channels.memberPanelId)
            throw new AppError('VALIDATION_ERROR', 'Select a member panel channel before publishing.');
        const m = await updateOrSend(store, guild, 'member', cfg.channels.memberPanelId, memberPanelPayload(cfg), actor);
        posted.push(`member panel: ${m.url}`);
    }
    if (kinds.includes('staff')) {
        if (!cfg.channels.staffPanelId)
            throw new AppError('VALIDATION_ERROR', 'Select a staff panel channel before publishing.');
        const m = await updateOrSend(store, guild, 'staff', cfg.channels.staffPanelId, staffPanelPayload(cfg), actor);
        posted.push(`staff panel: ${m.url}`);
    }
    if (kinds.includes('tasks') && cfg.modules.tasks && cfg.channels.taskPanelId) {
        const m = await updateOrSend(store, guild, 'tasks', cfg.channels.taskPanelId, taskPanelPayload(cfg), actor);
        posted.push(`task panel: ${m.url}`);
    }
    return posted;
}
export function setupStatus(store, guildId) {
    const cfg = getWorkspaceConfig(store, guildId);
    if (!cfg)
        return { configured: false, enabled: false, errors: ['No Workspace profile has been saved.'] };
    return { configured: true, enabled: !!cfg.enabled, validated: !!cfg.validatedAt, errors: cfg.enabled && cfg.validatedAt ? [] : ['Workspace is saved but not enabled; complete workbook validation and publish panels.'] };
}
/** Authorization revocation leaves records intact but removes this integration's controls from its own messages. */
export async function disableWorkspacePanels(client, store, guildId) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild)
        return;
    const rows = store.all('SELECT channel_id,message_id FROM workspace_panels WHERE guild_id=?', guildId);
    for (const panel of rows) {
        const channel = guild.channels.cache.get(String(panel.channel_id)) ?? await guild.channels.fetch(String(panel.channel_id)).catch(() => null);
        if (channel && 'messages' in channel) {
            const message = await channel.messages.fetch(String(panel.message_id)).catch(() => null);
            await message?.edit({ content: 'Workspace is disabled because this guild is no longer authorized. Existing records were preserved.', embeds: [], components: [], allowedMentions: { parse: [] } }).catch(() => undefined);
        }
    }
}
