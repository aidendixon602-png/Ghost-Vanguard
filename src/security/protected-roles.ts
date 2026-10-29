import { AuditLogEvent, Colors, type Guild, type GuildAuditLogsEntry } from 'discord.js';
import type { Store } from '../database/db.js';
import type { LogQueue } from '../logging.js';
import { developers } from '../bot/developers.js';
import { isTrustedBot } from '../bot/trusted-bots.js';
import { dmSecurityAlert } from '../bot/trusted-dm.js';
import { isProtectedRole, protectedRoleAssigners } from '../bot/env-rules.js';
import { embed } from '../ui/ui.js';
import { responsibleActor } from './security.js';

/** Developers and PROTECTED_ROLE_ASSIGNERS may give protected roles. Nobody else, not even the server owner. */
export const canAssignProtected = (userId: string) => developers.has(userId) || protectedRoleAssigners().has(userId);

export const PROTECTED_REFUSAL = (roleId: string) =>
    `<@&${roleId}> is a protected role. Only the people in \`PROTECTED_ROLE_ASSIGNERS\` (and Developers) can give it; it is set in the bot settings, not in Discord.`;

/**
 * A protected role was given by someone not allowed to: take it straight back off the member and alert.
 * Vanguard's own role changes (restoring after a false alarm, releasing a quarantine) are allowed; changes it
 * makes for a staff member (/role, panel, rejoin restore) count as that staff member's.
 */
export async function enforceProtectedRoles(store: Store, logs: LogQueue, entry: GuildAuditLogsEntry, guild: Guild): Promise<string[]> {
    if (entry.action !== AuditLogEvent.MemberRoleUpdate || !entry.targetId) return [];
    const added = ((entry.changes ?? []) as any[]).filter(c => c.key === '$add').flatMap(c => (c.new ?? []) as { id: string; name?: string }[]);
    const hits = added.filter(r => isProtectedRole(r.id));
    if (!hits.length) return [];
    const actor = responsibleActor(entry, guild);
    if (!actor || actor === guild.client.user?.id || isTrustedBot(actor) || canAssignProtected(actor)) return [];
    const member = await guild.members.fetch({ user: entry.targetId, force: true }).catch(() => null);
    const ids = hits.map(r => r.id).filter(id => member?.roles.cache.has(id));
    let removed = false;
    if (member && ids.length)
        removed = await member.roles.remove(ids, 'Midtown Vanguard: protected role given by someone not allowed to').then(() => true, () => false);
    const roles = hits.map(r => `<@&${r.id}>`).join(', ');
    const outcome = !member ? 'They are no longer in the server.' : !ids.length ? 'They no longer have it.' : removed ? 'It was **taken back off** them.' : '**Vanguard could not remove it.** Move its role above the protected role and remove it by hand.';
    const card = embed('Protected role blocked', `<@${actor}> gave ${roles} to <@${entry.targetId}>, but only \`PROTECTED_ROLE_ASSIGNERS\` and Developers may give it.\n${outcome}`, removed ? Colors.Orange : Colors.Red)
        .setFooter({ text: `Given by: ${actor} · Member: ${entry.targetId}` }).setTimestamp();
    logs.push(guild.id, card);
    void dmSecurityAlert(guild.client, { embeds: [embed('Protected role blocked', `**${guild.name}** (\`${guild.id}\`)\n<@${actor}> (\`${actor}\`) gave ${hits.map(r => `**${r.name ?? r.id}**`).join(', ')} to <@${entry.targetId}> (\`${entry.targetId}\`).\n${outcome}`, removed ? Colors.Orange : Colors.Red)] }).catch(() => 0);
    return removed ? ids : [];
}
