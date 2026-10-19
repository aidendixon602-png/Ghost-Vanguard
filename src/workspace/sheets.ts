import { createSign } from 'node:crypto';
import { AppError } from '../errors.js';
import type { Row } from '../database/db.js';
import type { WorkspaceConfig, WorksheetMapping } from './types.js';

export interface SheetsMetadata { spreadsheetId: string; sheets: { title: string; sheetId: number; rowCount: number; columnCount: number }[] }
export interface SheetsClient {
    metadata(spreadsheetId: string): Promise<SheetsMetadata>;
    readRange(spreadsheetId: string, range: string): Promise<string[][]>;
    writeCells(spreadsheetId: string, cells: { range: string; values: string[][] }[]): Promise<void>;
    batchUpdate(spreadsheetId: string, requests: unknown[]): Promise<void>;
}

const b64url = (value: string | Uint8Array) => Buffer.from(value).toString('base64url');
// All writes use Google Sheets RAW input, so user text beginning with = remains literal data.
const safe = (value: unknown) => value == null ? '' : String(value);
const columnNumber = (value: string) => value.split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
const columnName = (n: number) => { let out = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + (n - 1) % 26) + out; return out; };
const range = (sheet: string, a1: string) => `'${sheet.replaceAll("'", "''")}'!${a1}`;

function serviceAccount(): { clientEmail: string; privateKey: string } | null {
    const raw = process.env.WORKSPACE_GOOGLE_SERVICE_ACCOUNT_JSON?.trim() || process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
    if (raw) {
        try {
            const value = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')) as { client_email?: string; private_key?: string };
            if (value.client_email && value.private_key) return { clientEmail: value.client_email, privateKey: value.private_key.replaceAll('\\n', '\n') };
        } catch { /* handled by the actionable error below */ }
    }
    const email = process.env.WORKSPACE_GOOGLE_CLIENT_EMAIL?.trim() || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
    const key = process.env.WORKSPACE_GOOGLE_PRIVATE_KEY?.trim() || process.env.GOOGLE_PRIVATE_KEY?.trim();
    return email && key ? { clientEmail: email, privateKey: key.replaceAll('\\n', '\n') } : null;
}

export function googleCredentialsConfigured(): boolean {
    return !!(process.env.WORKSPACE_GOOGLE_ACCESS_TOKEN?.trim() || process.env.GOOGLE_SHEETS_ACCESS_TOKEN?.trim() || serviceAccount());
}

class GoogleToken {
    private token: string | null = null;
    private expiresAt = 0;
    async get(): Promise<string> {
        const direct = process.env.WORKSPACE_GOOGLE_ACCESS_TOKEN?.trim() || process.env.GOOGLE_SHEETS_ACCESS_TOKEN?.trim();
        if (direct) return direct;
        if (this.token && Date.now() < this.expiresAt - 60_000) return this.token;
        const account = serviceAccount();
        if (!account) throw new AppError('INTEGRATION_ERROR', 'Google Sheets is not configured. Set WORKSPACE_GOOGLE_ACCESS_TOKEN or a Google service-account JSON/key in the environment.');
        const now = Math.floor(Date.now() / 1000);
        const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
        const payload = b64url(JSON.stringify({ iss: account.clientEmail, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
        const signer = createSign('RSA-SHA256');
        signer.update(`${header}.${payload}`);
        const assertion = `${header}.${payload}.${signer.sign(account.privateKey, 'base64url')}`;
        const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
        if (!response.ok) throw new AppError('INTEGRATION_ERROR', 'Google authentication failed. Verify the service-account key and that the spreadsheet is shared with the service account.');
        const body = await response.json() as { access_token?: string; expires_in?: number };
        if (!body.access_token) throw new AppError('INTEGRATION_ERROR', 'Google authentication returned no access token.');
        this.token = body.access_token; this.expiresAt = Date.now() + Number(body.expires_in ?? 3600) * 1000;
        return this.token;
    }
}

export class GoogleSheetsClient implements SheetsClient {
    private readonly auth = new GoogleToken();
    constructor(private readonly fetchImpl: typeof fetch = fetch) { }

    private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
        const headers = new Headers(init.headers);
        headers.set('authorization', `Bearer ${await this.auth.get()}`);
        headers.set('content-type', 'application/json');
        const response = await this.fetchImpl(url, { ...init, headers });
        if (!response.ok) {
            let detail = '';
            try { const body = await response.json() as { error?: { message?: string } }; detail = body.error?.message ? `: ${body.error.message}` : ''; } catch { }
            throw new AppError('INTEGRATION_ERROR', `Google Sheets request failed (${response.status})${detail}`);
        }
        return await response.json() as T;
    }

    async metadata(spreadsheetId: string): Promise<SheetsMetadata> {
        const body = await this.request<{ spreadsheetId?: string; sheets?: { properties?: { title?: string; sheetId?: number; gridProperties?: { rowCount?: number; columnCount?: number } } }[] }>(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?includeGridData=false`);
        return { spreadsheetId: String(body.spreadsheetId ?? spreadsheetId), sheets: (body.sheets ?? []).map(s => ({ title: String(s.properties?.title ?? ''), sheetId: Number(s.properties?.sheetId ?? 0), rowCount: Number(s.properties?.gridProperties?.rowCount ?? 0), columnCount: Number(s.properties?.gridProperties?.columnCount ?? 0) })) };
    }

    async readRange(spreadsheetId: string, a1: string): Promise<string[][]> {
        const body = await this.request<{ values?: unknown[][] }>(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(a1)}?majorDimension=ROWS`);
        return (body.values ?? []).map(row => row.map(safe));
    }

    async writeCells(spreadsheetId: string, cells: { range: string; values: string[][] }[]): Promise<void> {
        await this.request(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`, { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW', data: cells.map(c => ({ range: c.range, majorDimension: 'ROWS', values: c.values.map(row => row.map(safe)) })) }) });
    }

    async batchUpdate(spreadsheetId: string, requests: unknown[]): Promise<void> {
        await this.request(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) });
    }
}

export function columnRange(mapping: WorksheetMapping, column: string, row: number): string {
    return range(mapping.name, `${column}${row}`);
}

export interface WorkbookCheck { ok: boolean; errors: string[]; metadata?: SheetsMetadata; headers: Record<string, string[]> }

/** Check live worksheet names and non-empty mapped headers before any write. */
export async function validateWorkbook(client: SheetsClient, cfg: WorkspaceConfig): Promise<WorkbookCheck> {
    const errors: string[] = [];
    const headers: Record<string, string[]> = {};
    const metadata = await client.metadata(cfg.sheets.spreadsheetId);
    const titles = new Set(metadata.sheets.map(s => s.title));
    const mappings: [string, WorksheetMapping][] = [];
    if (cfg.modules.records) mappings.push(['archiveRegister', cfg.sheets.archiveRegister]);
    if (cfg.modules.submissions || cfg.modules.reviews) mappings.push(['submissionReviews', cfg.sheets.submissionReviews]);
    if (cfg.modules.staff) mappings.push(['staffRoster', cfg.sheets.staffRoster]);
    if (cfg.modules.tasks) mappings.push(['directiveTracker', cfg.sheets.directiveTracker]);
    for (const [key, sheet] of mappings) {
        if (!titles.has(sheet.name)) { errors.push(`${key} worksheet "${sheet.name}" was not found.`); continue; }
        const width = Math.max(1, ...Object.values(sheet.columns).map(columnNumber));
        const values = await client.readRange(cfg.sheets.spreadsheetId, range(sheet.name, `A${sheet.headerRow}:${columnName(width)}${sheet.headerRow}`));
        headers[key] = values[0] ?? [];
        for (const [field, column] of Object.entries(sheet.columns)) {
            const header = headers[key][columnNumber(column) - 1];
            if (!header?.trim()) errors.push(`${key}.${field} points to an empty header at ${column}${sheet.headerRow}.`);
            const expected = sheet.headers?.[field];
            if (expected && header?.trim().toLocaleLowerCase() !== expected.trim().toLocaleLowerCase()) errors.push(`${key}.${field} expected header "${expected}" at ${column}${sheet.headerRow}, found "${header ?? ''}".`);
        }
    }
    return { ok: errors.length === 0, errors, metadata, headers };
}

export async function findMappedRow(client: SheetsClient, cfg: WorkspaceConfig, sheet: WorksheetMapping, idField: string, id: string): Promise<{ row: number | null; emptyRow: number | null }> {
    const column = sheet.columns[idField];
    if (!column) throw new AppError('VALIDATION_ERROR', `${sheet.name} has no mapping for its primary ID field.`);
    let searchLast = sheet.lastDataRow;
    if (cfg.sheets.allowExpansion) {
        const live = (await client.metadata(cfg.sheets.spreadsheetId)).sheets.find(s => s.title === sheet.name);
        searchLast = Math.max(searchLast, Number(live?.rowCount ?? searchLast));
    }
    const values = await client.readRange(cfg.sheets.spreadsheetId, range(sheet.name, `${column}${sheet.firstDataRow}:${column}${searchLast}`));
    let emptyRow: number | null = null;
    for (let index = 0; index < searchLast - sheet.firstDataRow + 1; index++) {
        const value = values[index]?.[0]?.trim() ?? '';
        if (value === id) return { row: sheet.firstDataRow + index, emptyRow };
        if (!value && emptyRow === null) emptyRow = sheet.firstDataRow + index;
    }
    if (emptyRow !== null) return { row: null, emptyRow };
    if (!cfg.sheets.allowExpansion) throw new AppError('INTEGRATION_ERROR', `${sheet.name} has no prepared empty rows between ${sheet.firstDataRow} and ${sheet.lastDataRow}. Extend the prepared table or enable controlled expansion before retrying.`);
    return { row: null, emptyRow: searchLast + 1 };
}

async function prepareExpandedRow(client: SheetsClient, cfg: WorkspaceConfig, sheet: WorksheetMapping, row: number) {
    if (row <= sheet.lastDataRow) return;
    const metadata = await client.metadata(cfg.sheets.spreadsheetId);
    const live = metadata.sheets.find(s => s.title === sheet.name);
    const sheetId = live?.sheetId;
    if (sheetId == null) throw new AppError('INTEGRATION_ERROR', `Worksheet ${sheet.name} disappeared while expanding it.`);
    const sourceRowIndex = Math.max(0, row - 2);
    const source = { sheetId, startRowIndex: sourceRowIndex, endRowIndex: sourceRowIndex + 1, startColumnIndex: 0, endColumnIndex: Math.max(1, live?.columnCount ?? 1) };
    const destination = { sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: 0, endColumnIndex: Math.max(1, live?.columnCount ?? 1) };
    await client.batchUpdate(cfg.sheets.spreadsheetId, [
        { insertDimension: { range: { sheetId, dimension: 'ROWS', startIndex: row - 1, endIndex: row }, inheritFromBefore: true } },
        { copyPaste: { source, destination, pasteType: 'PASTE_FORMULA' } },
        { copyPaste: { source, destination, pasteType: 'PASTE_DATA_VALIDATION' } },
        { copyPaste: { source, destination, pasteType: 'PASTE_FORMAT' } },
    ]);
}

/** Write only mapped input cells; calculated columns are never touched. Re-reading the ID column makes retries idempotent. */
export async function upsertMappedRow(client: SheetsClient, cfg: WorkspaceConfig, sheet: WorksheetMapping, idField: string, id: string, values: Record<string, unknown>): Promise<number> {
    const found = await findMappedRow(client, cfg, sheet, idField, id);
    const row = found.row ?? found.emptyRow;
    if (!row) throw new AppError('INTEGRATION_ERROR', `No writable row is available in ${sheet.name}.`);
    await prepareExpandedRow(client, cfg, sheet, row);
    const cells = Object.entries({ [idField]: id, ...values }).filter(([field]) => !!sheet.columns[field]).map(([field, value]) => ({ range: columnRange(sheet, sheet.columns[field]!, row), values: [[safe(value)]] }));
    if (!cells.length) throw new AppError('VALIDATION_ERROR', `No mapped input cells were provided for ${sheet.name}.`);
    await client.writeCells(cfg.sheets.spreadsheetId, cells);
    return row;
}

export const visibleMention = (id: unknown) => typeof id === 'string' && /^\d{17,20}$/.test(id) ? `<@${id}>` : '';

export function sheetsFromEnv(): SheetsClient {
    return new GoogleSheetsClient();
}

export class MemorySheets implements SheetsClient {
    readonly data = new Map<string, string[][]>();
    readonly writes: { range: string; values: string[][] }[] = [];
    constructor(seed: Record<string, string[][]> = {}) { for (const [key, value] of Object.entries(seed)) this.data.set(key, value.map(row => [...row])); }
    async metadata(spreadsheetId: string): Promise<SheetsMetadata> { return { spreadsheetId, sheets: [...this.data.keys()].map((title, sheetId) => ({ title, sheetId, rowCount: this.data.get(title)!.length, columnCount: Math.max(1, ...this.data.get(title)!.map(r => r.length)) })) }; }
    async readRange(_spreadsheetId: string, a1: string): Promise<string[][]> { const match = /'?([^']+?)'?!([A-Z]+)(\d+):([A-Z]+)(\d+)/.exec(a1); if (!match) return []; const rows = this.data.get(match[1]!) ?? []; const start = Number(match[3]) - 1; const end = Number(match[5]); const from = columnNumber(match[2]!)-1; const to = columnNumber(match[4]!); return rows.slice(start, end).map(r => r.slice(from, to)); }
    async writeCells(_spreadsheetId: string, cells: { range: string; values: string[][] }[]): Promise<void> { this.writes.push(...cells); for (const cell of cells) { const match = /'?([^']+?)'?!([A-Z]+)(\d+)/.exec(cell.range); if (!match) continue; const rows = this.data.get(match[1]!) ?? []; const row = Number(match[3]) - 1; while (rows.length <= row) rows.push([]); const col = columnNumber(match[2]!) - 1; while (rows[row]!.length <= col) rows[row]!.push(''); rows[row]![col] = cell.values[0]?.[0] ?? ''; this.data.set(match[1]!, rows); } }
    async batchUpdate(): Promise<void> { }
}

export function rowValues(values: Record<string, unknown>, mapping: WorksheetMapping): Row { return Object.fromEntries(Object.entries(values).filter(([key]) => mapping.columns[key]).map(([key, value]) => [mapping.columns[key]!, safe(value)])); }
