import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, ModalBuilder, PermissionFlagsBits, RoleSelectMenuBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, } from 'discord.js';
import { defaults } from '../bot/registry.js';
import { AppError } from '../errors.js';
import { embed } from '../ui/ui.js';
import { applyMappingJson, genericConfig, getWorkspaceConfig, saveWorkspaceConfig, validateWorkspaceConfig, } from './config.js';
import { validateChannelSelection, validateRoleSelection } from './permissions.js';
import { googleCredentialsConfigured, sheetsFromEnv, validateWorkbook } from './sheets.js';
import { publishWorkspacePanels } from './panels.js';
import { WORKSPACE_MODULES } from './types.js';
/**
 * Button-driven Workspace setup. Replaces the 25-option `/setup config workspace-setup` with an
 * ephemeral panel: pick channels and roles with Discord's native selectors, type the spreadsheet and
 * column layout in modals, and press Save & validate. Edits persist to the guild's Workspace config as
 * a draft (enabled stays off, validatedAt clears) until validation succeeds.
 */
const wiz = { ...defaults, category: 'guild-config', requiresAuthorization: true, access: 'member', responseKind: 'info', cooldown: 300, ephemeralDefault: true, requiredPermissions: [PermissionFlagsBits.ManageGuild] };
const wizDefer = { ...wiz, deferral: 'defer' };
const wizModal = { ...wiz, deferral: 'modal' };
const CHANNEL_FIELDS = [
    ['memberPanelId', 'Member panel'], ['staffPanelId', 'Staff dashboard'], ['taskPanelId', 'Task panel (optional)'], ['auditLogId', 'Audit log'],
];
const ROLE_FIELDS = [
    ['reviewerRoleIds', 'Reviewer roles'], ['managerRoleIds', 'Manager roles'], ['staffRoleIds', 'Staff roles'],
];
function load(ctx, guildId) {
    return getWorkspaceConfig(ctx.store, guildId) ?? genericConfig(guildId);
}
const LOG_CATEGORY = /log|audit/i;
const AUDIT_CHANNEL = /audit|mod-?log|server-?log|^logs?$|-logs?$|^logging$/i;
/**
 * Pre-fill empty channel and role slots by scanning the guild: the audit log comes from an existing
 * logging category (or a log-named channel), and role groups from roles whose name or permissions mark
 * them as admins/mods/staff. Only fills blanks — never overwrites a choice already made.
 */
function autoFill(guild, cfg) {
    const notes = [];
    const chans = [...guild.channels.cache.values()];
    const text = chans.filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement);
    const logCats = new Set(chans.filter((c) => c.type === ChannelType.GuildCategory && LOG_CATEGORY.test(c.name)).map((c) => c.id));
    const inLogCat = text.filter((c) => c.parentId && logCats.has(c.parentId));
    const named = (re) => text.find((c) => re.test(c.name)) ?? null;
    const setChan = (key, pick, label) => {
        if (cfg.channels[key] || !pick)
            return;
        cfg.channels[key] = pick.id;
        if (key === 'reminderId')
            cfg.reminders.channelId = pick.id;
        notes.push(`${label} → <#${pick.id}>`);
    };
    setChan('auditLogId', named(AUDIT_CHANNEL) ?? inLogCat[0] ?? null, 'Audit log');
    setChan('reminderId', named(/remind|announce/i) ?? named(/general/i), 'Reminder');
    setChan('staffPanelId', named(/staff|admin[-\s]?(chat|commands?)?|mod[-\s]?(chat|commands?)/i), 'Staff panel');
    setChan('memberPanelId', named(/general|chat|lobby|commands?|^bot/i), 'Member panel');
    const roles = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id && !r.managed);
    const has = (r, p) => { try {
        return r.permissions.has(p);
    }
    catch {
        return false;
    } };
    const pick = (re, perms) => roles.filter((r) => re.test(r.name) || perms.some(p => has(r, p))).slice(0, 5).map((r) => r.id);
    const setRoles = (key, ids, label) => {
        if (cfg.roles[key].length || !ids.length)
            return;
        cfg.roles[key] = ids;
        notes.push(`${label} → ${ids.length} role(s)`);
    };
    setRoles('managerRoleIds', pick(/admin|manager|owner|director|head|lead/i, [PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild]), 'Managers');
    setRoles('reviewerRoleIds', pick(/review|senior|moderator|\bmod\b/i, [PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageMessages]), 'Reviewers');
    setRoles('staffRoleIds', pick(/staff|team|helper|support|moderator|\bmod\b/i, []), 'Staff');
    return notes;
}
/** Persist an in-progress edit. Any change marks the config unvalidated until Save & validate re-checks it. */
function saveDraft(ctx, cfg, actor) {
    cfg.validatedAt = null;
    cfg.enabled = false;
    saveWorkspaceConfig(ctx.store, cfg, actor);
}
function button(id, label, style = ButtonStyle.Secondary, disabled = false) {
    return new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
}
function row(...c) {
    return new ActionRowBuilder().addComponents(...c);
}
const noMentions = { parse: [] };
const check = (ok) => ok ? '✅' : '❌';
function home(cfg, detected = []) {
    const configErrors = validateWorkspaceConfig(cfg);
    const modules = Object.entries(cfg.modules).filter(([, on]) => on).map(([n]) => n);
    const channelsSet = CHANNEL_FIELDS.filter(([k]) => cfg.channels[k]).length;
    const rolesSet = ROLE_FIELDS.filter(([k]) => cfg.roles[k].length).length;
    const lines = [
        `${check(!!cfg.sheets.spreadsheetId)} **Spreadsheet:** ${cfg.sheets.spreadsheetId ? `\`${cfg.sheets.spreadsheetId}\`` : 'not set — press **Spreadsheet & name**'}`,
        `${check(!!cfg.branding.departmentName.trim())} **Name:** ${cfg.branding.departmentName || 'not set'}`,
        `**Modules:** ${modules.join(', ') || 'none'}`,
        `**Column layout:** default A–L (press **Column layout** only if your sheet differs)`,
        `**Channels set:** ${channelsSet}/${CHANNEL_FIELDS.length} · **Role groups set:** ${rolesSet}/${ROLE_FIELDS.length}`,
        `**Reminders:** ${cfg.reminders.enabled ? `on · ${cfg.reminders.timezone} ${String(cfg.reminders.hour).padStart(2, '0')}:${String(cfg.reminders.minute).padStart(2, '0')}` : 'off'}`,
        detected.length ? `\n🔎 **Auto-detected from this server:**\n${detected.map(d => `• ${d}`).join('\n')}` : '',
        '',
        configErrors.length ? `⚠️ **Before it can go live:**\n${configErrors.map(e => `• ${e}`).join('\n')}` : cfg.validatedAt ? '✅ Validated and enabled.' : '✅ Config looks complete — press **Save & validate** to check the live workbook and go live.',
    ].filter(Boolean);
    return {
        embeds: [embed('🧩 Workspace setup', lines.join('\n'), cfg.branding.primaryColor)],
        components: [
            row(button('wscfgopen:basics', 'Spreadsheet & name', ButtonStyle.Primary), button('wscfg:modules', 'Modules'), button('wscfgopen:mapping', 'Column layout')),
            row(button('wscfg:channels', 'Channels'), button('wscfg:roles', 'Roles'), button('wscfg:reminders', 'Reminders')),
            row(button('wscfg:autodetect', '🔎 Auto-detect channels & roles')),
            row(button('wscfg:save', 'Save & validate', ButtonStyle.Success), button('wscfg:publish', 'Publish panels', ButtonStyle.Secondary, !cfg.validatedAt), button('wscfg:home', 'Refresh')),
        ],
        allowedMentions: noMentions,
    };
}
function modulesScreen(cfg) {
    const select = new StringSelectMenuBuilder().setCustomId('wscfgsel:modules').setPlaceholder('Choose the modules this workspace uses').setMinValues(0).setMaxValues(WORKSPACE_MODULES.length)
        .addOptions(WORKSPACE_MODULES.map(m => ({ label: m[0].toUpperCase() + m.slice(1), value: m, default: cfg.modules[m] })));
    return { embeds: [embed('🧩 Modules', 'Pick what this workspace does. Each enabled module needs its worksheet mapped (defaults cover this).', cfg.branding.primaryColor)], components: [row(select), row(button('wscfg:home', 'Back'))], allowedMentions: noMentions };
}
function channelsScreen(cfg) {
    const rows = CHANNEL_FIELDS.map(([key, label]) => row(new ChannelSelectMenuBuilder().setCustomId(`wscfgsel:chan:${key}`).setPlaceholder(label).setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(0).setMaxValues(1).setDefaultChannels(cfg.channels[key] ? [cfg.channels[key]] : [])));
    return { embeds: [embed('📺 Channels', 'Pick where each panel and the audit log live. Leave any blank to skip it.', cfg.branding.primaryColor)], components: [...rows, row(button('wscfg:home', 'Back'))], allowedMentions: noMentions };
}
function rolesScreen(cfg) {
    const rows = ROLE_FIELDS.map(([key, label]) => row(new RoleSelectMenuBuilder().setCustomId(`wscfgsel:role:${key}`).setPlaceholder(label).setMinValues(0).setMaxValues(10).setDefaultRoles(cfg.roles[key])));
    return { embeds: [embed('🛡️ Roles', 'Reviewers can review submissions; managers can decide, configure and publish; staff appear in staff sync. All optional.', cfg.branding.primaryColor)], components: [...rows, row(button('wscfg:home', 'Back'))], allowedMentions: noMentions };
}
function remindersScreen(cfg) {
    const select = new ChannelSelectMenuBuilder().setCustomId('wscfgsel:chan:reminderId').setPlaceholder('Reminder channel').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(0).setMaxValues(1).setDefaultChannels(cfg.channels.reminderId ? [cfg.channels.reminderId] : []);
    return { embeds: [embed('⏰ Reminders', `Scheduled summaries. Currently **${cfg.reminders.enabled ? 'on' : 'off'}** · ${cfg.reminders.timezone} ${String(cfg.reminders.hour).padStart(2, '0')}:${String(cfg.reminders.minute).padStart(2, '0')} · weekday ${cfg.reminders.weekday}.`, cfg.branding.primaryColor)], components: [row(select), row(button('wscfg:remtoggle', cfg.reminders.enabled ? 'Turn off' : 'Turn on', cfg.reminders.enabled ? ButtonStyle.Danger : ButtonStyle.Success), button('wscfgopen:reminders', 'Set schedule'), button('wscfg:home', 'Back'))], allowedMentions: noMentions };
}
function input(id, label, style, required, max, value, placeholder = '') {
    const t = new TextInputBuilder().setCustomId(id).setLabel(label.slice(0, 45)).setStyle(style).setRequired(required).setMaxLength(max);
    if (value)
        t.setValue(value.slice(0, max));
    if (placeholder)
        t.setPlaceholder(placeholder.slice(0, 100));
    return new ActionRowBuilder().addComponents(t);
}
function basicsModal(cfg) {
    return new ModalBuilder().setCustomId('wscfgmode:basics').setTitle('Workspace · Spreadsheet & name').addComponents(input('spreadsheet_id', 'Google Spreadsheet ID', TextInputStyle.Short, true, 200, cfg.sheets.spreadsheetId, 'The long ID from the sheet URL'), input('department_name', 'Workspace / department name', TextInputStyle.Short, true, 100, cfg.branding.departmentName, 'e.g. Archives'));
}
function mappingModal(cfg) {
    const current = Object.fromEntries(['archiveRegister', 'submissionReviews', 'staffRoster', 'directiveTracker'].map(k => [k, { name: cfg.sheets[k].name, columns: cfg.sheets[k].columns }]));
    return new ModalBuilder().setCustomId('wscfgmode:mapping').setTitle('Workspace · Column layout').addComponents(input('mapping', 'Worksheet names & columns (JSON)', TextInputStyle.Paragraph, false, 4000, JSON.stringify(current, null, 0), 'Edit only if your sheet differs from the default'));
}
function remindersModal(cfg) {
    return new ModalBuilder().setCustomId('wscfgmode:reminders').setTitle('Workspace · Reminder schedule').addComponents(input('timezone', 'IANA timezone', TextInputStyle.Short, true, 80, cfg.reminders.timezone, 'America/Los_Angeles'), input('time', 'Time HH:MM (24h)', TextInputStyle.Short, true, 5, `${String(cfg.reminders.hour).padStart(2, '0')}:${String(cfg.reminders.minute).padStart(2, '0')}`, '09:00'), input('weekday', 'Weekday 0 Sun – 6 Sat', TextInputStyle.Short, true, 1, String(cfg.reminders.weekday), '1'));
}
/** Launch the wizard from `/setup config workspace-setup`. */
export async function openSetupWizard(ctx, i) {
    const fresh = !getWorkspaceConfig(ctx.store, i.guildId);
    const cfg = load(ctx, i.guildId);
    let detected = [];
    if (fresh) {
        detected = autoFill(i.guild, cfg); // first open: pre-fill channels/roles from the server
        saveWorkspaceConfig(ctx.store, cfg, i.user.id);
    }
    return i.editReply(home(cfg, detected));
}
async function onButton(ctx, i) {
    const name = i.customId.slice('wscfg:'.length);
    const cfg = load(ctx, i.guildId);
    if (name === 'home')
        return i.editReply(home(cfg));
    if (name === 'modules')
        return i.editReply(modulesScreen(cfg));
    if (name === 'channels')
        return i.editReply(channelsScreen(cfg));
    if (name === 'roles')
        return i.editReply(rolesScreen(cfg));
    if (name === 'reminders')
        return i.editReply(remindersScreen(cfg));
    if (name === 'remtoggle') {
        cfg.reminders.enabled = !cfg.reminders.enabled;
        saveDraft(ctx, cfg, i.user.id);
        return i.editReply(remindersScreen(cfg));
    }
    if (name === 'autodetect') {
        const detected = autoFill(i.guild, cfg);
        saveDraft(ctx, cfg, i.user.id);
        return i.editReply(home(cfg, detected.length ? detected : ['Nothing new to fill — channels/roles already set, or no logging category/roles matched by name.']));
    }
    if (name === 'publish') {
        if (!cfg.validatedAt)
            throw new AppError('VALIDATION_ERROR', 'Validate the workspace first with Save & validate.');
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
        if (errors.length)
            throw new AppError('VALIDATION_ERROR', `Not saved — fix these first:\n${errors.map(e => `• ${e}`).join('\n')}`);
        if (!googleCredentialsConfigured())
            throw new AppError('INTEGRATION_ERROR', 'Google authentication is not configured on the host. Set the service-account or access-token environment variables, share the workbook with that identity, then try again.');
        const result = await validateWorkbook(sheetsFromEnv(), cfg);
        if (!result.ok)
            throw new AppError('INTEGRATION_ERROR', `Live workbook check failed; nothing was enabled:\n${result.errors.map(e => `• ${e}`).join('\n')}`);
        cfg.enabled = true;
        cfg.validatedAt = Date.now();
        cfg.updatedBy = i.user.id;
        saveWorkspaceConfig(ctx.store, cfg, i.user.id);
        return i.editReply({ embeds: [embed('✅ Workspace validated & enabled', `**${cfg.branding.departmentName}** is live.\nNext: press **Publish panels** to post the member/staff panels.`, cfg.branding.primaryColor)], components: home(cfg).components, allowedMentions: noMentions });
    }
    throw new AppError('VALIDATION_ERROR', 'That setup control is no longer available.');
}
async function onOpen(ctx, i) {
    const which = i.customId.slice('wscfgopen:'.length);
    const cfg = load(ctx, i.guildId);
    if (which === 'basics')
        return i.showModal(basicsModal(cfg));
    if (which === 'mapping')
        return i.showModal(mappingModal(cfg));
    if (which === 'reminders')
        return i.showModal(remindersModal(cfg));
    throw new AppError('VALIDATION_ERROR', 'That setup form is no longer available.');
}
async function onSelect(ctx, i) {
    const parts = i.customId.split(':'); // wscfgsel:<kind>:<key?>
    const cfg = load(ctx, i.guildId);
    if (parts[1] === 'modules') {
        cfg.modules = Object.fromEntries(WORKSPACE_MODULES.map(m => [m, i.values.includes(m)]));
        saveDraft(ctx, cfg, i.user.id);
        return i.editReply(modulesScreen(cfg));
    }
    if (parts[1] === 'chan') {
        const key = parts[2];
        cfg.channels[key] = i.values[0] ?? null;
        if (key === 'reminderId')
            cfg.reminders.channelId = i.values[0] ?? null;
        saveDraft(ctx, cfg, i.user.id);
        return i.editReply(key === 'reminderId' ? remindersScreen(cfg) : channelsScreen(cfg));
    }
    if (parts[1] === 'role') {
        const key = parts[2];
        cfg.roles[key] = [...i.values];
        saveDraft(ctx, cfg, i.user.id);
        return i.editReply(rolesScreen(cfg));
    }
    throw new AppError('VALIDATION_ERROR', 'That selector is no longer available.');
}
async function onModal(ctx, i) {
    const which = i.customId.slice('wscfgmode:'.length);
    const cfg = load(ctx, i.guildId);
    const f = (id) => String(i.fields.getTextInputValue(id) ?? '').trim();
    if (which === 'basics') {
        cfg.sheets.spreadsheetId = f('spreadsheet_id');
        const name = f('department_name');
        cfg.branding.departmentName = name;
        cfg.branding.shortName = name.slice(0, 32);
        cfg.branding.memberPanelTitle = `${name} · Workspace`;
        cfg.branding.staffPanelTitle = `${name} · Staff Workspace`;
    }
    else if (which === 'mapping') {
        applyMappingJson(cfg, f('mapping') || null);
    }
    else if (which === 'reminders') {
        const tz = f('timezone');
        const [h, m] = f('time').split(':');
        const wd = Number(f('weekday'));
        const hour = Number(h), minute = Number(m);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59)
            throw new AppError('VALIDATION_ERROR', 'Time must be HH:MM in 24-hour form, e.g. 09:00.');
        if (!Number.isInteger(wd) || wd < 0 || wd > 6)
            throw new AppError('VALIDATION_ERROR', 'Weekday must be 0 (Sunday) through 6 (Saturday).');
        cfg.reminders.timezone = tz || 'UTC';
        cfg.reminders.hour = hour;
        cfg.reminders.minute = minute;
        cfg.reminders.weekday = wd;
    }
    else
        throw new AppError('VALIDATION_ERROR', 'That setup form is no longer available.');
    saveDraft(ctx, cfg, i.user.id);
    return i.editReply(home(cfg));
}
export function registerWorkspaceSetup(registry) {
    registry.component({ prefix: 'wscfg:', kinds: ['button'], metadata: wizDefer, execute: onButton });
    registry.component({ prefix: 'wscfgopen:', kinds: ['button'], metadata: wizModal, execute: onOpen });
    registry.component({ prefix: 'wscfgsel:', kinds: ['select'], metadata: wizDefer, execute: onSelect });
    registry.component({ prefix: 'wscfgmode:', kinds: ['modal'], metadata: wizDefer, execute: onModal });
}
