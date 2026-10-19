import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/database/db.js';
import { authorize } from './helpers.js';
import { configWithPreset, genericConfig, validateWorkspaceConfig } from '../src/workspace/config.js';
import { MemorySheets, findMappedRow, upsertMappedRow, validateWorkbook } from '../src/workspace/sheets.js';
import { WorkspaceStore, workspaceId } from '../src/workspace/store.js';
import { MIDTOWN_GUILD_ID, MIDTOWN_PRESET } from '../src/workspace/types.js';

test('Workspace config is generic and the Midtown profile is opt-in only', () => {
    const generic = genericConfig('222222222222222222');
    assert.equal(generic.enabled, false);
    assert.equal(generic.branding.departmentName, 'Workspace');
    assert.notEqual(generic.sheets.spreadsheetId, MIDTOWN_PRESET.sheets.spreadsheetId);
    assert.equal(configWithPreset(MIDTOWN_GUILD_ID, true).sheets.spreadsheetId, '1G9PXfM8zpGgzUb-YjsxCnGR2yKwI9cfaXe0q7WpD6lE');
    assert.match(validateWorkspaceConfig(generic).join('\n'), /spreadsheet ID/);
    assert.match(validateWorkspaceConfig({ ...generic, sheets: { ...generic.sheets, spreadsheetId: 'not-a-sheet' } }).join('\n'), /spreadsheet ID/);
});

test('Workspace IDs are string IDs and counters do not collide', () => {
    const store = new Store(':memory:');
    const guild = '111111111111111111'; authorize(store, guild);
    const ids = new Set(Array.from({ length: 20 }, () => workspaceId(store, guild, 'submission', 'SUB')));
    assert.equal(ids.size, 20);
    assert.ok([...ids].every(id => /^SUB-\d{8}-\d{5}$/.test(id)));
    assert.ok(ids.has(`SUB-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-00001`));
    store.close();
});

test('Workspace data cannot be read across guild scopes', () => {
    const store = new Store(':memory:');
    const one = '111111111111111111'; const two = '222222222222222222'; authorize(store, one); authorize(store, two);
    const first = new WorkspaceStore(store);
    store.withAuthorized(one, async () => { first.createSubmission(one, '900000000000000001', 'one', { title: 'One', author: '', sourceUrl: '', documentDate: '', connection: 'one', sharingPermission: '', restrictions: '', notes: '' }, null); });
    assert.throws(() => store.readGuild(one, () => store.all('SELECT * FROM workspace_submissions WHERE guild_id=?', two)), /Cross-guild|blocked/);
    assert.equal(store.readGuild(two, () => store.all('SELECT * FROM workspace_submissions WHERE guild_id=?', two)).length, 0);
    store.close();
});

test('Sheets validate live headers, use stable IDs, and write literal values', async () => {
    const cfg = structuredClone(MIDTOWN_PRESET);
    cfg.enabled = true; cfg.validatedAt = Date.now();
    const headers = {
        'Archive Register': [...Array(6).fill([]), ['Record ID', 'Title', 'Document Date', 'Author / Authority', 'Source URL', 'Midtown Connection', 'Access Level', 'Record Status', 'Archive URL', 'Reviewed By', 'Review Date', 'Notes', 'Next Action']],
        'Submission Reviews': [...Array(6).fill([]), ['Submission ID', 'Received Date', 'Contributor', 'Document Title', 'Source URL', 'Assigned Reviewer', 'Review Status', 'Decision Date', 'Record ID', 'Review Notes', 'Next Action']],
        'Staff Roster': [...Array(6).fill([]), ['Discord Username', 'Discord User ID', 'Role', 'Roster Status', 'Joined Date', 'Last Review', 'Updated', 'Reference', 'Discord Mention', 'Staff Notes']],
        'Directive Tracker': [...Array(6).fill([]), ['Directive ID', 'Directive / Task', 'Issued Date', 'Issued By', 'Assigned To', 'Due Date', 'Status', 'Priority', 'Completed Date', 'Days Overdue', 'Notes', 'Next Action']],
    };
    const sheets = new MemorySheets(headers);
    assert.equal((await validateWorkbook(sheets, cfg)).ok, true);
    const row = await upsertMappedRow(sheets, cfg, cfg.sheets.submissionReviews, 'submissionId', 'SUB-20261019-00001', { documentTitle: '=not a formula', reviewStatus: 'Received' });
    assert.equal(row, 8);
    assert.equal((await findMappedRow(sheets, cfg, cfg.sheets.submissionReviews, 'submissionId', 'SUB-20261019-00001')).row, 8);
    assert.equal(sheets.data.get('Submission Reviews')![7]![3], '=not a formula');
});
