/** Small, read-only Roblox web API helpers (no API key needed). Every call has a timeout and returns null on failure. */
const get = async <T>(url: string, init?: RequestInit): Promise<T | null> => {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) }).catch(() => null);
    return r?.ok ? await r.json().catch(() => null) as T : null;
};

export interface RobloxUser { id: string; name: string; displayName: string; created: string; isBanned: boolean; description: string }

export async function robloxUserByName(name: string): Promise<{ id: string; name: string } | null> {
    const r = await get<{ data: { id: number; name: string }[] }>('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [name], excludeBannedUsers: false }) });
    const u = r?.data?.[0];
    return u ? { id: String(u.id), name: u.name } : null;
}
export async function robloxUser(id: string): Promise<RobloxUser | null> {
    const u = await get<any>(`https://users.roblox.com/v1/users/${encodeURIComponent(id)}`);
    return u?.id ? { id: String(u.id), name: u.name, displayName: u.displayName, created: u.created, isBanned: !!u.isBanned, description: String(u.description ?? '') } : null;
}
export async function robloxPastNames(id: string): Promise<string[]> {
    const r = await get<{ data: { name: string }[] }>(`https://users.roblox.com/v1/users/${encodeURIComponent(id)}/username-history?limit=10&sortOrder=Desc`);
    return (r?.data ?? []).map(x => x.name);
}
export interface GroupRole { groupId: string; groupName: string; rank: number; role: string }
export async function robloxGroups(id: string): Promise<GroupRole[] | null> {
    const r = await get<{ data: { group: { id: number; name: string }; role: { rank: number; name: string } }[] }>(`https://groups.roblox.com/v2/users/${encodeURIComponent(id)}/groups/roles`);
    return r?.data ? r.data.map(g => ({ groupId: String(g.group.id), groupName: g.group.name, rank: g.role.rank, role: g.role.name })) : null;
}
export async function robloxGroupInfo(groupId: string): Promise<{ id: string; name: string } | null> {
    const g = await get<any>(`https://groups.roblox.com/v1/groups/${encodeURIComponent(groupId)}`);
    return g?.id ? { id: String(g.id), name: g.name } : null;
}
export async function robloxGroupRanks(groupId: string): Promise<{ rank: number; name: string }[]> {
    const r = await get<{ roles: { rank: number; name: string }[] }>(`https://groups.roblox.com/v1/groups/${encodeURIComponent(groupId)}/roles`);
    return r?.roles ?? [];
}
export async function robloxAvatar(id: string): Promise<string | null> {
    const r = await get<{ data: { imageUrl?: string }[] }>(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${encodeURIComponent(id)}&size=150x150&format=Png&isCircular=false`);
    return r?.data?.[0]?.imageUrl ?? null;
}
export const accountAgeDays = (created: string, now = Date.now()) => Math.floor((now - Date.parse(created)) / 86400000);
