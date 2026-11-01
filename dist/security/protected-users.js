import { AuditLogEvent, Colors } from 'discord.js';
import { developers } from '../bot/developers.js';
import { isTrustedBot } from '../bot/trusted-bots.js';
import { dmSecurityAlert } from '../bot/trusted-dm.js';
import { isProtectedUser } from '../bot/env-rules.js';
import { embed } from '../ui/ui.js';
import { responsibleActor } from './security.js';
import { isBlacklisted } from './role-blacklist.js';
const REASON = 'Ghost Vanguard: protected user (PROTECTED_USERS); only Developers may do this';
/**
 * Someone banned, kicked, timed out or took roles from a PROTECTED_USERS member by hand (or through another bot).
 * Undo it where Discord allows and alert. Developers may act on them; Vanguard's own anti-nuke containment is allowed
 * (a protected account can still be compromised). Returns what was done, for tests and logs.
 */
export async function enforceProtectedUsers(store, logs, entry, guild) {
    const target = entry.targetId;
    if (!target || !isProtectedUser(target))
        return null;
    const actor = responsibleActor(entry, guild);
    if (!actor || actor === target || actor === guild.client.user?.id || isTrustedBot(actor) || developers.has(actor))
        return null;
    let what, outcome;
    const changes = (entry.changes ?? []);
    if (entry.action === AuditLogEvent.MemberBanAdd) {
        what = `banned <@${target}>`;
        outcome = await guild.bans.remove(target, REASON).then(() => 'They were **unbanned** straight away.', () => '**Vanguard could not unban them.** Unban them by hand.');
    }
    else if (entry.action === AuditLogEvent.MemberKick) {
        what = `kicked <@${target}>`;
        outcome = 'Discord cannot undo a kick: send them a new invite.';
    }
    else if (entry.action === AuditLogEvent.MemberUpdate && changes.some(c => c.key === 'communication_disabled_until' && c.new && Date.parse(String(c.new)) > Date.now())) {
        what = `timed out <@${target}>`;
        const member = await guild.members.fetch({ user: target, force: true }).catch(() => null);
        outcome = member ? await member.timeout(null, REASON).then(() => 'The timeout was **lifted**.', () => '**Vanguard could not lift the timeout.** Move its role above theirs.') : 'They are no longer in the server.';
    }
    else if (entry.action === AuditLogEvent.MemberRoleUpdate && changes.some(c => c.key === '$remove' && c.new?.length)) {
        const removed = changes.filter(c => c.key === '$remove').flatMap(c => (c.new ?? []));
        what = `took ${removed.map(r => `**${r.name ?? r.id}**`).join(', ')} from <@${target}>`;
        const member = await guild.members.fetch({ user: target, force: true }).catch(() => null);
        const back = removed.map(r => r.id).filter(id => guild.roles?.cache?.get(id)?.editable !== false && !member?.roles.cache.has(id) && !isBlacklisted(store, guild.id, id));
        outcome = !member ? 'They are no longer in the server.' : !back.length ? 'They already have their roles back.'
            : await member.roles.add(back, REASON).then(() => 'Their roles were **given back**.', () => '**Vanguard could not give the roles back.** Move its role above them.');
    }
    else
        return null;
    const text = `<@${actor}> ${what}, but they are a protected user: only Developers may do that.\n${outcome}`;
    logs.push(guild.id, embed('Protected user', text, Colors.Red).setFooter({ text: `By: ${actor} · Protected user: ${target}` }).setTimestamp());
    void dmSecurityAlert(guild.client, { embeds: [embed('Protected user', `**${guild.name}** (\`${guild.id}\`)\n${text}\n-# By: \`${actor}\``, Colors.Red)] }).catch(() => 0);
    return `${what}: ${outcome}`;
}
