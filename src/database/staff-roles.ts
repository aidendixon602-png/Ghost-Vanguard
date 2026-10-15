import type { Store } from './db.js';
import { AppError } from '../errors.js';
import { RANKS, RANK_LABEL, rankOf, type RankName } from '../bot/ranks.js';

/** Preserve both representations when a command replaces legacy role access. */
export function staffRoleState(store: Store, guild: string, role: string) {
    return {
        guild_id: guild, role_id: role,
        staff: store.get('SELECT * FROM staff_roles WHERE guild_id=? AND role_id=?', guild, role) ?? null,
        legacy: store.get('SELECT * FROM permission_roles WHERE guild_id=? AND role_id=?', guild, role) ?? null,
    };
}

export type StaffRoleState = ReturnType<typeof staffRoleState>;

export function validateStaffRoleState(value: any, guild: string, role: string): asserts value is StaffRoleState {
    if (!value || value.guild_id !== guild || value.role_id !== role || !Object.hasOwn(value, 'staff') || !Object.hasOwn(value, 'legacy'))
        throw new AppError('VALIDATION_ERROR', 'This staff-role history is missing its identity. Configure the role again to create restorable history.');
    for (const [row, levels, field] of [[value.staff, ['helper', 'moderator', 'admin', 'headadmin'], 'level'], [value.legacy, ['admin', 'moderator'], 'access']] as const)
        if (row !== null && (!row || row.guild_id !== guild || row.role_id !== role || !levels.includes(row[field])))
            throw new AppError('VALIDATION_ERROR', 'Invalid staff-role history. No access was changed.');
}

export function assertStaffRoleChange(store: Store, guild: string, user: string, actor: any, ...states: StaffRoleState[]) {
    const rank = rankOf(store, guild, user, actor, 'staff/role');
    for (const state of states) {
        const levels = [state.staff?.level, state.legacy?.access === 'admin' ? 'headadmin' : state.legacy?.access].filter(Boolean) as RankName[];
        for (const level of levels)
            if (rank <= RANKS[level]) throw new AppError('PERMISSION_ERROR', `Only someone above ${RANK_LABEL[level]} can change that rank.`);
    }
}

/** Call inside a transaction, after validation and the verified safety backup. */
export function restoreStaffRoleState(store: Store, state: StaffRoleState) {
    const { guild_id: guild, role_id: role, staff, legacy } = state;
    store.run('DELETE FROM staff_roles WHERE guild_id=? AND role_id=?', guild, role);
    store.run('DELETE FROM permission_roles WHERE guild_id=? AND role_id=?', guild, role);
    if (staff) store.run('INSERT INTO staff_roles(guild_id,role_id,level,by_id,at) VALUES(?,?,?,?,?)', guild, role, staff.level, staff.by_id ?? null, staff.at ?? null);
    if (legacy) store.run('INSERT INTO permission_roles(guild_id,role_id,access,by_id) VALUES(?,?,?,?)', guild, role, legacy.access, legacy.by_id);
}
