import { AppError } from '../errors.js';
import type { Row, Store } from '../database/db.js';
import { activeWorkspaceConfig } from './config.js';
import { sheetsFromEnv, type SheetsClient, upsertMappedRow, validateWorkbook } from './sheets.js';
import { WorkspaceStore } from './store.js';
import type { SubmissionDraft } from './types.js';

const urlPattern = /https?:\/\/[^\s<>]+/i;
const trim = (value: unknown, max: number) => String(value ?? '').trim().slice(0, max);

export function parseSourceField(value: string): { author: string; sourceUrl: string } {
    const sourceUrl = value.match(urlPattern)?.[0] ?? '';
    const author = value.replace(sourceUrl, '').trim().replace(/^[-–—|]+|[-–—|]+$/g, '').trim();
    return { author, sourceUrl };
}

export function validateSubmissionDraft(draft: SubmissionDraft, required = { source: false, connection: true }): string[] {
    const errors: string[] = [];
    if (!draft.title.trim()) errors.push('A document title is required.');
    if (draft.title.length > 200) errors.push('The document title is too long.');
    if (required.source && !draft.sourceUrl) errors.push('A permitted source link is required by this Workspace profile.');
    if (draft.sourceUrl) {
        try { const u = new URL(draft.sourceUrl); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error(); } catch { errors.push('The source link must be a valid HTTP(S) URL without credentials.'); }
    }
    if (required.connection && !draft.connection.trim()) errors.push('Explain the connection to this department or workflow.');
    if (draft.sharingPermission.trim().toLowerCase().includes('confirmed public') && !/https?:\/\//i.test(draft.sharingPermission)) errors.push('Do not treat unclear sharing permission as confirmed. State what is known or unknown.');
    return errors;
}

export function reviewNotes(draft: SubmissionDraft): string {
    return [draft.author ? `Author / authority: ${draft.author}` : 'Author / authority: Not provided', draft.documentDate ? `Document date: ${draft.documentDate}` : 'Document date: Unknown', draft.connection ? `Connection: ${draft.connection}` : 'Connection: Not provided', draft.sharingPermission ? `Sharing permission / restrictions: ${draft.sharingPermission}` : 'Sharing permission / restrictions: Unknown', draft.notes ? `Additional notes: ${draft.notes}` : 'Additional notes: None'].join('\n');
}

export async function writeSubmissionRow(cfg: NonNullable<ReturnType<typeof activeWorkspaceConfig>>, row: Row, client: SheetsClient = sheetsFromEnv()): Promise<number> {
    const check = await validateWorkbook(client, cfg);
    if (!check.ok) throw new AppError('INTEGRATION_ERROR', `Workbook headers or worksheets do not match the saved Workspace mapping:\n${check.errors.slice(0, 8).map(e => `• ${e}`).join('\n')}`);
    return upsertMappedRow(client, cfg, cfg.sheets.submissionReviews, 'submissionId', String(row.submission_id), {
        receivedDate: new Date(Number(row.received_at)).toISOString(), contributor: `${row.contributor_username} (${row.contributor_id})`, documentTitle: row.title,
        sourceUrl: row.source_url ?? '', assignedReviewer: row.reviewer_id ?? '', reviewStatus: row.status, decisionDate: row.decision_at ? new Date(Number(row.decision_at)).toISOString() : '', recordId: row.record_id ?? '', reviewNotes: reviewNotes({ title: String(row.title), author: String(row.author ?? ''), sourceUrl: String(row.source_url ?? ''), documentDate: String(row.document_date ?? ''), connection: String(row.midtown_connection ?? ''), sharingPermission: String(row.sharing_permission ?? ''), restrictions: String(row.restrictions ?? ''), notes: String(row.notes ?? '') }),
    });
}

export async function createAndWriteSubmission(store: Store, guildId: string, contributorId: string, contributorUsername: string, draft: SubmissionDraft, reference: string | null, client?: SheetsClient): Promise<Row> {
    const cfg = activeWorkspaceConfig(store, guildId);
    if (!cfg) throw new AppError('VALIDATION_ERROR', 'Workspace setup is incomplete or disabled in this guild.');
    if (!cfg.modules.submissions) throw new AppError('VALIDATION_ERROR', 'Submissions are disabled in this guild.');
    const errors = validateSubmissionDraft(draft, { source: cfg.forms.submission.requireSource, connection: cfg.forms.submission.requireConnection });
    if (errors.length) throw new AppError('VALIDATION_ERROR', errors.join('\n'));
    const ws = new WorkspaceStore(store);
    const row = ws.createSubmission(guildId, contributorId, contributorUsername, { ...draft, title: trim(draft.title, 200), author: trim(draft.author, 300), sourceUrl: trim(draft.sourceUrl, 2000), documentDate: trim(draft.documentDate, 100), connection: trim(draft.connection, 1000), sharingPermission: trim(draft.sharingPermission, 1000), restrictions: trim(draft.restrictions, 1000), notes: trim(draft.notes, 3000) }, reference);
    try {
        const sheetRow = await writeSubmissionRow(cfg, store.get('SELECT * FROM workspace_submissions WHERE guild_id=? AND submission_id=?', guildId, row.submissionId)!, client);
        store.run('UPDATE workspace_submissions SET sheet_row=?,updated_at=? WHERE guild_id=? AND submission_id=?', sheetRow, Date.now(), guildId, row.submissionId);
    } catch (error) {
        store.run('UPDATE workspace_submissions SET last_error=?,updated_at=? WHERE guild_id=? AND submission_id=?', error instanceof Error ? error.message.slice(0, 500) : 'Google Sheets write failed', Date.now(), guildId, row.submissionId);
        throw error;
    }
    ws.audit(guildId, contributorId, 'submission/sheet-written', row.submissionId, 'Submission Reviews row created or updated.');
    return store.get('SELECT * FROM workspace_submissions WHERE guild_id=? AND submission_id=?', guildId, row.submissionId)!;
}

export function submissionReceipt(row: Row): string {
    return `Your submission was received.\n\n**Submission ID:** \`${row.submission_id}\`\n**Status:** ${row.status}\n**Received:** <t:${Math.floor(Number(row.received_at) / 1000)}:f>\n\nKeep this ID for questions or corrections. Staff will not treat unclear source or sharing details as confirmed facts.`;
}

export function memberSubmissionText(rows: Row[]): string {
    if (!rows.length) return 'You have no submissions in this Workspace yet.';
    return rows.map(row => `**${row.submission_id}** · ${row.title}\nStatus: **${row.status}** · Received <t:${Math.floor(Number(row.received_at) / 1000)}:R>`).join('\n\n');
}
