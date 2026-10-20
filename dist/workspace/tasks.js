import { AppError } from '../errors.js';
import { activeWorkspaceConfig } from './config.js';
import { sheetsFromEnv, upsertMappedRow, validateWorkbook } from './sheets.js';
import { WorkspaceStore, safeTaskPriority } from './store.js';
export function parseDueDate(value) {
    if (!value.trim())
        return null;
    const at = Date.parse(`${value.trim()}T23:59:59Z`);
    if (!Number.isFinite(at))
        throw new AppError('VALIDATION_ERROR', 'Use a due date in YYYY-MM-DD format.');
    return at;
}
export async function writeTaskRow(cfg, row, client = sheetsFromEnv()) {
    const check = await validateWorkbook(client, cfg);
    if (!check.ok)
        throw new AppError('INTEGRATION_ERROR', `Workbook headers or worksheets do not match the saved Workspace mapping:\n${check.errors.slice(0, 8).map(e => `• ${e}`).join('\n')}`);
    return upsertMappedRow(client, cfg, cfg.sheets.directiveTracker, 'taskId', String(row.task_id), {
        description: row.description, issuedDate: new Date(Number(row.issued_at)).toISOString(), issuedBy: row.issued_by, assignedTo: row.owner_id ?? '', dueDate: row.due_at ? new Date(Number(row.due_at)).toISOString().slice(0, 10) : '', status: row.status, priority: row.priority, completedDate: row.completed_at ? new Date(Number(row.completed_at)).toISOString() : '', notes: row.notes ?? '',
    });
}
export async function createAndWriteTask(store, guildId, actorId, draft, client) {
    const cfg = activeWorkspaceConfig(store, guildId);
    if (!cfg?.modules.tasks)
        throw new AppError('VALIDATION_ERROR', 'Tasks are disabled or Workspace setup is incomplete.');
    if (!draft.description.trim())
        throw new AppError('VALIDATION_ERROR', 'A task description is required.');
    if (draft.ownerId && !/^\d{17,20}$/.test(draft.ownerId))
        throw new AppError('VALIDATION_ERROR', 'Assigned owner must be an exact Discord user ID.');
    parseDueDate(draft.dueDate);
    const row = new WorkspaceStore(store).createTask(guildId, actorId, { ...draft, priority: safeTaskPriority(draft.priority) });
    try {
        const sheetRow = await writeTaskRow(cfg, row, client);
        store.run('UPDATE workspace_tasks SET sheet_row=?,updated_at=? WHERE guild_id=? AND task_id=?', sheetRow, Date.now(), guildId, row.task_id);
    }
    catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 500) : 'Google Sheets write failed';
        store.run('UPDATE workspace_tasks SET notes=?,updated_at=? WHERE guild_id=? AND task_id=?', `${row.notes ?? ''}\nSheet sync pending: ${message}`.trim(), Date.now(), guildId, row.task_id);
        throw error;
    }
    return new WorkspaceStore(store).task(guildId, String(row.task_id));
}
export async function updateAndWriteTask(store, guildId, taskId, actorId, change, client) {
    const cfg = activeWorkspaceConfig(store, guildId);
    if (!cfg?.modules.tasks)
        throw new AppError('VALIDATION_ERROR', 'Tasks are disabled or Workspace setup is incomplete.');
    const ws = new WorkspaceStore(store);
    if (!ws.task(guildId, taskId))
        throw new AppError('VALIDATION_ERROR', 'That Task ID was not found.');
    ws.updateTask(guildId, taskId, actorId, change);
    const row = ws.task(guildId, taskId);
    const sheetRow = await writeTaskRow(cfg, row, client);
    store.run('UPDATE workspace_tasks SET sheet_row=?,updated_at=? WHERE guild_id=? AND task_id=?', sheetRow, Date.now(), guildId, taskId);
    return ws.task(guildId, taskId);
}
export function taskText(row) {
    const due = row.due_at ? `<t:${Math.floor(Number(row.due_at) / 1000)}:d>` : 'No deadline';
    const owner = row.owner_id ? `<@${row.owner_id}>` : 'Unassigned';
    return `**${row.task_id}** · ${row.description}\nOwner: ${owner} · Due: ${due} · Priority: **${row.priority}** · Status: **${row.status}**${row.notes ? `\nNotes: ${row.notes}` : ''}`;
}
