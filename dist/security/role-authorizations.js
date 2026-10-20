import { AuditLogEvent } from 'discord.js';
export const APPROVAL_MS = 30000;
const pending = new Map();
const key = (guild, member, role, op) => `${guild}:${member}:${role}:${op}`;
function prune(now) {
    for (const [k, until] of pending)
        if (until <= now)
            pending.delete(k);
}
/** Record an approval; returns a function that withdraws it (call it if the change fails). */
export function approveRoleChange(guild, member, role, op, now = Date.now()) {
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
export function consumeApprovedRoleChange(entry, guild, now = Date.now()) {
    prune(now);
    if (entry.action !== AuditLogEvent.MemberRoleUpdate || !entry.targetId || entry.executorId !== guild.client.user?.id)
        return false;
    const changes = (entry.changes ?? []);
    const wanted = [];
    for (const c of changes) {
        if (c.key !== '$add' && c.key !== '$remove')
            return false;
        for (const r of c.new ?? [])
            wanted.push(key(guild.id, entry.targetId, r.id, c.key === '$add' ? 'add' : 'remove'));
    }
    if (!wanted.length || !wanted.every(k => pending.has(k)))
        return false;
    for (const k of wanted)
        pending.delete(k);
    return true;
}
