import { AppError } from '../errors.js';
import { activeWorkspaceConfig } from './config.js';
import { sheetsFromEnv, upsertMappedRow, validateWorkbook } from './sheets.js';
import { WorkspaceStore } from './store.js';
function roleFor(cfg, member) {
    if (cfg.roles.founderUserId && member.id === cfg.roles.founderUserId)
        return cfg.roles.founderRoleLabel || 'Executive Owner';
    const candidates = [...cfg.roles.rankPriority, ...cfg.roles.managerRoleIds, ...cfg.roles.reviewerRoleIds, ...cfg.roles.staffRoleIds];
    const found = candidates.find(id => member.roles.cache.has(id));
    return found ? `<@&${found}>` : member.roles.cache.filter(r => r.id !== member.guild.id).map(r => r.name).slice(0, 3).join(', ');
}
export function candidate(member, cfg) {
    return { userId: String(member.id), username: String(member.user.username), role: roleFor(cfg, member), roleIds: [...member.roles.cache.keys()], joinedDate: member.joinedAt?.toISOString().slice(0, 10) ?? null };
}
export function isRecognized(candidate, cfg) {
    return !!(cfg.roles.founderUserId && candidate.userId === cfg.roles.founderUserId) || candidate.roleIds.some(id => [...cfg.roles.staffRoleIds, ...cfg.roles.reviewerRoleIds, ...cfg.roles.managerRoleIds].includes(id));
}
export function previewStaffChanges(store, guildId, members, complete, cfg) {
    const existing = new Map(new WorkspaceStore(store).staff(guildId).map(row => [String(row.user_id), row]));
    const changes = [];
    const seen = new Set();
    for (const member of members.filter(m => isRecognized(m, cfg))) {
        seen.add(member.userId);
        const before = existing.get(member.userId);
        if (!before)
            changes.push({ kind: 'add', userId: member.userId, after: member });
        else if (String(before.username) !== member.username || String(before.role) !== member.role)
            changes.push({ kind: 'update', userId: member.userId, before, after: member });
    }
    if (complete)
        for (const [userId, before] of existing)
            if (!seen.has(userId) && ['Listed', 'Unassigned'].includes(String(before.roster_status)))
                changes.push({ kind: 'remove', userId, before });
    return changes;
}
export async function writeStaffRow(cfg, row, client = sheetsFromEnv()) {
    const check = await validateWorkbook(client, cfg);
    if (!check.ok)
        throw new AppError('INTEGRATION_ERROR', `Workbook headers or worksheets do not match the saved Workspace mapping:\n${check.errors.slice(0, 8).map(e => `• ${e}`).join('\n')}`);
    return upsertMappedRow(client, cfg, cfg.sheets.staffRoster, 'userId', String(row.user_id), { username: row.username, role: row.role, rosterStatus: row.roster_status, joinedDate: row.joined_date ?? '', lastReview: row.last_review ?? '', updated: new Date(Number(row.updated_at)).toISOString(), reference: row.reference ?? '', notes: row.notes ?? '' });
}
export async function syncStaffMembers(store, guildId, actorId, members, complete, client) {
    const cfg = activeWorkspaceConfig(store, guildId);
    if (!cfg?.modules.staff)
        throw new AppError('VALIDATION_ERROR', 'Staff synchronization is disabled or Workspace setup is incomplete.');
    const ws = new WorkspaceStore(store);
    const changes = previewStaffChanges(store, guildId, members, complete, cfg);
    const now = Date.now();
    for (const member of members.filter(m => isRecognized(m, cfg))) {
        const old = store.get('SELECT * FROM workspace_staff WHERE guild_id=? AND user_id=?', guildId, member.userId);
        const oldStatus = String(old?.roster_status ?? 'Listed');
        const preserve = oldStatus === 'Leave' || oldStatus === 'Inactive';
        store.run(`INSERT INTO workspace_staff(guild_id,user_id,username,role,roster_status,joined_date,updated_at,reference,notes,source_hash)
            VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET username=excluded.username,role=excluded.role,joined_date=COALESCE(workspace_staff.joined_date,excluded.joined_date),updated_at=excluded.updated_at,source_hash=excluded.source_hash`, guildId, member.userId, member.username, member.role, preserve ? oldStatus : 'Listed', member.joinedDate, now, `discord:${member.userId}`, old?.notes ?? '', member.roleIds.join(','));
    }
    if (complete)
        for (const change of changes.filter(c => c.kind === 'remove'))
            store.run("UPDATE workspace_staff SET roster_status='Removed',updated_at=? WHERE guild_id=? AND user_id=? AND roster_status IN ('Listed','Unassigned')", now, guildId, change.userId);
    let applied = 0;
    for (const row of ws.staff(guildId)) {
        if (!changes.some(change => change.userId === String(row.user_id)) && String(row.roster_status) !== 'Removed')
            continue;
        const sheetRow = await writeStaffRow(cfg, row, client);
        store.run('UPDATE workspace_staff SET updated_at=? WHERE guild_id=? AND user_id=?', now, guildId, row.user_id);
        void sheetRow;
        applied++;
    }
    ws.audit(guildId, actorId, 'staff/synchronized', '', `${applied} rows; complete=${complete}`);
    return { changes, applied };
}
export async function previewGuildStaff(store, guild) {
    const cfg = activeWorkspaceConfig(store, guild.id);
    if (!cfg?.modules.staff)
        throw new AppError('VALIDATION_ERROR', 'Staff synchronization is disabled or Workspace setup is incomplete.');
    let members;
    try {
        members = await guild.members.fetch();
    }
    catch {
        throw new AppError('DISCORD_API_ERROR', 'The member fetch was incomplete. No roster removals were applied; retry after Discord responds normally.');
    }
    const candidates = [...members.values()].map(member => candidate(member, cfg));
    return { cfg, candidates, changes: previewStaffChanges(store, guild.id, candidates, true, cfg) };
}
export async function syncGuildStaff(store, guild, actorId, client) {
    const preview = await previewGuildStaff(store, guild);
    return syncStaffMembers(store, guild.id, actorId, preview.candidates, true, client);
}
export function staffText(rows) {
    if (!rows.length)
        return 'No staff rows are listed yet. Configure staff roles, then use Refresh Staff.';
    return rows.slice(0, 25).map(row => `**${row.username}** · ${row.role || 'Unassigned'} · **${row.roster_status}**\nID: \`${row.user_id}\``).join('\n\n');
}
