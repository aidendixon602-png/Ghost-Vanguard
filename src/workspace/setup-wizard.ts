import {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, ModalBuilder,
    PermissionFlagsBits, RoleSelectMenuBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { defaults, type CommandContext, type Registry } from '../bot/registry.js';
import { AppError } from '../errors.js';
import { embed } from '../ui/ui.js';
import {
    applyMappingJson, genericConfig, getWorkspaceConfig, saveWorkspaceConfig, validateWorkspaceConfig,
} from './config.js';
import { validateChannelSelection, validateRoleSelection } from './permissions.js';
import { googleCredentialsConfigured, sheetsFromEnv, validateWorkbook } from './sheets.js';
import { publishWorkspacePanels } from './panels.js';
import { WORKSPACE_MODULES, type WorkspaceConfig } from './types.js';

/**
 * Button-driven Workspace setup. Replaces the 25-option `/setup config workspace-setup` with an
 * ephemeral panel: pick channels and roles with Discord's native selectors, type the spreadsheet and
 * column layout in modals, and press Save & validate. Edits persist to the guild's Workspace config as
 * a draft (enabled stays off, validatedAt clears) until validation succeeds.
 */

const wiz = { ...defaults, category: 'guild-config', requiresAuthorization: true, access: 'member' as const, responseKind: 'info' as const, cooldown: 300, ephemeralDefault: true, requiredPermissions: [PermissionFlagsBits.ManageGuild] };
const wizDefer = { ...wiz, deferral: 'defer' as const };
const wizModal = { ...wiz, deferral: 'modal' as const };

const CHANNEL_FIELDS: [keyof WorkspaceConfig['channels'], string][] = [
    ['memberPanelId', 'Member panel'], ['staffPanelId', 'Staff dashboard'], ['taskPanelId', 'Task panel (optional)'], ['auditLogId', 'Audit log'],
];
const ROLE_FIELDS: [keyof WorkspaceConfig['roles'], string][] = [
    ['reviewerRoleIds', 'Reviewer roles'], ['managerRoleIds', 'Manager roles'], ['staffRoleIds', 'Staff roles'],
];

function load(ctx: CommandContext, guildId: string): WorkspaceConfig {
    return getWorkspaceConfig(ctx.store, guildId) ?? genericConfig(guildId);
}
/** Persist an in-progress edit. Any change marks the config unvalidated until Save & validate re-checks it. */
function saveDraft(ctx: CommandContext, cfg: WorkspaceConfig, actor: string) {
    cfg.validatedAt = null;
    cfg.enabled = false;
    saveWorkspaceConfig(ctx.store, cfg, actor);
}

function button(id: string, label: string, style = ButtonStyle.Secondary, disabled = false) {
    return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
}
function row<T extends ButtonBuilder | ChannelSelectMenuBuilder | RoleSelectMenuBuilder | StringSelectMenuBuilder>(...c: T[]) {
    return new ActionRowBuilder<T>().addComponents(...c);
}
const noMentions = { parse: [] as never[] };
const check = (ok: boolean) => ok ? '✅' : '❌';

function home(cfg: WorkspaceConfig) {
    const configErrors = validateWorkspaceConfig(cfg);
    const modules = (Object.entries(cfg.modules) as [string, boolean][]).filter(([, on]) => on).map(([n]) => n);
    const channelsSet = CHANNEL_FIELDS.filter(([k]) => cfg.channels[k]).length;
    const rolesSet = ROLE_FIELDS.filter(([k]) => (cfg.roles[k] as string[]).length).length;
    const lines = [
        `${check(!!cfg.sheets.spreadsheetId)} **Spreadsheet:** ${cfg.sheets.spreadsheetId ? `\`${cfg.sheets.spreadsheetId}\`` : 'not set — press **Spreadsheet & name**'}`,
        `${check(!!cfg.branding.departmentName.trim())} **Name:** ${cfg.branding.departmentName || 'not set'}`,
        `**Modules:** ${modules.join(', ') || 'none'}`,
        `**Column layout:** default A–L (press **Column layout** only if your sheet differs)`,
        `**Channels set:** ${channelsSet}/${CHANNEL_FIELDS.length} · **Role groups set:** ${rolesSet}/${ROLE_FIELDS.length}`,
        `**Reminders:** ${cfg.reminders.enabled ? `on · ${cfg.reminders.timezone} ${String(cfg.reminders.hour).padStart(2, '0')}:${String(cfg.reminders.minute).padStart(2, '0')}` : 'off'}`,
        '',
        configErrors.length ? `⚠️ **Before it can go live:**\n${configErrors.map(e => `• ${e}`).join('\n')}` : cfg.validatedAt ? '✅ Validated and enabled.' : '✅ Config looks complete — press **Save & validate** to check the live workbook and go live.',
    ];
    return {
        embeds: [embed('🧩 Workspace setup', lines.join('\n'), cfg.branding.primaryColor)],
        components: [
            row(button('wscfgopen:basics', 'Spreadsheet & name', ButtonStyle.Primary), button('wscfg:modules', 'Modules'), button('wscfgopen:mapping', 'Column layout')),
            row(button('wscfg:channels', 'Channels'), button('wscfg:roles', 'Roles'), button('wscfg:reminders', 'Reminders')),
            row(button('wscfg:save', 'Save & validate', ButtonStyle.Success), button('wscfg:publish', 'Publish panels', ButtonStyle.Secondary, !cfg.validatedAt), button('wscfg:home', 'Refresh')),
        ],
        allowedMentions: noMentions,
    };
}

function modulesScreen(cfg: WorkspaceConfig) {
    const select = new StringSelectMenuBuilder().setCustomId('wscfgsel:modules').setPlaceholder('Choose the modules this workspace uses').setMinValues(0).setMaxValues(WORKSPACE_MODULES.length)
        .addOptions(WORKSPACE_MODULES.map(m => ({ label: m[0]!.toUpperCase() + m.slice(1), value: m, default: cfg.modules[m] })));
    return { embeds: [embed('🧩 Modules', 'Pick what this workspace does. Each enabled module needs its worksheet mapped (defaults cover this).', cfg.branding.primaryColor)], components: [row(select), row(button('wscfg:home', 'Back'))], allowedMentions: noMentions };
}

function channelsScreen(cfg: WorkspaceConfig) {
    const rows = CHANNEL_FIELDS.map(([key, label]) => row(new ChannelSelectMenuBuilder().setCustomId(`wscfgsel:chan:${key}`).setPlaceholder(label).setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(0).setMaxValues(1).setDefaultChannels(cfg.channels[key] ? [cfg.channels[key] as string] : [])));
    return { embeds: [embed('📺 Channels', 'Pick where each panel and the audit log live. Leave any blank to skip it.', cfg.branding.primaryColor)], components: [...rows, row(button('wscfg:home', 'Back'))], allowedMentions: noMentions };
}

function rolesScreen(cfg: WorkspaceConfig) {
    const rows = ROLE_FIELDS.map(([key, label]) => row(new RoleSelectMenuBuilder().setCustomId(`wscfgsel:role:${key}`).setPlaceholder(label).setMinValues(0).setMaxValues(10).setDefaultRoles(cfg.roles[key] as string[])));
    return { embeds: [embed('🛡️ Roles', 'Reviewers can review submissions; managers can decide, configure and publish; staff appear in staff sync. All optional.', cfg.branding.primaryColor)], components: [...rows, row(button('wscfg:home', 'Back'))], allowedMentions: noMentions };
}

function remindersScreen(cfg: WorkspaceConfig) {
    const select = new ChannelSelectMenuBuilder().setCustomId('wscfgsel:chan:reminderId').setPlaceholder('Reminder channel').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(0).setMaxValues(1).setDefaultChannels(cfg.channels.reminderId ? [cfg.channels.reminderId] : []);
    return { embeds: [embed('⏰ Reminders', `Scheduled summaries. Currently **${cfg.reminders.enabled ? 'on' : 'off'}** · ${cfg.reminders.timezone} ${String(cfg.reminders.hour).padStart(2, '0')}:${String(cfg.reminders.minute).padStart(2, '0')} · weekday ${cfg.reminders.weekday}.`, cfg.branding.primaryColor)], components: [row(select), row(button('wscfg:remtoggle', cfg.reminders.enabled ? 'Turn off' : 'Turn on', cfg.reminders.enabled ? ButtonStyle.Danger : ButtonStyle.Success), button('wscfgopen:reminders', 'Set schedule'), button('wscfg:home', 'Back'))], allowedMentions: noMentions };
}

function input(id: string, label: string, style: TextInputStyle, required: boolean, max: number, value: string, placeholder = '') {
    const t = new TextInputBuilder().setCustomId(id).setLabel(label.slice(0, 45)).setStyle(style).setRequired(required).setMaxLength(max);
    if (value) t.setValue(value.slice(0, max));
    if (placeholder) t.setPlaceholder(placeholder.slice(0, 100));
    return new ActionRowBuilder<TextInputBuilder>().addComponents(t);
}

function basicsModal(cfg: WorkspaceConfig) {
    return new ModalBuilder().setCustomId('wscfgmode:basics').setTitle('Workspace · Spreadsheet & name').addComponents(
        input('spreadsheet_id', 'Google Spreadsheet ID', TextInputStyle.Short, true, 200, cfg.sheets.spreadsheetId, 'The long ID from the sheet URL'),
        input('department_name', 'Workspace / department name', TextInputStyle.Short, true, 100, cfg.branding.departmentName, 'e.g. Archives'),
    );
}
function mappingModal(cfg: WorkspaceConfig) {
    const current = Object.fromEntries((['archiveRegister', 'submissionReviews', 'staffRoster', 'directiveTracker'] as const).map(k => [k, { name: (cfg.sheets as any)[k].name, columns: (cfg.sheets as any)[k].columns }]));
    return new ModalBuilder().setCustomId('wscfgmode:mapping').setTitle('Workspace · Column layout').addComponents(
        input('mapping', 'Worksheet names & columns (JSON)', TextInputStyle.Paragraph, false, 4000, JSON.stringify(current, null, 0), 'Edit only if your sheet differs from the default'),
    );
}
function remindersModal(cfg: WorkspaceConfig) {
    return new ModalBuilder().setCustomId('wscfgmode:reminders').setTitle('Workspace · Reminder schedule').addComponents(
        input('timezone', 'IANA timezone', TextInputStyle.Short, true, 80, cfg.reminders.timezone, 'America/Los_Angeles'),
        input('time', 'Time HH:MM (24h)', TextInputStyle.Short, true, 5, `${String(cfg.reminders.hour).padStart(2, '0')}:${String(cfg.reminders.minute).padStart(2, '0')}`, '09:00'),
        input('weekday', 'Weekday 0 Sun – 6 Sat', TextInputStyle.Short, true, 1, String(cfg.reminders.weekday), '1'),
    );
}

/** Launch the wizard from `/setup config workspace-setup`. */
export async function openSetupWizard(ctx: CommandContext, i: any) {
    const cfg = load(ctx, i.guildId);
    if (!getWorkspaceConfig(ctx.store, i.guildId)) saveWorkspaceConfig(ctx.store, cfg, i.user.id); // seed a draft row
    return i.editReply(home(cfg));
}

async function onButton(ctx: CommandContext, i: any) {
    const name = i.customId.slice('wscfg:'.length);
    const cfg = load(ctx, i.guildId);
    if (name === 'home') return i.editReply(home(cfg));
    if (name === 'modules') return i.editReply(modulesScreen(cfg));
    if (name === 'channels') return i.editReply(channelsScreen(cfg));
    if (name === 'roles') return i.editReply(rolesScreen(cfg));
    if (name === 'reminders') return i.editReply(remindersScreen(cfg));
    if (name === 'remtoggle') { cfg.reminders.enabled = !cfg.reminders.enabled; saveDraft(ctx, cfg, i.user.id); return i.editReply(remindersScreen(cfg)); }
    if (name === 'publish') {
        if (!cfg.validatedAt) throw new AppError('VALIDATION_ERROR', 'Validate the workspace first with Save & validate.');
        const posted = await publishWorkspacePanels(ctx.store, i.guild, i.user.id, ['member', 'staff', 'tasks']);
        return i.editReply({ embeds: [embed('🧩 Workspace setup', posted.length ? `Panels published:\n${posted.map(l => `• ${l}`).join('\n')}` : 'No panel was posted — set the panel channels first.', cfg.branding.primaryColor)], components: home(cfg).components, allowedMentions: noMentions });
    }
    if (name === 'save') {
        const resourceErrors = [
            ...validateChannelSelection(i.guild, cfg.channels.memberPanelId, 'Member panel'), ...validateChannelSelection(i.guild, cfg.channels.staffPanelId, 'Staff panel'),
            ...validateChannelSelection(i.guild, cfg.channels.taskPanelId, 'Task panel'), ...validateChannelSelection(i.guild, cfg.channels.auditLogId, 'Audit log'), ...validateChannelSelection(i.guild, cfg.channels.reminderId, 'Reminder channel'),
            ...validateRoleSelection(i.guild, cfg.roles.reviewerRoleIds, 'Reviewer roles'), ...validateRoleSelection(i.guild, cfg.roles.managerRoleIds, 'Manager roles'), ...validateRoleSelection(i.guild, cfg.roles.staffRoleIds, 'Staff roles'),
        ];
        const errors = [...resourceErrors, ...validateWorkspaceConfig(cfg)];
        if (errors.length) throw new AppError('VALIDATION_ERROR', `Not saved — fix these first:\n${errors.map(e => `• ${e}`).join('\n')}`);
        if (!googleCredentialsConfigured()) throw new AppError('INTEGRATION_ERROR', 'Google authentication is not configured on the host. Set the service-account or access-token environment variables, share the workbook with that identity, then try again.');
        const result = await validateWorkbook(sheetsFromEnv(), cfg);
        if (!result.ok) throw new AppError('INTEGRATION_ERROR', `Live workbook check failed; nothing was enabled:\n${result.errors.map(e => `• ${e}`).join('\n')}`);
        cfg.enabled = true; cfg.validatedAt = Date.now(); cfg.updatedBy = i.user.id;
        saveWorkspaceConfig(ctx.store, cfg, i.user.id);
        return i.editReply({ embeds: [embed('✅ Workspace validated & enabled', `**${cfg.branding.departmentName}** is live.\nNext: press **Publish panels** to post the member/staff panels.`, cfg.branding.primaryColor)], components: home(cfg).components, allowedMentions: noMentions });
    }
    throw new AppError('VALIDATION_ERROR', 'That setup control is no longer available.');
}

async function onOpen(ctx: CommandContext, i: any) {
    const which = i.customId.slice('wscfgopen:'.length);
    const cfg = load(ctx, i.guildId);
    if (which === 'basics') return i.showModal(basicsModal(cfg));
    if (which === 'mapping') return i.showModal(mappingModal(cfg));
    if (which === 'reminders') return i.showModal(remindersModal(cfg));
    throw new AppError('VALIDATION_ERROR', 'That setup form is no longer available.');
}

async function onSelect(ctx: CommandContext, i: any) {
    const parts = i.customId.split(':'); // wscfgsel:<kind>:<key?>
    const cfg = load(ctx, i.guildId);
    if (parts[1] === 'modules') {
        cfg.modules = Object.fromEntries(WORKSPACE_MODULES.map(m => [m, i.values.includes(m)])) as WorkspaceConfig['modules'];
        saveDraft(ctx, cfg, i.user.id);
        return i.editReply(modulesScreen(cfg));
    }
    if (parts[1] === 'chan') {
        const key = parts[2] as keyof WorkspaceConfig['channels'];
        (cfg.channels[key] as string | null) = i.values[0] ?? null;
        if (key === 'reminderId') cfg.reminders.channelId = i.values[0] ?? null;
        saveDraft(ctx, cfg, i.user.id);
        return i.editReply(key === 'reminderId' ? remindersScreen(cfg) : channelsScreen(cfg));
    }
    if (parts[1] === 'role') {
        const key = parts[2] as 'reviewerRoleIds' | 'managerRoleIds' | 'staffRoleIds';
        cfg.roles[key] = [...i.values];
        saveDraft(ctx, cfg, i.user.id);
        return i.editReply(rolesScreen(cfg));
    }
    throw new AppError('VALIDATION_ERROR', 'That selector is no longer available.');
}

async function onModal(ctx: CommandContext, i: any) {
    const which = i.customId.slice('wscfgmode:'.length);
    const cfg = load(ctx, i.guildId);
    const f = (id: string) => String(i.fields.getTextInputValue(id) ?? '').trim();
    if (which === 'basics') {
        cfg.sheets.spreadsheetId = f('spreadsheet_id');
        const name = f('department_name');
        cfg.branding.departmentName = name; cfg.branding.shortName = name.slice(0, 32);
        cfg.branding.memberPanelTitle = `${name} · Workspace`; cfg.branding.staffPanelTitle = `${name} · Staff Workspace`;
    } else if (which === 'mapping') {
        applyMappingJson(cfg, f('mapping') || null);
    } else if (which === 'reminders') {
        const tz = f('timezone'); const [h, m] = f('time').split(':'); const wd = Number(f('weekday'));
        const hour = Number(h), minute = Number(m);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new AppError('VALIDATION_ERROR', 'Time must be HH:MM in 24-hour form, e.g. 09:00.');
        if (!Number.isInteger(wd) || wd < 0 || wd > 6) throw new AppError('VALIDATION_ERROR', 'Weekday must be 0 (Sunday) through 6 (Saturday).');
        cfg.reminders.timezone = tz || 'UTC'; cfg.reminders.hour = hour; cfg.reminders.minute = minute; cfg.reminders.weekday = wd;
    } else throw new AppError('VALIDATION_ERROR', 'That setup form is no longer available.');
    saveDraft(ctx, cfg, i.user.id);
    return i.editReply(home(cfg));
}

export function registerWorkspaceSetup(registry: Registry) {
    registry.component({ prefix: 'wscfg:', kinds: ['button'], metadata: wizDefer, execute: onButton });
    registry.component({ prefix: 'wscfgopen:', kinds: ['button'], metadata: wizModal, execute: onOpen });
    registry.component({ prefix: 'wscfgsel:', kinds: ['select'], metadata: wizDefer, execute: onSelect });
    registry.component({ prefix: 'wscfgmode:', kinds: ['modal'], metadata: wizDefer, execute: onModal });
}
