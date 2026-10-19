import { randomBytes } from 'node:crypto';
import type { Store, Row } from '../database/db.js';
import { activeWorkspaceConfig, getWorkspaceConfig } from './config.js';
import type { SubmissionDraft, SubmissionRow, TaskDraft, TaskPriority, TaskStatus, WorkspaceConfig, WorkspaceSession, WorkspaceStatus } from './types.js';

const pad = (n: number) => String(n).padStart(5, '0');
const day = (at = Date.now()) => new Date(at).toISOString().slice(0, 10).replaceAll('-', '');
const parse = <T>(value: unknown, fallback: T): T => { try { return JSON.parse(String(value)); } catch { return fallback; } };

export function workspaceId(store: Store, guildId: string, name: 'submission' | 'record' | 'task', prefix: 'SUB' | 'REC' | 'TASK'): string {
    let value = 0;
    store.transaction(() => {
        store.run('INSERT INTO workspace_counters(guild_id,name,value) VALUES(?,?,1) ON CONFLICT(guild_id,name) DO UPDATE SET value=value+1', guildId, name);
        value = Number(store.get('SELECT value FROM workspace_counters WHERE guild_id=? AND name=?', guildId, name)?.value ?? 0);
    });
    return `${prefix}-${day()}-${pad(value)}`;
}

export function newSessionId(): string {
    return randomBytes(9).toString('base64url');
}

export class WorkspaceStore {
    constructor(readonly store: Store) { }

    config(guildId: string): WorkspaceConfig | null { return getWorkspaceConfig(this.store, guildId); }
    activeConfig(guildId: string): WorkspaceConfig | null { return activeWorkspaceConfig(this.store, guildId); }

    audit(guildId: string, actorId: string | null, action: string, itemId = '', detail = '') {
        this.store.run('INSERT INTO workspace_audit(guild_id,at,actor_id,action,item_id,detail) VALUES(?,?,?,?,?,?)', guildId, Date.now(), actorId, action, itemId, detail);
    }

    session<T>(guildId: string, userId: string, kind: string, data: T, ttlMs = 15 * 60_000): WorkspaceSession<T> {
        const result: WorkspaceSession<T> = { guildId, sessionId: newSessionId(), userId, kind, data, createdAt: Date.now(), expiresAt: Date.now() + ttlMs };
        this.store.run('INSERT INTO workspace_sessions(guild_id,session_id,user_id,kind,data_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)', guildId, result.sessionId, userId, kind, JSON.stringify(data), result.createdAt, result.expiresAt);
        return result;
    }

    getSession<T>(guildId: string, sessionId: string, userId: string, kind?: string): WorkspaceSession<T> | null {
        const row = this.store.get('SELECT * FROM workspace_sessions WHERE guild_id=? AND session_id=? AND user_id=?', guildId, sessionId, userId);
        if (!row || Number(row.expires_at) < Date.now() || kind && String(row.kind) !== kind) {
            if (row) this.store.run('DELETE FROM workspace_sessions WHERE guild_id=? AND session_id=?', guildId, sessionId);
            return null;
        }
        return { guildId, sessionId, userId, kind: String(row.kind), data: parse<T>(row.data_json, {} as T), createdAt: Number(row.created_at), expiresAt: Number(row.expires_at) };
    }

    deleteSession(guildId: string, sessionId: string) { this.store.run('DELETE FROM workspace_sessions WHERE guild_id=? AND session_id=?', guildId, sessionId); }
    updateSession<T>(session: WorkspaceSession<T>, data: T) { this.store.run('UPDATE workspace_sessions SET data_json=?,expires_at=? WHERE guild_id=? AND session_id=? AND user_id=?', JSON.stringify(data), Date.now() + 15 * 60_000, session.guildId, session.sessionId, session.userId); }
    cleanup(now = Date.now()) { this.store.run('DELETE FROM workspace_sessions WHERE guild_id=? AND expires_at<?', this.store.currentGuildId() ?? '', now); }

    createSubmission(guildId: string, contributorId: string, contributorUsername: string, draft: SubmissionDraft, reference: string | null): SubmissionRow {
        const now = Date.now();
        const id = workspaceId(this.store, guildId, 'submission', 'SUB');
        const row: SubmissionRow = { submissionId: id, contributorId, contributorUsername, receivedAt: now, title: draft.title, author: draft.author || null, sourceUrl: draft.sourceUrl || null, documentDate: draft.documentDate || null, connection: draft.connection || null, sharingPermission: draft.sharingPermission || null, restrictions: '', notes: draft.notes || null, reference, status: 'Received' };
        this.store.transaction(() => {
            this.store.run(`INSERT INTO workspace_submissions(guild_id,submission_id,contributor_id,contributor_username,received_at,title,author,source_url,document_date,midtown_connection,sharing_permission,restrictions,notes,reference,status,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, guildId, id, contributorId, contributorUsername, now, row.title, row.author ?? null, row.sourceUrl ?? null, row.documentDate ?? null, row.connection ?? null, row.sharingPermission ?? null, row.restrictions ?? null, row.notes ?? null, row.reference ?? null, row.status, now);
            this.store.run('INSERT INTO workspace_reviews(guild_id,submission_id,status,updated_at) VALUES(?,?,?,?)', guildId, id, 'Received', now);
        });
        this.audit(guildId, contributorId, 'submission/received', id, row.title);
        return row;
    }

    submission(guildId: string, submissionId: string): Row | undefined { return this.store.get('SELECT * FROM workspace_submissions WHERE guild_id=? AND submission_id=?', guildId, submissionId); }
    review(guildId: string, submissionId: string): Row | undefined { return this.store.get('SELECT * FROM workspace_reviews WHERE guild_id=? AND submission_id=?', guildId, submissionId); }
    submissionsByMember(guildId: string, userId: string, limit = 20): Row[] { return this.store.all('SELECT * FROM workspace_submissions WHERE guild_id=? AND contributor_id=? ORDER BY received_at DESC LIMIT ?', guildId, userId, limit); }
    reviewQueue(guildId: string, status?: WorkspaceStatus, reviewerId?: string, limit = 25): Row[] {
        if (status && reviewerId) return this.store.all('SELECT s.*,r.assigned_reviewer,r.review_notes FROM workspace_submissions s JOIN workspace_reviews r ON r.guild_id=s.guild_id AND r.submission_id=s.submission_id WHERE s.guild_id=? AND s.status=? AND r.assigned_reviewer=? ORDER BY s.received_at ASC LIMIT ?', guildId, status, reviewerId, limit);
        if (status) return this.store.all('SELECT s.*,r.assigned_reviewer,r.review_notes FROM workspace_submissions s JOIN workspace_reviews r ON r.guild_id=s.guild_id AND r.submission_id=s.submission_id WHERE s.guild_id=? AND s.status=? ORDER BY s.received_at ASC LIMIT ?', guildId, status, limit);
        return this.store.all('SELECT s.*,r.assigned_reviewer,r.review_notes FROM workspace_submissions s JOIN workspace_reviews r ON r.guild_id=s.guild_id AND r.submission_id=s.submission_id WHERE s.guild_id=? AND s.status IN (?,?,?) ORDER BY s.received_at ASC LIMIT ?', guildId, 'Received', 'Under review', 'Needs information', limit);
    }

    updateReview(guildId: string, submissionId: string, status: WorkspaceStatus, actorId: string, notes = '', reviewerId?: string | null, recordId?: string | null) {
        const now = Date.now();
        this.store.transaction(() => {
            this.store.run('UPDATE workspace_submissions SET status=?,reviewer_id=COALESCE(?,reviewer_id),decision_at=?,record_id=COALESCE(?,record_id),updated_at=?,last_error=NULL WHERE guild_id=? AND submission_id=?', status, reviewerId ?? null, ['Accepted', 'Restricted', 'Declined'].includes(status) ? now : null, recordId ?? null, now, guildId, submissionId);
            this.store.run('UPDATE workspace_reviews SET status=?,assigned_reviewer=COALESCE(?,assigned_reviewer),decision_date=?,review_notes=?,updated_at=? WHERE guild_id=? AND submission_id=?', status, reviewerId ?? null, ['Accepted', 'Restricted', 'Declined'].includes(status) ? now : null, notes, now, guildId, submissionId);
        });
        this.audit(guildId, actorId, `review/${status.toLowerCase().replaceAll(' ', '-')}`, submissionId, notes);
    }

    reserveRecord(guildId: string, submissionId: string, actorId: string, access: 'Public' | 'Restricted' | 'Staff only', notes: string): Row {
        const submission = this.submission(guildId, submissionId);
        if (!submission) throw new Error('Submission was not found.');
        const existing = this.store.get('SELECT * FROM workspace_records WHERE guild_id=? AND submission_id=?', guildId, submissionId);
        if (existing) return existing;
        const now = Date.now();
        const recordId = workspaceId(this.store, guildId, 'record', 'REC');
        this.store.transaction(() => {
            this.store.run(`INSERT INTO workspace_records(guild_id,record_id,submission_id,title,document_date,author,source_url,midtown_connection,access_level,record_status,reviewed_by,review_date,notes,operation_status,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`, guildId, recordId, submissionId, submission.title, submission.document_date ?? null, submission.author ?? null, submission.source_url ?? null, submission.midtown_connection ?? null, access, 'Under review', actorId, now, notes, now);
            this.store.run('UPDATE workspace_submissions SET record_id=?,updated_at=? WHERE guild_id=? AND submission_id=?', recordId, now, guildId, submissionId);
        });
        this.audit(guildId, actorId, 'record/reserved', recordId, `Linked submission ${submissionId}`);
        return this.store.get('SELECT * FROM workspace_records WHERE guild_id=? AND record_id=?', guildId, recordId)!;
    }

    record(guildId: string, recordId: string): Row | undefined { return this.store.get('SELECT * FROM workspace_records WHERE guild_id=? AND record_id=?', guildId, recordId); }
    records(guildId: string, query = '', limit = 25): Row[] { const q = `%${query}%`; return this.store.all('SELECT * FROM workspace_records WHERE guild_id=? AND (record_id LIKE ? OR title LIKE ?) ORDER BY updated_at DESC LIMIT ?', guildId, q, q, limit); }
    markRecord(guildId: string, recordId: string, status: 'written' | 'failed', actorId: string, error?: string | null) {
        this.store.run('UPDATE workspace_records SET operation_status=?,last_error=?,updated_at=? WHERE guild_id=? AND record_id=?', status, error ?? null, Date.now(), guildId, recordId);
        this.audit(guildId, actorId, `record/${status}`, recordId, error ?? '');
    }

    createTask(guildId: string, actorId: string, draft: TaskDraft): Row {
        const now = Date.now();
        const id = workspaceId(this.store, guildId, 'task', 'TASK');
        const due = draft.dueDate ? Date.parse(draft.dueDate + 'T23:59:59Z') : null;
        this.store.run(`INSERT INTO workspace_tasks(guild_id,task_id,description,issued_at,issued_by,owner_id,due_at,priority,status,notes,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, guildId, id, draft.description, now, actorId, draft.ownerId || null, Number.isFinite(due) ? due : null, draft.priority, 'Not started', draft.notes || '', now);
        this.audit(guildId, actorId, 'task/created', id, draft.description);
        return this.store.get('SELECT * FROM workspace_tasks WHERE guild_id=? AND task_id=?', guildId, id)!;
    }

    tasks(guildId: string, filter: 'all' | 'mine' | 'open' | 'blocked' | 'overdue', userId?: string, limit = 25): Row[] {
        const now = Date.now();
        if (filter === 'mine') return this.store.all('SELECT * FROM workspace_tasks WHERE guild_id=? AND owner_id=? ORDER BY COALESCE(due_at,9223372036854775807),issued_at LIMIT ?', guildId, userId ?? '', limit);
        if (filter === 'open') return this.store.all("SELECT * FROM workspace_tasks WHERE guild_id=? AND status IN ('Not started','In progress','Blocked') ORDER BY COALESCE(due_at,9223372036854775807),issued_at LIMIT ?", guildId, limit);
        if (filter === 'blocked') return this.store.all("SELECT * FROM workspace_tasks WHERE guild_id=? AND status='Blocked' ORDER BY issued_at LIMIT ?", guildId, limit);
        if (filter === 'overdue') return this.store.all("SELECT * FROM workspace_tasks WHERE guild_id=? AND due_at IS NOT NULL AND due_at<? AND status NOT IN ('Completed','Cancelled') ORDER BY due_at LIMIT ?", guildId, now, limit);
        return this.store.all('SELECT * FROM workspace_tasks WHERE guild_id=? ORDER BY updated_at DESC LIMIT ?', guildId, limit);
    }

    task(guildId: string, taskId: string): Row | undefined { return this.store.get('SELECT * FROM workspace_tasks WHERE guild_id=? AND task_id=?', guildId, taskId); }
    updateTask(guildId: string, taskId: string, actorId: string, change: { ownerId?: string | null; dueAt?: number | null; priority?: TaskPriority; status?: TaskStatus; notes?: string }) {
        const before = this.task(guildId, taskId);
        if (!before) throw new Error('Task was not found.');
        const status = change.status ?? String(before.status) as TaskStatus;
        const completed = status === 'Completed' ? (before.completed_at ?? Date.now()) : null;
        this.store.run(`UPDATE workspace_tasks SET owner_id=?,due_at=?,priority=?,status=?,completed_at=?,notes=?,updated_at=? WHERE guild_id=? AND task_id=?`, change.ownerId ?? before.owner_id ?? null, change.dueAt === undefined ? before.due_at ?? null : change.dueAt, change.priority ?? before.priority, status, completed, change.notes ?? before.notes ?? '', Date.now(), guildId, taskId);
        this.audit(guildId, actorId, 'task/updated', taskId, JSON.stringify(change));
    }

    staff(guildId: string, limit = 100): Row[] { return this.store.all('SELECT * FROM workspace_staff WHERE guild_id=? ORDER BY roster_status,username LIMIT ?', guildId, limit); }

    counts(guildId: string) {
        const count = (sql: string, ...args: (string | number | null)[]) => Number(this.store.get(sql, ...args)?.n ?? 0);
        const cfg = this.config(guildId);
        const excluded = new Set(cfg?.roles.excludeFromCapacityUserIds ?? []);
        const listedRows = this.store.all("SELECT user_id FROM workspace_staff WHERE guild_id=? AND roster_status='Listed'", guildId);
        const listedStaff = listedRows.filter(row => !excluded.has(String(row.user_id))).length;
        const confirmedCapacity = cfg?.roles.confirmedCapacity ?? null;
        const proposedCapacity = cfg?.roles.proposedCapacity ?? null;
        return {
            awaitingReview: count("SELECT COUNT(*) n FROM workspace_submissions WHERE guild_id=? AND status='Received'", guildId),
            needsInformation: count("SELECT COUNT(*) n FROM workspace_submissions WHERE guild_id=? AND status='Needs information'", guildId),
            inProgress: count("SELECT COUNT(*) n FROM workspace_submissions WHERE guild_id=? AND status='Under review'", guildId),
            unresolvedRecords: count("SELECT COUNT(*) n FROM workspace_records WHERE guild_id=? AND record_status='Needs correction'", guildId),
            blockedTasks: count("SELECT COUNT(*) n FROM workspace_tasks WHERE guild_id=? AND status='Blocked'", guildId),
            overdueTasks: count("SELECT COUNT(*) n FROM workspace_tasks WHERE guild_id=? AND due_at<? AND status NOT IN ('Completed','Cancelled')", guildId, Date.now()),
            listedStaff,
            confirmedCapacity: confirmedCapacity === null ? 'not configured' : confirmedCapacity,
            proposedCapacity: proposedCapacity === null ? 'not configured' : proposedCapacity,
            vacancies: confirmedCapacity === null ? 'not configured' : Math.max(0, confirmedCapacity - listedStaff),
            proposedVacancies: proposedCapacity === null ? 'not configured' : Math.max(0, proposedCapacity - listedStaff),
        };
    }

    workload(guildId: string) {
        return this.store.all("SELECT reviewer_id,COUNT(*) n FROM workspace_submissions WHERE guild_id=? AND reviewer_id IS NOT NULL AND status IN ('Received','Under review','Needs information') GROUP BY reviewer_id ORDER BY n DESC", guildId);
    }

    taskWorkload(guildId: string) {
        return this.store.all("SELECT owner_id,COUNT(*) n FROM workspace_tasks WHERE guild_id=? AND owner_id IS NOT NULL AND status NOT IN ('Completed','Cancelled') GROUP BY owner_id ORDER BY n DESC", guildId);
    }

    lastRefresh(guildId: string): number | null { return (this.store.get('SELECT MAX(updated_at) at FROM workspace_config WHERE guild_id=?', guildId)?.at as number | null) ?? null; }
}

export function rowToSubmission(row: Row): SubmissionRow {
    return { submissionId: String(row.submission_id), contributorId: String(row.contributor_id), contributorUsername: String(row.contributor_username), receivedAt: Number(row.received_at), title: String(row.title), author: row.author, sourceUrl: row.source_url, documentDate: row.document_date, connection: row.midtown_connection, sharingPermission: row.sharing_permission, restrictions: row.restrictions, notes: row.notes, reference: row.reference, status: String(row.status) as WorkspaceStatus, reviewerId: row.reviewer_id, decisionAt: row.decision_at, recordId: row.record_id };
}

export function safeTaskPriority(value: unknown): TaskPriority { return value === 'High' || value === 'Urgent' ? value : 'Normal'; }
