const bitfieldOf = (role) => {
    try {
        return String(typeof role.permissions === 'bigint' ? role.permissions : role.permissions.bitfield);
    }
    catch {
        return '0';
    }
};
export const isBlacklisted = (store, guildId, roleId) => !!store.get('SELECT 1 FROM role_blacklist WHERE guild_id=? AND role_id=?', guildId, roleId);
export const blacklistRow = (store, guildId, roleId) => store.get('SELECT * FROM role_blacklist WHERE guild_id=? AND role_id=?', guildId, roleId);
export const blacklistAll = (store, guildId) => store.all('SELECT * FROM role_blacklist WHERE guild_id=? ORDER BY name COLLATE NOCASE', guildId);
export const assignersOf = (store, guildId, roleId) => store.all('SELECT grantor_type, grantor_id FROM role_blacklist_assigners WHERE guild_id=? AND role_id=?', guildId, roleId);
/** Exactly the people and roles listed for this blacklisted role. Nothing else counts. */
export function canAssignBlacklisted(store, guildId, roleId, userId, roleIds = []) {
    return assignersOf(store, guildId, roleId).some(a => a.grantor_type === 'user' ? a.grantor_id === userId : roleIds.includes(a.grantor_id));
}
export function addBlacklisted(store, guildId, role, byId, now = Date.now()) {
    store.run('INSERT INTO guild_data(guild_id) VALUES(?) ON CONFLICT(guild_id) DO NOTHING', guildId);
    store.run(`INSERT INTO role_blacklist(guild_id,role_id,name,permissions,position,hoist,mentionable,color,by_id,at) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(guild_id,role_id) DO UPDATE SET name=excluded.name,permissions=excluded.permissions,position=excluded.position,
        hoist=excluded.hoist,mentionable=excluded.mentionable,color=excluded.color,by_id=excluded.by_id,at=excluded.at`, guildId, role.id, role.name ?? null, bitfieldOf(role), role.position ?? 0, role.hoist ? 1 : 0, role.mentionable ? 1 : 0, role.color ?? 0, byId, now);
}
export function removeBlacklisted(store, guildId, roleId) {
    store.run('DELETE FROM role_blacklist_assigners WHERE guild_id=? AND role_id=?', guildId, roleId);
    store.run('DELETE FROM role_blacklist_holders WHERE guild_id=? AND role_id=?', guildId, roleId);
    store.run('DELETE FROM role_blacklist WHERE guild_id=? AND role_id=?', guildId, roleId);
}
export function addAssigner(store, guildId, roleId, type, id, byId, now = Date.now()) {
    store.run('INSERT OR IGNORE INTO role_blacklist_assigners(guild_id,role_id,grantor_type,grantor_id,by_id,at) VALUES(?,?,?,?,?,?)', guildId, roleId, type, id, byId, now);
}
export const removeAssigner = (store, guildId, roleId, type, id) => store.run('DELETE FROM role_blacklist_assigners WHERE guild_id=? AND role_id=? AND grantor_type=? AND grantor_id=?', guildId, roleId, type, id);
export const blacklistHolders = (store, guildId, roleId) => store.all('SELECT user_id FROM role_blacklist_holders WHERE guild_id=? AND role_id=?', guildId, roleId).map(r => r.user_id);
export const addHolder = (store, guildId, roleId, userId) => store.run('INSERT OR IGNORE INTO role_blacklist_holders(guild_id,role_id,user_id) VALUES(?,?,?)', guildId, roleId, userId);
export const removeHolder = (store, guildId, roleId, userId) => store.run('DELETE FROM role_blacklist_holders WHERE guild_id=? AND role_id=? AND user_id=?', guildId, roleId, userId);
export const clearHolders = (store, guildId, roleId) => store.run('DELETE FROM role_blacklist_holders WHERE guild_id=? AND role_id=?', guildId, roleId);
/** Move an entry to a recreated role: the old ID never comes back, so the blacklist follows the new one. */
export function moveBlacklisted(store, guildId, fromRoleId, toRoleId, role) {
    const row = blacklistRow(store, guildId, fromRoleId);
    if (!row)
        return;
    addBlacklisted(store, guildId, { id: toRoleId, name: role?.name ?? row.name ?? toRoleId, permissions: role?.permissions ?? BigInt(row.permissions ?? '0'), position: role?.position ?? row.position ?? 0, hoist: role?.hoist ?? !!row.hoist, mentionable: role?.mentionable ?? !!row.mentionable, color: role?.color ?? row.color }, row.by_id);
    for (const a of assignersOf(store, guildId, fromRoleId))
        addAssigner(store, guildId, toRoleId, a.grantor_type, a.grantor_id, row.by_id);
    for (const h of blacklistHolders(store, guildId, fromRoleId))
        addHolder(store, guildId, toRoleId, h);
    store.run('DELETE FROM role_blacklist_assigners WHERE guild_id=? AND role_id=?', guildId, fromRoleId);
    store.run('DELETE FROM role_blacklist_holders WHERE guild_id=? AND role_id=?', guildId, fromRoleId);
    store.run('DELETE FROM role_blacklist WHERE guild_id=? AND role_id=?', guildId, fromRoleId);
}
/** Human-readable list of who may give a blacklisted role, for replies and log cards. */
export function describeAssigners(rows) {
    if (!rows.length)
        return 'nobody yet';
    return rows.map(a => a.grantor_type === 'role' ? `<@&${a.grantor_id}>` : `<@${a.grantor_id}>`).join(', ');
}
