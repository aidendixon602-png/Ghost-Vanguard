import { AppError } from '../errors.js';
import { activeWorkspaceConfig } from './config.js';
import { sheetsFromEnv, upsertMappedRow, validateWorkbook } from './sheets.js';
import { WorkspaceStore } from './store.js';
import { writeArchiveRow } from './records.js';
export async function writeReviewRow(cfg, row, client = sheetsFromEnv()) {
    const check = await validateWorkbook(client, cfg);
    if (!check.ok)
        throw new AppError('INTEGRATION_ERROR', `Workbook headers or worksheets do not match the saved Workspace mapping:\n${check.errors.slice(0, 8).map(e => `• ${e}`).join('\n')}`);
    return upsertMappedRow(client, cfg, cfg.sheets.submissionReviews, 'submissionId', String(row.submission_id), {
        receivedDate: new Date(Number(row.received_at)).toISOString(), contributor: `${row.contributor_username} (${row.contributor_id})`, documentTitle: row.title, sourceUrl: row.source_url ?? '', assignedReviewer: row.reviewer_id ?? '', reviewStatus: row.status,
        decisionDate: row.decision_at ? new Date(Number(row.decision_at)).toISOString() : '', recordId: row.record_id ?? '', reviewNotes: row.review_notes ?? '',
    });
}
function terminal(status) { return ['Accepted', 'Restricted', 'Declined'].includes(status); }
export async function applyReviewAction(store, guildId, submissionId, actorId, action, notes, access, client, assignedReviewer) {
    const cfg = activeWorkspaceConfig(store, guildId);
    if (!cfg?.modules.reviews)
        throw new AppError('VALIDATION_ERROR', 'Reviews are disabled or Workspace setup is incomplete.');
    const ws = new WorkspaceStore(store);
    const submission = ws.submission(guildId, submissionId);
    if (!submission)
        throw new AppError('VALIDATION_ERROR', 'That Submission ID was not found.');
    const current = String(submission.status);
    if (action !== 'assign' && terminal(current) && action !== (current === 'Accepted' ? 'accept' : current === 'Restricted' ? 'restrict' : 'decline'))
        throw new AppError('VALIDATION_ERROR', `This submission is already ${current}. Refresh the queue before applying another decision.`);
    const reviewer = assignedReviewer ?? actorId;
    const target = action === 'begin' ? 'Under review' : action === 'request' ? 'Needs information' : action === 'accept' ? 'Accepted' : action === 'restrict' ? 'Restricted' : action === 'decline' ? 'Declined' : current;
    if (action === 'assign') {
        ws.updateReview(guildId, submissionId, current, actorId, notes || String(ws.review(guildId, submissionId)?.review_notes ?? ''), reviewer);
        const refreshed = ws.submission(guildId, submissionId);
        const sheetRow = await writeReviewRow(cfg, { ...refreshed, review_notes: ws.review(guildId, submissionId)?.review_notes ?? '' }, client);
        store.run('UPDATE workspace_submissions SET sheet_row=?,updated_at=? WHERE guild_id=? AND submission_id=?', sheetRow, Date.now(), guildId, submissionId);
        return { submission: ws.submission(guildId, submissionId) };
    }
    if (action === 'accept' || action === 'restrict') {
        if (!access || !cfg.review.accessChoices.includes(access))
            throw new AppError('VALIDATION_ERROR', 'An explicit access choice is required: Public, Restricted, or Staff only.');
        const existing = ws.record(guildId, String(submission.record_id ?? '')) ?? (submission.record_id ? undefined : null);
        const record = existing ?? ws.reserveRecord(guildId, submissionId, actorId, access, notes || 'Preservation pending; no archive URL has been asserted.');
        if (String(record.access_level) !== access)
            throw new AppError('VALIDATION_ERROR', 'This linked record already has a different access choice. Start a correction request instead of silently changing access.');
        if (record.operation_status !== 'written') {
            const row = await writeArchiveRow(cfg, record, client);
            ws.markRecord(guildId, String(record.record_id), 'written', actorId);
            store.run('UPDATE workspace_records SET sheet_row=?,updated_at=? WHERE guild_id=? AND record_id=?', row, Date.now(), guildId, record.record_id);
        }
        ws.updateReview(guildId, submissionId, target, actorId, notes || `Decision: ${target}. Access: ${access}.`, reviewer, String(record.record_id));
        const refreshed = ws.submission(guildId, submissionId);
        const sheetRow = await writeReviewRow(cfg, { ...refreshed, review_notes: ws.review(guildId, submissionId)?.review_notes ?? '' }, client);
        store.run('UPDATE workspace_submissions SET sheet_row=?,updated_at=? WHERE guild_id=? AND submission_id=?', sheetRow, Date.now(), guildId, submissionId);
        return { submission: refreshed, record: ws.record(guildId, String(record.record_id)) };
    }
    ws.updateReview(guildId, submissionId, target, actorId, notes, reviewer);
    const refreshed = ws.submission(guildId, submissionId);
    const sheetRow = await writeReviewRow(cfg, { ...refreshed, review_notes: ws.review(guildId, submissionId)?.review_notes ?? '' }, client);
    store.run('UPDATE workspace_submissions SET sheet_row=?,updated_at=? WHERE guild_id=? AND submission_id=?', sheetRow, Date.now(), guildId, submissionId);
    return { submission: refreshed };
}
export function reviewDetail(submission, review) {
    return [`**${submission.submission_id}** · ${submission.title}`, `Contributor: <@${submission.contributor_id}> (${submission.contributor_username})`, `Status: **${submission.status}**`, `Author / authority: ${submission.author || 'Unknown'}`, `Document date: ${submission.document_date || 'Unknown'}`, `Source: ${submission.source_url || 'Not provided'}`, `Connection: ${submission.midtown_connection || 'Not provided'}`, `Sharing permission: ${submission.sharing_permission || 'Unknown — not confirmed'}`, `Reviewer: ${review?.assigned_reviewer ? `<@${review.assigned_reviewer}>` : 'Unassigned'}`, review?.review_notes ? `Staff notes: ${review.review_notes}` : 'Staff notes: None'].join('\n');
}
