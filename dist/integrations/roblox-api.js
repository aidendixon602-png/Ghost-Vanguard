/** Small, read-only Roblox web API helpers (no API key needed). Every call has a timeout and returns null on failure. */
const get = async (url, init) => {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) }).catch(() => null);
    return r?.ok ? await r.json().catch(() => null) : null;
};
export async function robloxUserByName(name) {
    const r = await get('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [name], excludeBannedUsers: false }) });
    const u = r?.data?.[0];
    return u ? { id: String(u.id), name: u.name } : null;
}
export async function robloxUser(id) {
    const u = await get(`https://users.roblox.com/v1/users/${encodeURIComponent(id)}`);
    return u?.id ? { id: String(u.id), name: u.name, displayName: u.displayName, created: u.created, isBanned: !!u.isBanned, description: String(u.description ?? '') } : null;
}
export async function robloxPastNames(id) {
    const r = await get(`https://users.roblox.com/v1/users/${encodeURIComponent(id)}/username-history?limit=10&sortOrder=Desc`);
    return (r?.data ?? []).map(x => x.name);
}
export async function robloxGroups(id) {
    const r = await get(`https://groups.roblox.com/v2/users/${encodeURIComponent(id)}/groups/roles`);
    return r?.data ? r.data.map(g => ({ groupId: String(g.group.id), groupName: g.group.name, rank: g.role.rank, role: g.role.name })) : null;
}
export async function robloxGroupInfo(groupId) {
    const g = await get(`https://groups.roblox.com/v1/groups/${encodeURIComponent(groupId)}`);
    return g?.id ? { id: String(g.id), name: g.name } : null;
}
export async function robloxGroupRanks(groupId) {
    const r = await get(`https://groups.roblox.com/v1/groups/${encodeURIComponent(groupId)}/roles`);
    return r?.roles ?? [];
}
export async function robloxAvatar(id) {
    const r = await get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${encodeURIComponent(id)}&size=150x150&format=Png&isCircular=false`);
    return r?.data?.[0]?.imageUrl ?? null;
}
export const accountAgeDays = (created, now = Date.now()) => Math.floor((now - Date.parse(created)) / 86400000);
