import { AuditLogEvent, type Guild, type GuildAuditLogsEntry } from 'discord.js';

/**
 * Short-lived approvals for role changes made through /role. Before Vanguard adds or removes a
 * role it records exactly which server, member, role and operation it is about to do. When the
 * matching audit-log entry arrives (made by Vanguard itself), anti-nuke consumes the approval and
 * does not treat that change as an unauthorised grant.
 *
 * There is no broad bypass: the approval covers one change, expires after 30 seconds, is cleared
 * if the change fails, and only matches entries Vanguard itself made. Any other role change,
 * even to the same member or role, is checked normally.
 */
export type RoleOp = 'add' | 'remove';
export const APPROVAL_MS = 30000;
const pending = new Map<string, number>();
const key = (guild: string, member: string, role: string, op: RoleOp) => `${guild}:${member}:${role}:${op}`;

function prune(now: number) {
    for (const [k, until] of pending) if (until <= now) pending.delete(k);
}

/** Record an approval; returns a function that withdraws it (call it if the change fails). */
export function approveRoleChange(guild: string, member: string, role: string, op: RoleOp, now = Date.now()): () => void {
    prune(now);
    const k = key(guild, member, role, op);
    pending.set(k, now + APPROVAL_MS);
    return () => { pending.delete(k); };
}

export const pendingApprovals = () => pending.size;

/**
 * True when this audit entry is exactly one or more approved /role changes made by Vanguard.
 * The approvals are consumed. Anything else (another executor, an extra role, an expired or
 * missing approval) returns false and nothing is consumed.
 */
export function consumeApprovedRoleChange(entry: GuildAuditLogsEntry, guild: Guild, now = Date.now()): boolean {
    prune(now);
    if (entry.action !== AuditLogEvent.MemberRoleUpdate || !entry.targetId || entry.executorId !== guild.client.user?.id) return false;
    const changes = (entry.changes ?? []) as { key: string; new?: { id: string }[] }[];
    const wanted: string[] = [];
    for (const c of changes) {
        if (c.key !== '$add' && c.key !== '$remove') return false;
        for (const r of c.new ?? []) wanted.push(key(guild.id, entry.targetId, r.id, c.key === '$add' ? 'add' : 'remove'));
    }
    if (!wanted.length || !wanted.every(k => pending.has(k))) return false;
    for (const k of wanted) pending.delete(k);
    return true;
}
