import { AuditLogEvent, Colors, type GuildMember, type PartialGuildMember } from 'discord.js';
import type { Store } from '../database/db.js';
import type { LogQueue } from '../logging.js';
import { embed } from '../ui/ui.js';
import { RANKS, RANK_LABEL, type RankName } from '../bot/ranks.js';

/**
 * Staff rank changes: when someone gains or loses a role that carries a Vanguard staff rank,
 * the change is posted to the security log as a promotion or demotion.
 * (Duty shifts and /duty were removed in 2.22.1; old duty_sessions rows are kept.)
 */
// ---- Rank changes ----
function rankOfRoles(store: Store, guild: string, roles: string[]): RankName | null {
    if (!roles.length) return null;
    const marks = roles.map(() => '?').join(',');
    let best: RankName | null = null;
    for (const r of store.all(`SELECT level FROM staff_roles WHERE guild_id=? AND role_id IN (${marks})`, guild, ...roles) as { level: RankName }[])
        if (!best || RANKS[r.level] > RANKS[best]) best = r.level;
    return best;
}

export async function logRankChange(store: Store, logs: LogQueue, before: GuildMember | PartialGuildMember, after: GuildMember) {
    if (before.partial || after.user.bot) return;
    const was = [...before.roles.cache.keys()], now = [...after.roles.cache.keys()];
    const added = now.filter(r => !was.includes(r)), removed = was.filter(r => !now.includes(r));
    if (!added.length && !removed.length) return;
    const ranked = store.all('SELECT role_id,level FROM staff_roles WHERE guild_id=?', after.guild.id) as { role_id: string; level: RankName }[];
    const changed = ranked.filter(r => added.includes(r.role_id) || removed.includes(r.role_id));
    if (!changed.length) return;
    const oldRank = rankOfRoles(store, after.guild.id, was), newRank = rankOfRoles(store, after.guild.id, now);
    const up = (newRank ? RANKS[newRank] : 0) > (oldRank ? RANKS[oldRank] : 0), down = (newRank ? RANKS[newRank] : 0) < (oldRank ? RANKS[oldRank] : 0);
    const type = up ? 'Promotion' : down ? (newRank ? 'Demotion' : 'Removed from staff') : 'Staff role change';
    // Who did it: the newest matching role update in the audit log, if Vanguard can read it.
    const entry = await after.guild.fetchAuditLogs({ type: AuditLogEvent.MemberRoleUpdate, limit: 5 }).then(l => l.entries.find(e => e.targetId === after.id && Date.now() - e.createdTimestamp < 30000), () => undefined);
    const by = entry?.executorId ?? null;
    const label = (r: RankName | null) => r ? RANK_LABEL[r] : 'no rank';
    const roles = changed.map(r => `${added.includes(r.role_id) ? '➕' : '➖'} <@&${r.role_id}> (${RANK_LABEL[r.level]})`).join('\n');
    logs.push(after.guild.id, embed(`${up ? '⬆️' : down ? '⬇️' : '🔁'} ${type}`, `**Member:** <@${after.id}> (${after.user.tag})\n**Rank:** ${label(oldRank)} → **${label(newRank)}**\n${roles}${by ? `\n**By:** <@${by}>` : ''}`, up ? Colors.Green : down ? Colors.Red : Colors.Blurple));
}
