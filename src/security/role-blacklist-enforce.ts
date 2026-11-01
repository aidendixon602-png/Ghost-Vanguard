import { AuditLogEvent, Colors, type Client, type Guild, type GuildAuditLogsEntry, type GuildMember } from 'discord.js';
import type { Store } from '../database/db.js';
import type { LogQueue } from '../logging.js';
import { developers } from '../bot/developers.js';
import { embed } from '../ui/ui.js';
import { responsibleActor } from './security.js';
import {
    addHolder, blacklistHolders, blacklistRow, canAssignBlacklisted, clearHolders, describeAssigners, assignersOf,
    isBlacklisted, moveBlacklisted, removeBlacklisted, removeHolder,
} from './role-blacklist.js';

/**
 * Enforcement for the role blacklist, driven by Discord's audit log so it covers roles given through the
 * bot and straight in Discord:
 *
 *  - a blacklisted role added by someone not listed for it is taken straight back off, logged, and the
 *    person who did it is DMed with the role name and the reason;
 *  - a blacklisted role deleted by someone not listed for it is recreated with its saved shape, handed
 *    back to the members recorded as having it, and the blacklist follows the new role.
 *
 * Vanguard's own internal work never trips this: restores and quarantine releases skip blacklisted roles
 * (see features/rejoin-roles.ts and security/security.ts) and the bot itself is never treated as the actor.
 */

const REASON = 'Ghost Vanguard: blacklisted role';

/** Direct message the person who tried, with what happened and why. */
export async function dmActor(client: Client, userId: string, title: string, body: string): Promise<boolean> {
    try {
        const user = await client.users.fetch(userId);
        await user.send({ embeds: [embed(title, body, Colors.Red)] });
        return true;
    } catch { return false; }
}

const changesOf = (entry: GuildAuditLogsEntry) => (entry.changes ?? []) as { key: string; new?: { id: string }[] }[];

export async function enforceRoleBlacklist(store: Store, logs: LogQueue, entry: GuildAuditLogsEntry, guild: Guild): Promise<void> {
    if (entry.action === AuditLogEvent.MemberRoleUpdate) return enforceMemberRoles(store, logs, entry, guild);
    if (entry.action === AuditLogEvent.RoleDelete) return enforceRoleDelete(store, logs, entry, guild);
}

async function enforceMemberRoles(store: Store, logs: LogQueue, entry: GuildAuditLogsEntry, guild: Guild): Promise<void> {
    if (!entry.targetId) return;
    const added = [...new Set(changesOf(entry).filter(c => c.key === '$add').flatMap(c => c.new ?? []).map(r => r.id))];
    const removed = [...new Set(changesOf(entry).filter(c => c.key === '$remove').flatMap(c => c.new ?? []).map(r => r.id))];
    // Remember who holds a blacklisted role, so an unauthorised delete can be put back later.
    for (const id of added) if (isBlacklisted(store, guild.id, id)) addHolder(store, guild.id, id, entry.targetId);
    for (const id of removed) if (isBlacklisted(store, guild.id, id)) removeHolder(store, guild.id, id, entry.targetId);

    const watched = added.filter(id => isBlacklisted(store, guild.id, id));
    if (!watched.length) return;
    const actor = responsibleActor(entry, guild);
    if (!actor || actor === guild.client.user?.id) return;
    const member = await guild.members.fetch({ user: actor, force: true }).catch(() => null);
    const actorRoles = [...(member?.roles?.cache?.keys() ?? [])];
    if (watched.every(id => canAssignBlacklisted(store, guild.id, id, actor, actorRoles))) return;

    const blocked = watched.filter(id => !canAssignBlacklisted(store, guild.id, id, actor, actorRoles));
    const target: GuildMember | null = await guild.members.fetch({ user: entry.targetId, force: true }).catch(() => null);
    const held = target ? blocked.filter(id => target.roles.cache.has(id)) : [];
    let reverted = false;
    if (target && held.length)
        reverted = await target.roles.remove(held, `${REASON} given by someone not allowed to`).then(() => true, () => false);
    const names = blocked.map(id => `<@&${id}>`).join(', ');
    const outcome = !target ? 'They are no longer in the server.'
        : !held.length ? 'They no longer have it.'
        : reverted ? 'It was **taken back off** them.'
        : '**Vanguard could not remove it.** Move its role above the blacklisted role and remove it by hand.';
    const allowed = blocked.map(id => describeAssigners(assignersOf(store, guild.id, id))).join('; ');
    logs.push(guild.id, embed('Blacklisted role blocked',
        `<@${actor}> gave ${names} to <@${entry.targetId}>. Only the people listed for a blacklisted role may give it.\n${outcome}\n-# Allowed for this role: ${allowed || 'nobody'}`, Colors.Red)
        .setFooter({ text: `Given by: ${actor} · Member: ${entry.targetId}` }).setTimestamp());
    const dm = await dmActor(guild.client, actor, 'Blacklisted role blocked', [
        `You gave **${blocked.map(id => guild.roles.cache.get(id)?.name ?? id).join('**, **')}** to <@${entry.targetId}> in **${guild.name}**.`,
        '',
        'That role is blacklisted in this server, so only the people and roles listed for it can hand it out. Your staff rank or Discord permissions do not override that.',
        '',
        outcome.replace(/\*\*/g, ''),
    ].join('\n'));
    if (!dm) logs.push(guild.id, embed('Blacklist DM not delivered', `Vanguard could not DM <@${actor}>. Their DMs are probably closed.`, Colors.DarkButNotBlack));
}

async function enforceRoleDelete(store: Store, logs: LogQueue, entry: GuildAuditLogsEntry, guild: Guild): Promise<void> {
    if (!entry.targetId) return;
    const row = blacklistRow(store, guild.id, entry.targetId);
    if (!row) return;
    const actor = responsibleActor(entry, guild);
    if (!actor || actor === guild.client.user?.id) return;
    const member = await guild.members.fetch({ user: actor, force: true }).catch(() => null);
    const actorRoles = [...(member?.roles?.cache?.keys() ?? [])];
    const allowed = developers.has(actor) || actor === guild.ownerId || canAssignBlacklisted(store, guild.id, entry.targetId, actor, actorRoles);
    const name = row.name ?? entry.targetId;
    if (allowed) {
        removeBlacklisted(store, guild.id, entry.targetId);
        logs.push(guild.id, embed('Blacklisted role deleted', `<@${actor}> deleted **${name}**. They are the server owner, a Developer, or listed for that role, so the blacklist entry was removed with it.`, Colors.Orange));
        return;
    }

    const holders = blacklistHolders(store, guild.id, entry.targetId);
    const permissions = BigInt(row.permissions ?? '0');
    const recreated = await guild.roles.create({
        name, color: row.color, hoist: !!row.hoist, mentionable: !!row.mentionable, permissions,
        reason: 'Ghost Vanguard: blacklisted role deleted without permission',
    }).catch(() => null);
    if (!recreated) {
        logs.push(guild.id, embed('Blacklisted role deleted', `<@${actor}> deleted **${name}** and Vanguard could not recreate it. Check Manage Roles and the role hierarchy.`, Colors.Red));
        await dmActor(guild.client, actor, 'Blacklisted role deleted', `You deleted **${name}** in **${guild.name}**. It is blacklisted there, and Vanguard could not put it back. Staff will need to restore it by hand.`);
        return;
    }
    if (row.position !== null) await recreated.setPosition(Math.max(1, row.position)).catch(() => null);
    moveBlacklisted(store, guild.id, entry.targetId, recreated.id, recreated);
    let given = 0, failed = 0;
    for (const userId of holders) {
        const holder = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
        if (!holder) continue;
        try { await holder.roles.add(recreated.id, 'Ghost Vanguard: restoring a blacklisted role that was deleted'); given++; } catch { failed++; }
    }
    logs.push(guild.id, embed('Blacklisted role put back',
        `<@${actor}> deleted **${name}**, which is blacklisted. Vanguard recreated it as <@&${recreated.id}> and gave it back to **${given}** member${given === 1 ? '' : 's'}.${failed ? ` ${failed} could not be given it; check the role hierarchy.` : ''}`,
        failed ? Colors.Red : Colors.Orange));
    await dmActor(guild.client, actor, 'Blacklisted role deleted', [
        `You deleted **${name}** in **${guild.name}**.`,
        '',
        'That role is blacklisted, so only the people and roles listed for it can delete or hand it out. Vanguard put it back.',
        ...(given ? ['', `It was given back to ${given} member${given === 1 ? '' : 's'}.`] : []),
    ].join('\n'));
}

/** Called when a role becomes blacklisted: remember who already has it. */
export async function captureBlacklistHolders(store: Store, guild: Guild, roleId: string): Promise<number> {
    clearHolders(store, guild.id, roleId);
    const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
    const members = role && 'members' in role ? [...role.members.values()] : [];
    for (const member of members) if (!member.user.bot) addHolder(store, guild.id, roleId, member.id);
    return members.length;
}
