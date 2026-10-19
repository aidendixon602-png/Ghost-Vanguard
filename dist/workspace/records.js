import { AppError } from '../errors.js';
import { activeWorkspaceConfig } from './config.js';
import { sheetsFromEnv, upsertMappedRow, validateWorkbook } from './sheets.js';
import { WorkspaceStore } from './store.js';
export async function writeArchiveRow(cfg, row, client = sheetsFromEnv()) {
    const check = await validateWorkbook(client, cfg);
    if (!check.ok)
        throw new AppError('INTEGRATION_ERROR', `Workbook headers or worksheets do not match the saved Workspace mapping:\n${check.errors.slice(0, 8).map(e => `• ${e}`).join('\n')}`);
    return upsertMappedRow(client, cfg, cfg.sheets.archiveRegister, 'recordId', String(row.record_id), {
        title: row.title, documentDate: row.document_date ?? '', author: row.author ?? '', sourceUrl: row.source_url ?? '', midtownConnection: row.midtown_connection ?? '', accessLevel: row.access_level,
        recordStatus: row.record_status, archiveUrl: row.archive_url ?? '', reviewedBy: row.reviewed_by ? `<@${row.reviewed_by}>` : '', reviewDate: row.review_date ? new Date(Number(row.review_date)).toISOString() : '', notes: row.notes ?? '',
    });
}
export async function requestCorrection(store, guildId, recordId, actorId, issue, evidence, reference) {
    const cfg = activeWorkspaceConfig(store, guildId);
    if (!cfg?.modules.records)
        throw new AppError('VALIDATION_ERROR', 'Records are disabled or Workspace setup is incomplete.');
    const ws = new WorkspaceStore(store);
    const record = ws.record(guildId, recordId);
    if (!record)
        throw new AppError('VALIDATION_ERROR', 'That Record ID was not found.');
    const detail = `Correction requested by <@${actorId}>. Issue: ${issue}. Evidence: ${evidence || 'None provided'}. Reference: ${reference || 'None provided'}`;
    store.run("UPDATE workspace_records SET record_status='Needs correction',notes=?,updated_at=? WHERE guild_id=? AND record_id=?", `${record.notes ?? ''}\n${detail}`.trim(), Date.now(), guildId, recordId);
    ws.audit(guildId, actorId, 'record/correction-requested', recordId, detail);
    return ws.record(guildId, recordId);
}
export function recordDetail(row) {
    return [`**${row.record_id}** · ${row.title}`, `Access: **${row.access_level}** · Status: **${row.record_status}**`, row.author ? `Author / authority: ${row.author}` : 'Author / authority: Not provided', row.document_date ? `Document date: ${row.document_date}` : 'Document date: Unknown', row.source_url ? `Source: ${row.source_url}` : 'Source: Not provided', row.archive_url ? `Archive: ${row.archive_url}` : 'Preserved copy / archive URL: **pending**', row.notes ? `Notes: ${row.notes}` : 'Notes: None'].join('\n');
}
