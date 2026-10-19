import { ChannelType, SlashCommandBuilder, type SlashCommandSubcommandsOnlyBuilder } from 'discord.js';
import type { CommandContext } from '../bot/registry.js';
import { AppError } from '../errors.js';
import { configWithPreset, getWorkspaceConfig, saveWorkspaceConfig, validateWorkspaceConfig } from './config.js';
import { publishWorkspacePanels, setupStatus } from './panels.js';
import { validateChannelSelection, validateRoleSelection } from './permissions.js';
import { googleCredentialsConfigured, sheetsFromEnv, validateWorkbook } from './sheets.js';
import { previewGuildStaff } from './staff.js';
import { WORKSPACE_MODULES, MIDTOWN_GUILD_ID, type WorkspaceConfig } from './types.js';

function applyMappingJson(cfg: WorkspaceConfig, raw: string | null): void {
    if (!raw) return;
    let parsed: any;
    try { parsed = JSON.parse(raw); } catch { throw new AppError('VALIDATION_ERROR', 'mapping_json must be valid JSON.'); }
    for (const key of ['archiveRegister', 'submissionReviews', 'staffRoster', 'directiveTracker']) {
        if (!parsed[key]) continue;
        if (typeof parsed[key] !== 'object') throw new AppError('VALIDATION_ERROR', `${key} mapping must be an object.`);
        const sheet = (cfg.sheets as any)[key] as { name: string; columns: Record<string, string>; headers?: Record<string, string> };
        if (parsed[key].name !== undefined) sheet.name = String(parsed[key].name);
        if (parsed[key].columns) sheet.columns = Object.fromEntries(Object.entries(parsed[key].columns).map(([field, column]) => [field, String(column).toUpperCase()]));
        if (parsed[key].headers) sheet.headers = Object.fromEntries(Object.entries(parsed[key].headers).map(([field, header]) => [field, String(header)]));
    }
}

const textChannel = (o: any, name: string, description: string) => o.setName(name).setDescription(description).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
function csvIds(raw: string | null, label: string): string[] | null {
    if (raw === null) return null;
    const ids = raw.split(',').map(value => value.trim()).filter(Boolean);
    if (ids.some(id => !/^\d{17,20}$/.test(id))) throw new AppError('VALIDATION_ERROR', `${label} must contain exact Discord IDs separated by commas.`);
    return [...new Set(ids)];
}

export function addWorkspaceSubcommands(builder: SlashCommandSubcommandsOnlyBuilder) {
    builder
    .addSubcommand(s => s.setName('workspace-setup').setDescription('Save and validate this guild’s Workspace profile')
        .addStringOption(o => o.setName('preset').setDescription('Use a generic profile or the Midtown Archives preset').addChoices({ name: 'Generic', value: 'generic' }, { name: 'Midtown Archives', value: 'midtown' }))
        .addStringOption(o => o.setName('spreadsheet_id').setDescription('Google Spreadsheet ID for this guild').setMaxLength(200))
        .addStringOption(o => o.setName('department_name').setDescription('Department or workspace name').setMaxLength(100))
        .addStringOption(o => o.setName('modules').setDescription('Comma-separated: submissions,reviews,records,tasks,staff,reports').setMaxLength(100))
        .addStringOption(o => o.setName('mapping_json').setDescription('JSON mapping for worksheet names and columns').setMaxLength(1000))
        .addChannelOption(o => textChannel(o, 'member_panel', 'Persistent member panel channel'))
        .addChannelOption(o => textChannel(o, 'staff_panel', 'Persistent staff dashboard channel'))
        .addChannelOption(o => textChannel(o, 'task_panel', 'Optional focused task panel channel'))
        .addChannelOption(o => textChannel(o, 'audit_log', 'Audit log channel'))
        .addChannelOption(o => textChannel(o, 'reminder_channel', 'Reminder destination channel'))
        .addRoleOption(o => o.setName('reviewer_role').setDescription('Role allowed to review submissions'))
        .addRoleOption(o => o.setName('manager_role').setDescription('Role allowed to decide, configure, and publish'))
        .addRoleOption(o => o.setName('staff_role').setDescription('Role shown in staff synchronization'))
        .addStringOption(o => o.setName('reviewer_roles').setDescription('Comma-separated reviewer role IDs').setMaxLength(400))
        .addStringOption(o => o.setName('manager_roles').setDescription('Comma-separated manager role IDs').setMaxLength(400))
        .addStringOption(o => o.setName('staff_roles').setDescription('Comma-separated staff role IDs').setMaxLength(400))
        .addStringOption(o => o.setName('rank_priority').setDescription('Comma-separated role IDs, highest priority first').setMaxLength(400))
        .addStringOption(o => o.setName('capacity_exclusions').setDescription('Comma-separated user IDs excluded from capacity').setMaxLength(400))
        .addIntegerOption(o => o.setName('confirmed_capacity').setDescription('Optional confirmed staffing capacity'))
        .addIntegerOption(o => o.setName('proposed_capacity').setDescription('Optional proposed staffing capacity'))
        .addStringOption(o => o.setName('timezone').setDescription('IANA timezone, for example America/Los_Angeles').setMaxLength(80))
        .addBooleanOption(o => o.setName('reminders').setDescription('Enable scheduled summaries after validation'))
        .addIntegerOption(o => o.setName('reminder_weekday').setDescription('Reminder weekday: 0 Sunday through 6 Saturday').setMinValue(0).setMaxValue(6))
        .addIntegerOption(o => o.setName('reminder_hour').setDescription('Reminder hour in the selected timezone').setMinValue(0).setMaxValue(23))
        .addIntegerOption(o => o.setName('reminder_minute').setDescription('Reminder minute').setMinValue(0).setMaxValue(59)))
    .addSubcommand(s => s.setName('workspace-publish').setDescription('Post or update the configured persistent panels')
        .addStringOption(o => o.setName('kind').setDescription('Panel to publish').setRequired(true).addChoices({ name: 'All configured panels', value: 'all' }, { name: 'Member', value: 'member' }, { name: 'Staff', value: 'staff' }, { name: 'Tasks', value: 'tasks' })))
    .addSubcommand(s => s.setName('workspace-status').setDescription('Show Workspace setup status'))
    .addSubcommand(s => s.setName('workspace-enable').setDescription('Enable the validated Workspace integration'))
    .addSubcommand(s => s.setName('workspace-disable').setDescription('Disable Workspace and stop its reminders without deleting records'))
    .addSubcommand(s => s.setName('workspace-sync').setDescription('Preview and synchronize recognized staff members'));
    return builder;
}

export async function executeWorkspaceSubcommand(ctx: CommandContext, i: any) {
        const guild = i.guild;
        const sub = i.options.getSubcommand().replace(/^workspace-/, '');
        if (sub === 'status') {
            const status = setupStatus(ctx.store, guild.id);
            const cfg = getWorkspaceConfig(ctx.store, guild.id);
            return [`**Workspace:** ${cfg?.branding.departmentName ?? 'not configured'}`, `**Enabled:** ${status.enabled ? 'yes' : 'no'}`, `**Workbook validated:** ${status.validated ? 'yes' : 'no'}`, `**Modules:** ${cfg ? Object.entries(cfg.modules).filter(([, enabled]) => enabled).map(([name]) => name).join(', ') || 'none' : 'none'}`, status.errors.length ? `\n${status.errors.map(e => `• ${e}`).join('\n')}` : 'Ready for configured users.'].join('\n');
        }
        if (sub === 'disable') {
            const cfg = getWorkspaceConfig(ctx.store, guild.id);
            if (!cfg) return 'Workspace is not configured in this guild.';
            cfg.enabled = false; cfg.disabledAt = Date.now(); saveWorkspaceConfig(ctx.store, cfg, i.user.id);
            return 'Workspace is disabled for this guild. Existing records and audit history were preserved; scheduled reminders stopped.';
        }
        if (sub === 'enable') {
            const cfg = getWorkspaceConfig(ctx.store, guild.id);
            if (!cfg) throw new AppError('VALIDATION_ERROR', 'Run `/setup config workspace-setup` first.');
            const errors = validateWorkspaceConfig(cfg);
            if (!cfg.validatedAt || errors.length) throw new AppError('VALIDATION_ERROR', `Workspace is not ready to enable.\n${errors.map(e => `• ${e}`).join('\n')}`);
            cfg.enabled = true; cfg.disabledAt = null; saveWorkspaceConfig(ctx.store, cfg, i.user.id);
            return 'Workspace is enabled. Existing panels will work after they are published or updated with `/setup config workspace-publish`.';
        }
        if (sub === 'publish') {
            const kind = i.options.getString('kind', true) as 'all' | 'member' | 'staff' | 'tasks';
            const kinds = kind === 'all' ? ['member', 'staff', 'tasks'] as ('member' | 'staff' | 'tasks')[] : [kind];
            const posted = await publishWorkspacePanels(ctx.store, guild, i.user.id, kinds);
            return posted.length ? `Workspace panels are ready.\n${posted.map(line => `• ${line}`).join('\n')}` : 'No panel was posted. Check the selected panel channels and enabled modules.';
        }
        if (sub === 'sync') {
            const preview = await previewGuildStaff(ctx.store, guild);
            const summary = preview.changes.slice(0, 20).map(c => `${c.kind}: \`${c.userId}\``).join('\n') || 'No changes detected.';
            return `Staff synchronization preview only; no roster rows were changed. **${preview.changes.length}** changes would be applied after confirmation.\n${summary}${preview.changes.length > 20 ? `\n…and ${preview.changes.length - 20} more.` : ''}\n\nUse the Staff panel’s Refresh Staff button to review and confirm the same preview before applying it.`;
        }
        const preset = i.options.getString('preset');
        const cfg = preset ? configWithPreset(guild.id, preset === 'midtown') : getWorkspaceConfig(ctx.store, guild.id) ?? configWithPreset(guild.id, false);
        if (preset === 'midtown' && guild.id !== MIDTOWN_GUILD_ID) throw new AppError('VALIDATION_ERROR', 'The Midtown Archives preset is restricted to its configured guild and cannot be copied into another server. Use the generic profile.');
        const spreadsheetId = i.options.getString('spreadsheet_id');
        if (spreadsheetId !== null) cfg.sheets.spreadsheetId = spreadsheetId.trim();
        const department = i.options.getString('department_name');
        if (department !== null) { cfg.branding.departmentName = department.trim(); cfg.branding.shortName = department.trim().slice(0, 32); cfg.branding.memberPanelTitle = `${department.trim()} · Workspace`; cfg.branding.staffPanelTitle = `${department.trim()} · Staff Workspace`; }
        const modules = i.options.getString('modules');
        if (modules !== null) {
            const chosen = modules.split(',').map((v: string) => v.trim()).filter(Boolean);
            const invalid = chosen.filter((v: string) => !(WORKSPACE_MODULES as readonly string[]).includes(v));
            if (invalid.length) throw new AppError('VALIDATION_ERROR', `Unknown Workspace module(s): ${invalid.join(', ')}.`);
            cfg.modules = Object.fromEntries(WORKSPACE_MODULES.map(name => [name, chosen.includes(name)])) as WorkspaceConfig['modules'];
        }
        applyMappingJson(cfg, i.options.getString('mapping_json'));
        const channels: [string, keyof WorkspaceConfig['channels']][] = [['member_panel', 'memberPanelId'], ['staff_panel', 'staffPanelId'], ['task_panel', 'taskPanelId'], ['audit_log', 'auditLogId'], ['reminder_channel', 'reminderId']];
        for (const [option, key] of channels) {
            const channel = i.options.getChannel(option);
            if (!channel) continue;
            (cfg.channels[key] as string | null) = channel.id;
            if (key === 'reminderId') cfg.reminders.channelId = channel.id;
        }
        const reviewer = i.options.getRole('reviewer_role'); const manager = i.options.getRole('manager_role'); const staff = i.options.getRole('staff_role');
        if (reviewer) cfg.roles.reviewerRoleIds = [...new Set([...cfg.roles.reviewerRoleIds, reviewer.id])];
        if (manager) cfg.roles.managerRoleIds = [...new Set([...cfg.roles.managerRoleIds, manager.id])];
        if (staff) cfg.roles.staffRoleIds = [...new Set([...cfg.roles.staffRoleIds, staff.id])];
        const reviewerRoles = csvIds(i.options.getString('reviewer_roles'), 'Reviewer roles'); if (reviewerRoles) cfg.roles.reviewerRoleIds = reviewerRoles;
        const managerRoles = csvIds(i.options.getString('manager_roles'), 'Manager roles'); if (managerRoles) cfg.roles.managerRoleIds = managerRoles;
        const staffRoles = csvIds(i.options.getString('staff_roles'), 'Staff roles'); if (staffRoles) cfg.roles.staffRoleIds = staffRoles;
        const priorityRoles = csvIds(i.options.getString('rank_priority'), 'Rank priority'); if (priorityRoles) cfg.roles.rankPriority = priorityRoles;
        const capacityExclusions = csvIds(i.options.getString('capacity_exclusions'), 'Capacity exclusions'); if (capacityExclusions) cfg.roles.excludeFromCapacityUserIds = capacityExclusions;
        const confirmedCapacity = i.options.getInteger('confirmed_capacity'); if (confirmedCapacity !== null) cfg.roles.confirmedCapacity = confirmedCapacity;
        const proposedCapacity = i.options.getInteger('proposed_capacity'); if (proposedCapacity !== null) cfg.roles.proposedCapacity = proposedCapacity;
        const timezone = i.options.getString('timezone'); if (timezone) cfg.reminders.timezone = timezone.trim();
        const reminders = i.options.getBoolean('reminders'); if (reminders !== null) cfg.reminders.enabled = reminders;
        const weekday = i.options.getInteger('reminder_weekday'); if (weekday !== null) cfg.reminders.weekday = weekday;
        const hour = i.options.getInteger('reminder_hour'); if (hour !== null) cfg.reminders.hour = hour;
        const minute = i.options.getInteger('reminder_minute'); if (minute !== null) cfg.reminders.minute = minute;
        const resourceErrors = [...validateChannelSelection(guild, cfg.channels.memberPanelId, 'Member panel'), ...validateChannelSelection(guild, cfg.channels.staffPanelId, 'Staff panel'), ...validateChannelSelection(guild, cfg.channels.taskPanelId, 'Task panel'), ...validateChannelSelection(guild, cfg.channels.auditLogId, 'Audit log'), ...validateChannelSelection(guild, cfg.channels.reminderId, 'Reminder channel'), ...validateRoleSelection(guild, cfg.roles.reviewerRoleIds, 'Reviewer roles'), ...validateRoleSelection(guild, cfg.roles.managerRoleIds, 'Manager roles'), ...validateRoleSelection(guild, cfg.roles.staffRoleIds, 'Staff roles'), ...validateRoleSelection(guild, cfg.roles.rankPriority, 'Rank priority roles')];
        const errors = [...resourceErrors, ...validateWorkspaceConfig(cfg)];
        if (errors.length) throw new AppError('VALIDATION_ERROR', `Workspace setup was not saved because validation failed:\n${errors.map(e => `• ${e}`).join('\n')}`);
        if (!googleCredentialsConfigured()) throw new AppError('INTEGRATION_ERROR', 'Workspace setup is not enabled until Google authentication is configured. Set the documented service-account or access-token environment variables, share the workbook with that identity, then rerun setup.');
        const check = await validateWorkbook(sheetsFromEnv(), cfg);
        if (!check.ok) throw new AppError('INTEGRATION_ERROR', `Live workbook validation failed; no Workspace writes were enabled:\n${check.errors.map(e => `• ${e}`).join('\n')}`);
        cfg.enabled = true; cfg.validatedAt = Date.now(); cfg.updatedBy = i.user.id; saveWorkspaceConfig(ctx.store, cfg, i.user.id);
        return `Workspace setup is validated and enabled for **${cfg.branding.departmentName}**.\n**Workbook:** \`${cfg.sheets.spreadsheetId}\`\n**Modules:** ${Object.entries(cfg.modules).filter(([, on]) => on).map(([name]) => name).join(', ') || 'none'}\n\nNext: run \/setup config workspace-publish with the configured panel channels. Channel names were not used as IDs; selected Discord resource IDs were saved.`;
}
