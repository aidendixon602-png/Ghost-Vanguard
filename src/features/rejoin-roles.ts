import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, EmbedBuilder, type Guild, type GuildMember, type PartialGuildMember, type Role } from 'discord.js';
import type { Store } from '../database/db.js';
import type { LogQueue } from '../logging.js';
import { AppError } from '../errors.js';
import { decideRoleChange } from '../security/role-policy.js';
import { approveRoleChange } from '../security/role-authorizations.js';
import { staffReason } from '../security/raidmode.js';

/**
 * Remember the roles a member had when they left. When they rejoin, staff get a "Restore roles" button
 * (and /role restore) that gives them all back in one go. Every role goes through the same checks as
 * /role add, so nobody can restore a role they could not give by hand: staff and admin roles need the
 * owner, a developer or an approved grant rule; anything above the bot or owned by an integration is skipped.
 */
export const KEEP_MS = 90 * 24 * 60 * 60 * 1000;

export function saveLeftRoles(store: Store, member: GuildMember | PartialGuildMember, now = Date.now()) {
    if (member.user?.bot) return;
    const roles = [...(member.roles?.cache?.values() ?? [])].filter(r => r.id !== member.guild.id && !r.managed).map(r => r.id);
    store.run('DELETE FROM left_roles WHERE guild_id=? AND left_at<?', member.guild.id, now - KEEP_MS);
    if (!roles.length) return;
    store.run('INSERT INTO left_roles(guild_id,user_id,roles,left_at) VALUES(?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET roles=excluded.roles,left_at=excluded.left_at', member.guild.id, member.id, JSON.stringify(roles), now);
}

export function savedRoles(store: Store, guildId: string, userId: string, now = Date.now()): { roles: string[]; leftAt: number } | null {
    const row = store.get('SELECT roles,left_at FROM left_roles WHERE guild_id=? AND user_id=? AND left_at>=?', guildId, userId, now - KEEP_MS);
    return row ? { roles: JSON.parse(String(row.roles)) as string[], leftAt: Number(row.left_at) } : null;
}

export const restoreButton = (userId: string) => new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rejoin:restore:${userId}`).setLabel('Restore roles').setEmoji('↩️').setStyle(ButtonStyle.Success));

/** Post the "rejoined" card with a Restore roles button, if we remember roles for them. */
export function onRejoin(store: Store, logs: LogQueue, member: GuildMember) {
    if (member.user?.bot) return;
    const saved = savedRoles(store, member.guild.id, member.id);
    if (!saved) return;
    const still = saved.roles.filter(id => member.guild.roles.cache.has(id));
    if (!still.length) return;
    const shown = still.slice(0, 8);
    const list = shown.map(id => `<@&${id}>`).join(' ');
    const more = still.length > shown.length ? `\n…and ${still.length - shown.length} more role(s)` : '';
    logs.push(member.guild.id, new EmbedBuilder().setColor(Colors.Blurple).setTitle('Member Rejoined')
        .setDescription(`<@${member.id}> came back <t:${Math.floor(saved.leftAt / 1000)}:R>. They had **${still.length}** role(s):\n${list}${more}`.slice(0, 3900))
        .setFooter({ text: 'Use Restore roles to give back roles the staff member is allowed to grant.' }).setTimestamp(), [restoreButton(member.id)]);
}

export interface RestoreResult { given: string[]; skipped: { id: string; reason: string }[]; already: number }

/** Give back saved roles that this staff member is allowed to give. Throws if nothing could be given. */
export async function restoreRoles(store: Store, guild: Guild, actorId: string, userId: string): Promise<RestoreResult> {
    const saved = savedRoles(store, guild.id, userId);
    if (!saved) throw new AppError('VALIDATION_ERROR', `No saved roles for <@${userId}>. Roles are remembered for 90 days after someone leaves.`);
    const [actor, target, me] = await Promise.all([
        guild.members.fetch({ user: actorId, force: true }),
        guild.members.fetch({ user: userId, force: true }).catch(() => null),
        guild.members.fetchMe({ force: true }),
    ]);
    if (!target) throw new AppError('VALIDATION_ERROR', `<@${userId}> is not in the server right now. Their roles stay saved until they rejoin.`);
    const result: RestoreResult = { given: [], skipped: [], already: 0 };
    let permissionDenied = 0;
    for (const id of saved.roles) {
        const role = await guild.roles.fetch(id).catch(() => null) as Role | null;
        if (!role) { result.skipped.push({ id, reason: 'the role was deleted' }); continue; }
        const decision = decideRoleChange({ store, guild, actor, target, role, me, op: 'add' });
        if (!decision.ok) { if (decision.kind === 'permission') permissionDenied++; result.skipped.push({ id, reason: decision.reason.replace(/\s*\(.*$/, '').slice(0, 140) }); continue; }
        if (decision.noop) { result.already++; continue; }
        result.given.push(id);
    }
    if (!result.given.length && !result.already)
        throw new AppError(permissionDenied ? 'PERMISSION_ERROR' : 'VALIDATION_ERROR', `Nothing could be restored for <@${userId}>.\n${result.skipped.map(s => `• <@&${s.id}>: ${s.reason}`).join('\n')}`.slice(0, 1800));
    if (result.given.length) {
        // Tell anti-nuke these exact additions are approved (same as /role add), then make them in one change.
        const withdraw = result.given.map(id => approveRoleChange(guild.id, userId, id, 'add'));
        try { await target.roles.add(result.given, staffReason(actorId, '/role restore (rejoined member)')); }
        catch (error: any) {
            withdraw.forEach(w => w());
            throw new AppError(error?.code === 50013 ? 'PERMISSION_ERROR' : 'VALIDATION_ERROR', error?.code === 50013
                ? 'Discord refused: Ghost Vanguard is missing Manage Roles or its role is not high enough.' : 'Discord did not make the change. Nothing was restored.');
        }
    }
    // Keep the record while something is still missing, so someone with more access can finish the job.
    if (!result.skipped.some(s => s.reason !== 'the role was deleted')) store.run('DELETE FROM left_roles WHERE guild_id=? AND user_id=?', guild.id, userId);
    return result;
}

export function restoreSummary(userId: string, r: RestoreResult): string {
    return [
        r.given.length ? `↩️ Gave <@${userId}> back **${r.given.length}** role(s): ${r.given.map(id => `<@&${id}>`).join(' ')}` : `<@${userId}> already has everything you can give.`,
        r.already ? `-# ${r.already} role(s) they already had.` : '',
        r.skipped.length ? `**Not restored (${r.skipped.length}):**\n${r.skipped.map(s => `• <@&${s.id}>: ${s.reason}`).join('\n')}` : '',
        r.skipped.some(s => s.reason !== 'the role was deleted') ? '-# Someone with more access (the owner, or a developer) can press Restore roles again for the rest.' : '',
    ].filter(Boolean).join('\n').slice(0, 1900);
}

export function restoredLog(guildId: string, actorId: string, userId: string, r: RestoreResult) {
    return new EmbedBuilder().setColor(Colors.Green).setTitle('Roles Restored')
        .setDescription(`<@${actorId}> gave <@${userId}> back ${r.given.length} role(s) they had before leaving.${r.given.length ? `\n${r.given.map(id => `<@&${id}>`).join(' ')}` : ''}${r.skipped.length ? `\n-# ${r.skipped.length} not restored.` : ''}`.slice(0, 3900))
        .setFooter({ text: `User ID: ${userId} · Server ID: ${guildId}` }).setTimestamp();
}
