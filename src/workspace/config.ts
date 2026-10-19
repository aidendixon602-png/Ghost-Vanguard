import type { Store } from '../database/db.js';
import {
    MIDTOWN_GUILD_ID, MIDTOWN_PRESET, WORKSPACE_MODULES, type WorkspaceBranding, type WorkspaceChannels,
    type WorkspaceConfig, type WorkspaceForms, type WorkspaceModule, type WorkspaceReminders, type WorkspaceReviewConfig,
    type WorkspaceRoles, type WorkspaceSheets,
} from './types.js';

const ID = /^\d{17,20}$/;
const SPREADSHEET_ID = /^[A-Za-z0-9_-]{20,}$/;
const COLUMN = /^[A-Z]{1,3}$/;

export const GENERIC_BRANDING: WorkspaceBranding = {
    departmentName: 'Workspace', shortName: 'Workspace', description: 'A configurable Discord workspace.', primaryColor: 0x304a75, accentColor: 0xc9a646,
    memberPanelTitle: 'Workspace', memberPanelDescription: 'Use the buttons below to work with this server’s configured workspace.',
    staffPanelTitle: 'Workspace · Staff', staffPanelDescription: 'Manage the modules enabled for this server.',
    buttonLabels: { submit: 'Submit', mine: 'My Submissions', help: 'Help', queue: 'Review Queue', records: 'Records', tasks: 'Tasks', staff: 'Staff', reports: 'Reports', settings: 'Settings' },
};

export const GENERIC_FORMS: WorkspaceForms = { submission: {
    titleLabel: 'Title', sourceLabel: 'Author / source link', dateLabel: 'Date', connectionLabel: 'Connection',
    permissionLabel: 'Sharing permission / restrictions', notesLabel: 'Additional notes', requireSource: false, requireConnection: true,
} };
export const GENERIC_REVIEW: WorkspaceReviewConfig = { statuses: ['Received', 'Under review', 'Needs information', 'Accepted', 'Restricted', 'Declined'], accessChoices: ['Public', 'Restricted', 'Staff only'], managerCanDecide: true, reviewerCanRequestInformation: true, publicPostingEnabled: false };
export const GENERIC_ROLES: WorkspaceRoles = { reviewerRoleIds: [], managerRoleIds: [], staffRoleIds: [], rankPriority: [], preserveExistingRoster: true, confirmedCapacity: null, proposedCapacity: null, excludeFromCapacityUserIds: [] };
export const GENERIC_CHANNELS: WorkspaceChannels = { memberPanelId: null, staffPanelId: null, taskPanelId: null, documentEntryId: null, directiveEntryId: null, auditLogId: null, reminderId: null, publicDocumentsId: null, publicArchiveNotificationsId: null };
export const GENERIC_REMINDERS: WorkspaceReminders = { enabled: false, channelId: null, schedule: 'weekly', timezone: 'UTC', weekday: 1, hour: 9, minute: 0, mentionResponsible: false };

export const EMPTY_SHEETS = (): WorkspaceSheets => ({
    spreadsheetId: '', headerRow: 7, firstDataRow: 8, lastDataRow: 207, allowExpansion: false,
    archiveRegister: { name: 'Archive Register', headerRow: 7, firstDataRow: 8, lastDataRow: 207, columns: {} },
    submissionReviews: { name: 'Submission Reviews', headerRow: 7, firstDataRow: 8, lastDataRow: 207, columns: {} },
    staffRoster: { name: 'Staff Roster', headerRow: 7, firstDataRow: 8, lastDataRow: 207, columns: {} },
    directiveTracker: { name: 'Directive Tracker', headerRow: 7, firstDataRow: 8, lastDataRow: 207, columns: {} },
});

export function genericConfig(guildId: string): WorkspaceConfig {
    return { guildId, enabled: false, modules: Object.fromEntries(WORKSPACE_MODULES.map(m => [m, true])) as Record<WorkspaceModule, boolean>,
        branding: structuredClone(GENERIC_BRANDING), forms: structuredClone(GENERIC_FORMS), review: structuredClone(GENERIC_REVIEW),
        roles: structuredClone(GENERIC_ROLES), channels: structuredClone(GENERIC_CHANNELS), sheets: EMPTY_SHEETS(), reminders: structuredClone(GENERIC_REMINDERS), updatedAt: Date.now(), validatedAt: null, disabledAt: null, updatedBy: null };
}

function merge<T>(base: T, value: unknown): T {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return base;
    const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (item && typeof item === 'object' && !Array.isArray(item) && out[key] && typeof out[key] === 'object') out[key] = merge(out[key], item);
        else out[key] = item;
    }
    return out;
}

export function parseWorkspaceConfig(guildId: string, row: Record<string, any>): WorkspaceConfig {
    const base = guildId === MIDTOWN_GUILD_ID ? { ...genericConfig(guildId), ...structuredClone(MIDTOWN_PRESET), updatedAt: Number(row.updated_at ?? Date.now()) } : genericConfig(guildId);
    const read = (key: string) => { try { return JSON.parse(String(row[key] ?? '{}')); } catch { return {}; } };
    const result = merge(base, { enabled: !!row.enabled, modules: read('modules_json'), branding: read('branding_json'), forms: read('forms_json'), review: read('review_json'), roles: read('roles_json'), channels: read('channels_json'), sheets: read('sheets_json'), reminders: read('reminders_json'), updatedBy: row.updated_by ?? null, updatedAt: Number(row.updated_at ?? Date.now()), validatedAt: row.validated_at == null ? null : Number(row.validated_at), disabledAt: row.disabled_at == null ? null : Number(row.disabled_at) });
    result.guildId = guildId;
    if (!result.reminders.channelId && result.channels.reminderId) result.reminders.channelId = result.channels.reminderId;
    if (!result.channels.reminderId && result.reminders.channelId) result.channels.reminderId = result.reminders.channelId;
    return result;
}

export function getWorkspaceConfig(store: Store, guildId: string): WorkspaceConfig | null {
    const row = store.get('SELECT * FROM workspace_config WHERE guild_id=?', guildId);
    return row ? parseWorkspaceConfig(guildId, row) : null;
}

export function activeWorkspaceConfig(store: Store, guildId: string): WorkspaceConfig | null {
    const cfg = getWorkspaceConfig(store, guildId);
    return cfg?.enabled && cfg.validatedAt ? cfg : null;
}

export function validateWorkspaceConfig(cfg: WorkspaceConfig): string[] {
    const errors: string[] = [];
    if (!ID.test(cfg.guildId)) errors.push('Guild ID is invalid.');
    if (!SPREADSHEET_ID.test(cfg.sheets.spreadsheetId)) errors.push('A valid spreadsheet ID is required.');
    if (!Number.isInteger(cfg.sheets.headerRow) || cfg.sheets.headerRow < 1) errors.push('Header row must be a positive integer.');
    if (!Number.isInteger(cfg.sheets.firstDataRow) || !Number.isInteger(cfg.sheets.lastDataRow) || cfg.sheets.firstDataRow > cfg.sheets.lastDataRow) errors.push('Data row range is invalid.');
    const mappings: [string, any][] = [];
    if (cfg.modules.records) mappings.push(['archiveRegister', cfg.sheets.archiveRegister]);
    if (cfg.modules.submissions || cfg.modules.reviews) mappings.push(['submissionReviews', cfg.sheets.submissionReviews]);
    if (cfg.modules.staff) mappings.push(['staffRoster', cfg.sheets.staffRoster]);
    if (cfg.modules.tasks) mappings.push(['directiveTracker', cfg.sheets.directiveTracker]);
    for (const [key, sheet] of mappings) {
        if (!sheet.name?.trim()) errors.push(`${key} worksheet name is required.`);
        if (!Number.isInteger(sheet.headerRow) || !Number.isInteger(sheet.firstDataRow) || !Number.isInteger(sheet.lastDataRow) || sheet.firstDataRow > sheet.lastDataRow) errors.push(`${key} row range is invalid.`);
        for (const [field, column] of Object.entries(sheet.columns ?? {})) if (!COLUMN.test(String(column))) errors.push(`${key}.${field} has an invalid column reference.`);
    }
    for (const [name, id] of Object.entries(cfg.channels)) if (id !== null && !ID.test(String(id))) errors.push(`Channel ${name} must be a Discord channel ID selected from this guild.`);
    for (const [name, ids] of Object.entries(cfg.roles)) if ((name.endsWith('RoleIds') || name === 'rankPriority' || name === 'excludeFromCapacityUserIds') && (!Array.isArray(ids) || ids.some(id => !ID.test(String(id))))) errors.push(`${name} contains an invalid Discord user or role ID.`);
    for (const [name, capacity] of Object.entries({ confirmedCapacity: cfg.roles.confirmedCapacity, proposedCapacity: cfg.roles.proposedCapacity }) as [string, number | null | undefined][]) if (capacity !== null && capacity !== undefined && (!Number.isInteger(capacity) || capacity < 0 || capacity > 100000)) errors.push(`${name} must be a non-negative whole number.`);
    if (!cfg.branding.departmentName.trim()) errors.push('Department name is required.');
    if (cfg.reminders.enabled) {
        if (!cfg.reminders.channelId || !ID.test(cfg.reminders.channelId)) errors.push('Reminder channel must be selected before reminders are enabled.');
        if (!cfg.reminders.timezone || !/^[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/.test(cfg.reminders.timezone) && cfg.reminders.timezone !== 'UTC') errors.push('Reminder timezone must be an IANA timezone.');
        if (!Number.isInteger(cfg.reminders.hour) || cfg.reminders.hour < 0 || cfg.reminders.hour > 23 || !Number.isInteger(cfg.reminders.minute) || cfg.reminders.minute < 0 || cfg.reminders.minute > 59) errors.push('Reminder time is invalid.');
    }
    if (cfg.modules.submissions && (!cfg.sheets.submissionReviews.columns.submissionId || !cfg.sheets.submissionReviews.columns.title)) errors.push('Submission Reviews must map submissionId and title.');
    if (cfg.modules.records && (!cfg.sheets.archiveRegister.columns.recordId || !cfg.sheets.archiveRegister.columns.title)) errors.push('Archive Register must map recordId and title.');
    if (cfg.modules.tasks && (!cfg.sheets.directiveTracker.columns.taskId || !cfg.sheets.directiveTracker.columns.description)) errors.push('Directive Tracker must map taskId and description.');
    if (cfg.modules.staff && (!cfg.sheets.staffRoster.columns.userId || !cfg.sheets.staffRoster.columns.username)) errors.push('Staff Roster must map userId and username.');
    return errors;
}

export function configWithPreset(guildId: string, preset = false): WorkspaceConfig {
    if (preset && guildId === MIDTOWN_GUILD_ID) return { ...structuredClone(MIDTOWN_PRESET), guildId, updatedAt: Date.now(), validatedAt: null, updatedBy: null };
    return genericConfig(guildId);
}

export function saveWorkspaceConfig(store: Store, cfg: WorkspaceConfig, actor: string) {
    const existing = getWorkspaceConfig(store, cfg.guildId);
    const now = Date.now();
    store.run(`INSERT INTO workspace_config(guild_id,enabled,modules_json,branding_json,forms_json,review_json,roles_json,channels_json,sheets_json,reminders_json,updated_by,updated_at,validated_at,disabled_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET enabled=excluded.enabled,modules_json=excluded.modules_json,branding_json=excluded.branding_json,forms_json=excluded.forms_json,review_json=excluded.review_json,roles_json=excluded.roles_json,channels_json=excluded.channels_json,sheets_json=excluded.sheets_json,reminders_json=excluded.reminders_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at,validated_at=excluded.validated_at,disabled_at=excluded.disabled_at`,
        cfg.guildId, Number(cfg.enabled), JSON.stringify(cfg.modules), JSON.stringify(cfg.branding), JSON.stringify(cfg.forms), JSON.stringify(cfg.review), JSON.stringify(cfg.roles), JSON.stringify(cfg.channels), JSON.stringify(cfg.sheets), JSON.stringify(cfg.reminders), actor, now, cfg.validatedAt ?? null, cfg.disabledAt ?? null);
    store.history(cfg.guildId, 'workspace/config', existing, cfg, actor);
}

export function setWorkspaceEnabled(store: Store, guildId: string, enabled: boolean, actor: string) {
    const cfg = getWorkspaceConfig(store, guildId);
    if (!cfg) return;
    cfg.enabled = enabled;
    cfg.disabledAt = enabled ? null : Date.now();
    saveWorkspaceConfig(store, cfg, actor);
}
