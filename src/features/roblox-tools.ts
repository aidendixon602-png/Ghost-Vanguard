import { isBotPermissionRole } from '../security/role-policy.js';
import { isBlacklisted } from '../security/role-blacklist.js';
import { Colors, type GuildMember } from 'discord.js';
import type { Store } from '../database/db.js';
import { dangerous } from '../core.js';
import { embed } from '../ui/ui.js';
import { accountAgeDays, robloxAvatar, robloxGroups, robloxPastNames, robloxUser } from '../integrations/roblox-api.js';
import { getFeature } from './settings.js';

/**
 * Roblox tools:
 *  - Blacklist: Roblox accounts blocked in this server (banned members' accounts are added automatically).
 *  - Network: servers that opt in share their blacklist, so a ban in one blocks that Roblox account in all.
 *  - Group rank sync: Discord roles follow a member's rank in your Roblox group.
 */
export interface NetworkConfig { share: boolean; use: boolean }
export const NETWORK_DEFAULTS: NetworkConfig = { share: false, use: false };
export const networkConfig = (store: Store, guild: string) => getFeature(store, guild, 'network', NETWORK_DEFAULTS);

/**
 * Partners must add EACH OTHER (/roblox partner add in both servers). Only then do bans flow
 * between them, so an unknown server can never block accounts in yours.
 */
export function partnerIds(store: Store, guild: string): string[] {
    return store.all('SELECT a.partner_id FROM network_partners a JOIN network_partners b ON b.guild_id=a.partner_id AND b.partner_id=a.guild_id WHERE a.guild_id=?', guild).map(r => String(r.partner_id));
}

/** Why this Roblox account is blocked here, or null. Checks this server's list, then mutual partners that share. */
export function blacklistEntry(store: Store, guild: string, robloxId: string): { reason: string; network: boolean } | null {
    const local = store.get('SELECT reason FROM blocked_accounts WHERE guild_id=? AND roblox_id=?', guild, robloxId);
    if (local) return { reason: String(local.reason ?? 'Blacklisted'), network: false };
    if (!networkConfig(store, guild).use) return null;
    const partners = partnerIds(store, guild);
    if (!partners.length) return null;
    const shared = store.get(`SELECT reason FROM roblox_network WHERE roblox_id=? AND guild_id IN (${partners.map(() => '?').join(',')}) ORDER BY at DESC LIMIT 1`, robloxId, ...partners);
    return shared ? { reason: `${shared.reason ?? 'Blacklisted'} (in a partner server)`, network: true } : null;
}

/**
 * Blacklist a Roblox account here. `publicReason` is what partner servers see; it must not contain
 * moderator names or Discord IDs. `sourceUser` is the banned Discord member, so an unban can withdraw it.
 */
export function addToBlacklist(store: Store, guild: string, robloxId: string, reason: string, publicReason = 'Blacklisted', sourceUser: string | null = null) {
    store.run('INSERT OR REPLACE INTO blocked_accounts VALUES(?,?,?)', guild, robloxId, reason);
    if (networkConfig(store, guild).share)
        store.run('INSERT OR REPLACE INTO roblox_network(roblox_id,guild_id,reason,at,source_user) VALUES(?,?,?,?,?)', robloxId, guild, publicReason.slice(0, 120), Date.now(), sourceUser);
}
export function removeFromBlacklist(store: Store, guild: string, robloxId: string) {
    const had = !!store.get('SELECT 1 FROM blocked_accounts WHERE guild_id=? AND roblox_id=?', guild, robloxId);
    store.run('DELETE FROM blocked_accounts WHERE guild_id=? AND roblox_id=?', guild, robloxId);
    store.run('DELETE FROM roblox_network WHERE roblox_id=? AND guild_id=?', robloxId, guild);
    return had;
}
/** An unbanned member's account stops being shared with partners (this server keeps its own record). */
export function withdrawSharedBan(store: Store, guild: string, discordUser: string) {
    store.run('DELETE FROM roblox_network WHERE guild_id=? AND source_user=?', guild, discordUser);
}

// ---- Group rank sync ----
export interface RankBind { rank: number; roleId: string; mode: 'exact' | 'min' }
export interface GroupConfig { groupId: string | null; groupName: string | null; binds: RankBind[] }
export const GROUP_DEFAULTS: GroupConfig = { groupId: null, groupName: null, binds: [] };
export const groupConfig = (store: Store, guild: string) => getFeature(store, guild, 'robloxgroup', GROUP_DEFAULTS);

/** Which bound roles a group rank should have. Pure, for tests. */
export function rolesForRank(binds: RankBind[], rank: number): Set<string> {
    return new Set(binds.filter(b => b.mode === 'exact' ? rank === b.rank : rank >= b.rank && rank > 0).map(b => b.roleId));
}

/** Give and remove bound roles to match the member's group rank. Returns a short summary ('' when no group is set). */
export async function syncGroupRoles(store: Store, member: GuildMember, robloxId: string): Promise<string> {
    const c = groupConfig(store, member.guild.id);
    if (!c.groupId || !c.binds.length) return '';
    const groups = await robloxGroups(robloxId);
    if (!groups) return ' Group ranks could not be checked right now.';
    const rank = groups.find(g => g.groupId === c.groupId)?.rank ?? 0;
    const want = rolesForRank(c.binds, rank);
    // Never hand out powerful roles from a Roblox rank, and only touch roles Vanguard can manage.
    const usable = (id: string) => { const r = member.guild.roles.cache.get(id); return !!r && r.editable && !r.managed && !isBlacklisted(store, member.guild.id, id) && !isBotPermissionRole(store, member.guild.id, id) && !dangerous(r.permissions.bitfield); };
    const add = [...want].filter(id => !member.roles.cache.has(id) && usable(id));
    const remove = c.binds.map(b => b.roleId).filter(id => !want.has(id) && member.roles.cache.has(id) && usable(id));
    if (add.length) await member.roles.add(add, `Roblox group rank ${rank}`).catch(() => { });
    if (remove.length) await member.roles.remove(remove, `Roblox group rank ${rank}`).catch(() => { });
    return add.length || remove.length ? ` Group rank ${rank}: ${add.length} role(s) added, ${remove.length} removed.` : '';
}

/** A profile card for /roblox lookup. */
export async function lookupCard(store: Store, guild: string, robloxId: string, bloxlinkDiscordIds: string[] | null = null) {
    const [user, past, groups, avatar] = await Promise.all([robloxUser(robloxId), robloxPastNames(robloxId), robloxGroups(robloxId), robloxAvatar(robloxId)]);
    if (!user) return null;
    const age = accountAgeDays(user.created);
    const linked = [...new Set([
        ...store.all('SELECT user_id FROM links WHERE guild_id=? AND roblox_id=?', guild, robloxId).map(r => String(r.user_id)),
        ...(bloxlinkDiscordIds ?? []),
    ])].map(id => `<@${id}>`);
    const block = blacklistEntry(store, guild, robloxId);
    const c = groupConfig(store, guild), inGroup = c.groupId ? groups?.find(g => g.groupId === c.groupId) : null;
    const lines = [
        `**Username:** [${user.name}](https://www.roblox.com/users/${user.id}/profile)${user.displayName !== user.name ? ` (${user.displayName})` : ''} · \`${user.id}\``,
        `**Account age:** ${age} days (created <t:${Math.floor(Date.parse(user.created) / 1000)}:D>)${age < 30 ? ' ⚠ new account' : ''}`,
        user.isBanned ? '**Roblox status:** ⛔ banned by Roblox' : '',
        past.length ? `**Past names:** ${past.slice(0, 8).join(', ')}` : '',
        c.groupId ? `**Your group (${c.groupName ?? c.groupId}):** ${inGroup ? `${inGroup.role} (rank ${inGroup.rank})` : 'not a member'}` : '',
        groups ? `**Groups:** ${groups.length}${groups.length ? ` · ${groups.slice(0, 5).map(g => g.groupName).join(', ')}${groups.length > 5 ? '…' : ''}` : ''}` : '',
        `**Linked Discord here:** ${linked.join(', ') || 'none'}`,
        `**Blacklist:** ${block ? `⛔ ${block.reason}` : '✅ not blacklisted'}`,
    ].filter(Boolean);
    const card = embed(`Roblox · ${user.name}`, lines.join('\n'), block || user.isBanned ? Colors.Red : age < 30 ? Colors.Orange : Colors.Blurple);
    if (avatar) card.setThumbnail(avatar);
    return card;
}
