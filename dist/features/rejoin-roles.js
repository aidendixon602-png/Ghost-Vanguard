import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, EmbedBuilder } from 'discord.js';
import { AppError } from '../errors.js';
import { decideRoleChange } from '../security/role-policy.js';
import { approveRoleChange } from '../security/role-authorizations.js';
import { staffReason } from '../security/raidmode.js';
import { historyLines, historySummary } from './joins.js';
/**
 * Remember the roles a member had when they left. When they rejoin, staff get one card with their
 * history and a "Restore roles" button (and /role restore) that gives them all back in one go.
 *
 * Every role goes through the same checks as /role add, so nobody can restore a role they could not
 * give by hand: staff and admin roles need the owner, a developer or an approved grant rule; anything
 * above the bot or owned by an integration is skipped. Pressing the button rewrites that same card
 * with the outcome, so one event leaves one message in the log.
 */
export const KEEP_MS = 90 * 24 * 60 * 60 * 1000;
/** Roles a saved list can carry, one per name: Discord lets two roles share a name, and giving both back shows it twice. */
function rolesToKeep(roles, everyoneId) {
    const kept = [];
    const names = new Set();
    for (const role of roles) {
        if (role.id === everyoneId || role.managed)
            continue;
        const name = role.name.toLowerCase();
        if (names.has(name))
            continue;
        names.add(name);
        kept.push(role.id);
    }
    return kept;
}
export function saveLeftRoles(store, member, now = Date.now()) {
    if (member.user?.bot)
        return;
    const roles = rolesToKeep(member.roles?.cache?.values() ?? [], member.guild.id);
    store.run('DELETE FROM left_roles WHERE guild_id=? AND left_at<?', member.guild.id, now - KEEP_MS);
    if (!roles.length)
        return;
    store.run('INSERT INTO left_roles(guild_id,user_id,roles,left_at) VALUES(?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET roles=excluded.roles,left_at=excluded.left_at', member.guild.id, member.id, JSON.stringify(roles), now);
}
export function savedRoles(store, guildId, userId, now = Date.now()) {
    const row = store.get('SELECT roles,left_at FROM left_roles WHERE guild_id=? AND user_id=? AND left_at>=?', guildId, userId, now - KEEP_MS);
    return row ? { roles: JSON.parse(String(row.roles)), leftAt: Number(row.left_at) } : null;
}
/** Saved role IDs that still exist in the server, one per name, in the order they were given. */
export function savedRoleList(guild, ids) {
    const roles = [];
    const seen = new Set(), names = new Set();
    for (const id of ids) {
        if (seen.has(id))
            continue;
        seen.add(id);
        const role = guild.roles.cache.get(id);
        if (!role)
            continue;
        const name = role.name.toLowerCase();
        if (names.has(name))
            continue;
        names.add(name);
        roles.push(role);
    }
    return roles;
}
export const restoreButton = (userId) => new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`rejoin:restore:${userId}`).setLabel('Restore roles').setEmoji('↩️').setStyle(ButtonStyle.Success));
/** A short reason for a role that was not restored; the presser gets the long one in their reply. */
function shortReason(reason) {
    if (/protected role|staff rank|only the server owner|developer/i.test(reason))
        return 'needs the owner or a developer';
    if (/blacklist/i.test(reason))
        return 'blacklisted here';
    if (/above|highest role/i.test(reason))
        return 'above the restorer’s roles';
    if (/not in this server|could not find them/i.test(reason))
        return 'they are not in the server';
    if (/belongs to a bot or integration/i.test(reason))
        return 'owned by a bot';
    return reason.replace(/\s*\(.*$/, '').slice(0, 80);
}
const MAX_LISTED_ROLES = 10;
/**
 * The whole story of a returning member in one card: when they were last here, the roles they had,
 * their past cases and (after a press) who gave what back. Null when there is nothing to show.
 */
export function rejoinCard(store, guild, input) {
    const saved = savedRoles(store, guild.id, input.userId);
    const live = saved ? savedRoleList(guild, saved.roles) : [];
    const given = input.restored?.result.given ?? [];
    if (!live.length && !given.length)
        return null;
    const leftAt = input.leftAt ?? saved?.leftAt;
    const who = `<@${input.userId}>${input.tag ? ` (${input.tag})` : ''}`;
    const lines = [`${who}${leftAt ? ` came back <t:${Math.floor(leftAt / 1000)}:R>` : ' rejoined'}.`];
    const pending = input.restored ? input.restored.result.skipped.filter(s => s.reason !== 'the role was deleted') : [];
    if (input.restored) {
        if (given.length)
            lines.push(`**<@${input.restored.actorId}> gave back:** ${given.map(id => `<@&${id}>`).join(' ')}`);
        if (input.restored.result.already)
            lines.push(`-# ${input.restored.result.already} they already had.`);
        if (pending.length) {
            const shown = pending.slice(0, 3).map(s => `<@&${s.id}> · ${shortReason(s.reason)}`).join(', ');
            lines.push(`-# Still to restore (${pending.length}): ${shown}${pending.length > 3 ? `, +${pending.length - 3}` : ''}`);
        }
    }
    else if (live.length) {
        const shown = live.slice(0, MAX_LISTED_ROLES);
        lines.push(`**${live.length} saved role${live.length === 1 ? '' : 's'}:** ${shown.map(r => `<@&${r.id}>`).join(' ')}${live.length > shown.length ? ` +${live.length - shown.length}` : ''}`);
    }
    const history = historySummary(store, guild.id, input.userId);
    if (history)
        lines.push('', ...historyLines(history));
    const card = new EmbedBuilder().setDescription(lines.join('\n').slice(0, 3900)).setTimestamp();
    if (input.restored) {
        card.setColor(pending.length ? Colors.Yellow : Colors.Green)
            .setTitle(pending.length ? (given.length ? 'Roles partly restored' : 'Roles not restored') : 'Roles restored');
    }
    else {
        card.setColor(Colors.Blurple).setTitle('Member rejoined')
            .setFooter({ text: 'Restore roles gives back only the roles you may give.' });
    }
    return card;
}
/** Post the card for a returning member, with the Restore roles button. False when there is nothing to post. */
export function onRejoin(store, logs, member) {
    if (member.user?.bot)
        return false;
    const card = rejoinCard(store, member.guild, { userId: member.id, tag: member.user?.tag });
    if (!card)
        return false;
    logs.push(member.guild.id, card, [restoreButton(member.id)]);
    return true;
}
/** Give back saved roles that this staff member is allowed to give. Throws if nothing could be given. */
export async function restoreRoles(store, guild, actorId, userId) {
    const saved = savedRoles(store, guild.id, userId);
    if (!saved)
        throw new AppError('VALIDATION_ERROR', `No saved roles for <@${userId}>. Roles are remembered for 90 days after someone leaves.`);
    const [actor, target, me] = await Promise.all([
        guild.members.fetch({ user: actorId, force: true }),
        guild.members.fetch({ user: userId, force: true }).catch(() => null),
        guild.members.fetchMe({ force: true }),
    ]);
    if (!target)
        throw new AppError('VALIDATION_ERROR', `<@${userId}> is not in the server right now. Their roles stay saved until they rejoin.`);
    const result = { given: [], skipped: [], already: 0, target: { id: userId, tag: target.user?.tag ?? null }, leftAt: saved.leftAt };
    let permissionDenied = 0;
    const seen = new Set(), names = new Set();
    for (const id of saved.roles) {
        if (seen.has(id))
            continue;
        seen.add(id);
        const role = await guild.roles.fetch(id).catch(() => null);
        if (!role) {
            result.skipped.push({ id, reason: 'the role was deleted' });
            continue;
        }
        // Two roles can share a name; one of them is enough to give back.
        const name = role.name.toLowerCase();
        if (names.has(name))
            continue;
        names.add(name);
        const decision = decideRoleChange({ store, guild, actor, target, role, me, op: 'add' });
        if (!decision.ok) {
            if (decision.kind === 'permission')
                permissionDenied++;
            result.skipped.push({ id, reason: decision.reason.replace(/\s*\(.*$/, '').slice(0, 140) });
            continue;
        }
        if (decision.noop) {
            result.already++;
            continue;
        }
        result.given.push(id);
    }
    if (!result.given.length && !result.already)
        throw new AppError(permissionDenied ? 'PERMISSION_ERROR' : 'VALIDATION_ERROR', `Nothing could be restored for <@${userId}>.\n${result.skipped.map(s => `• <@&${s.id}>: ${s.reason}`).join('\n')}`.slice(0, 1800));
    if (result.given.length) {
        // Tell anti-nuke these exact additions are approved (same as /role add), then make them in one change.
        const withdraw = result.given.map(id => approveRoleChange(guild.id, userId, id, 'add'));
        try {
            await target.roles.add(result.given, staffReason(actorId, '/role restore (rejoined member)'));
        }
        catch (error) {
            withdraw.forEach(w => w());
            throw new AppError(error?.code === 50013 ? 'PERMISSION_ERROR' : 'VALIDATION_ERROR', error?.code === 50013
                ? 'Discord refused: Ghost Vanguard is missing Manage Roles or its role is not high enough.' : 'Discord did not make the change. Nothing was restored.');
        }
    }
    // Keep the record while something is still missing, so someone with more access can finish the job.
    if (!result.skipped.some(s => s.reason !== 'the role was deleted'))
        store.run('DELETE FROM left_roles WHERE guild_id=? AND user_id=?', guild.id, userId);
    return result;
}
/** What the person who pressed the button (or ran /role restore) sees. */
export function restoreSummary(userId, r) {
    return [
        r.given.length ? `↩️ Gave <@${userId}> back **${r.given.length}** role(s): ${r.given.map(id => `<@&${id}>`).join(' ')}` : `<@${userId}> already has everything you can give.`,
        r.already ? `-# ${r.already} role(s) they already had.` : '',
        r.skipped.length ? `**Not restored (${r.skipped.length}):**\n${r.skipped.map(s => `• <@&${s.id}>: ${s.reason}`).join('\n')}` : '',
        r.skipped.some(s => s.reason !== 'the role was deleted') ? '-# Someone with more access (the owner, or a developer) can press Restore roles again for the rest.' : '',
    ].filter(Boolean).join('\n').slice(0, 1900);
}
/** The log record for /role restore, which has no card of its own to rewrite. */
export function restoredLog(guildId, actorId, userId, r) {
    const pending = r.skipped.filter(s => s.reason !== 'the role was deleted');
    return new EmbedBuilder().setColor(Colors.Green).setTitle('Roles restored')
        .setDescription([
        `<@${actorId}> gave <@${userId}> back ${r.given.length} role(s) they had before leaving.`,
        r.given.length ? r.given.map(id => `<@&${id}>`).join(' ') : '',
        pending.length ? `-# Not restored (${pending.length}): ${pending.slice(0, 3).map(s => `<@&${s.id}> · ${shortReason(s.reason)}`).join(', ')}${pending.length > 3 ? `, +${pending.length - 3}` : ''}` : '',
    ].filter(Boolean).join('\n').slice(0, 3900))
        .setFooter({ text: `User ID: ${userId} · Server ID: ${guildId}` }).setTimestamp();
}
