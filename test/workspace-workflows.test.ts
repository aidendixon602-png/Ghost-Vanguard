import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/database/db.js';
import { authorize } from './helpers.js';
import { saveWorkspaceConfig } from '../src/workspace/config.js';
import { createAndWriteSubmission } from '../src/workspace/submissions.js';
import { applyReviewAction } from '../src/workspace/reviews.js';
import { MemorySheets } from '../src/workspace/sheets.js';
import { MIDTOWN_PRESET } from '../src/workspace/types.js';

function workbook() {
    return new MemorySheets({
        'Archive Register': [...Array(6).fill([]), ['Record ID', 'Title', 'Document Date', 'Author / Authority', 'Source URL', 'Midtown Connection', 'Access Level', 'Record Status', 'Archive URL', 'Reviewed By', 'Review Date', 'Notes', 'Next Action']],
        'Submission Reviews': [...Array(6).fill([]), ['Submission ID', 'Received Date', 'Contributor', 'Document Title', 'Source URL', 'Assigned Reviewer', 'Review Status', 'Decision Date', 'Record ID', 'Review Notes', 'Next Action']],
        'Staff Roster': [...Array(6).fill([]), ['Discord Username', 'Discord User ID', 'Role', 'Roster Status', 'Joined Date', 'Last Review', 'Updated', 'Reference', 'Discord Mention', 'Staff Notes']],
        'Directive Tracker': [...Array(6).fill([]), ['Directive ID', 'Directive / Task', 'Issued Date', 'Issued By', 'Assigned To', 'Due Date', 'Status', 'Priority', 'Completed Date', 'Days Overdue', 'Notes', 'Next Action']],
    });
}

test('accepted material creates one linked record and retries reuse the same IDs', async () => {
    const guild = '333333333333333333';
    const store = new Store(':memory:'); authorize(store, guild);
    const cfg: any = structuredClone(MIDTOWN_PRESET); cfg.guildId = guild; cfg.enabled = true; cfg.validatedAt = Date.now();
    saveWorkspaceConfig(store, cfg, '900000000000000001');
    const sheets = workbook();
    await store.withAuthorized(guild, async () => {
        const submission = await createAndWriteSubmission(store, guild, '900000000000000001', 'member', { title: 'Literal title', author: 'Authority', sourceUrl: 'https://example.com/source', documentDate: '2026-10-19', connection: 'Connected to this department', sharingPermission: 'Unknown; staff only until verified', restrictions: '', notes: '=not a formula' }, 'panel-message', sheets);
        assert.equal(submission.status, 'Received');
        const first = await applyReviewAction(store, guild, submission.submission_id, '900000000000000002', 'accept', 'Approved after review', 'Staff only', sheets);
        assert.equal(first.submission.status, 'Accepted');
        assert.match(String(first.record?.record_id), /^REC-/);
        assert.equal(first.submission.record_id, first.record?.record_id);
        const second = await applyReviewAction(store, guild, submission.submission_id, '900000000000000002', 'accept', 'Retry after duplicate click', 'Staff only', sheets);
        assert.equal(second.record?.record_id, first.record?.record_id);
        assert.equal(store.all('SELECT * FROM workspace_records WHERE guild_id=?', guild).length, 1);
        assert.equal(sheets.data.get('Archive Register')![7]![0], first.record?.record_id);
    });
    store.close();
});
