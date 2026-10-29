import { ChatInputCommandInteraction, Colors, GuildMember, PermissionFlagsBits } from 'discord.js';
import { clip, NO_REASON } from '../core.js';
import type { Store } from '../database/db.js';
import { AppError } from '../errors.js';
import type { LogQueue } from '../logging.js';
import { assertNotProtectedUser, checkTarget, embed, memberOrNull } from '../ui/ui.js';
import { RANKS, rankOf } from '../bot/ranks.js';
import { sendBanNotice } from '../features/appeals.js';
import { escalateWarnings } from '../features/warn-points.js';
import { assertLocalUnban, banTypeFromReason, existingBan } from './network-ban.js';
import { recordExistingBan } from '../audit/ban-log.js';


export async function moderate(i: ChatInputCommandInteraction<'cached'>, store: Store, logs: LogQueue, actor: GuildMember) {
    const me = await i.guild.members.fetchMe();
    const sub = i.options.getSubcommand();
    if (sub === 'purge') {
        const channel = i.channel;
        if (!channel || !('bulkDelete' in channel) || !channel.permissionsFor(actor)?.has(PermissionFlagsBits.ManageMessages) && rankOf(store, i.guildId, actor.id, actor) < RANKS.moderator
            || !channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageMessages))
            throw new AppError('VALIDATION_ERROR', 'Manage Messages is required in this channel.');
        store.assertAuthorized(i.guildId);
        const deleted = await channel.bulkDelete(i.options.getInteger('count', true), true);
        const id = store.recordCase(i.guildId, i.channelId, actor.id, sub, `Deleted ${deleted.size} messages`);
        logs.push(i.guildId, embed(`Case #${id} · Message purge`, `**Moderator:** <@${actor.id}>\n**Channel:** <#${i.channelId}>\n**Deleted:** ${deleted.size}`, Colors.Orange));
        return `Deleted ${deleted.size} messages. Messages older than 14 days were skipped.`;
    }
    if (sub === 'history') {
        const user = i.options.getUser('user', true);
        const rows = store.all('SELECT * FROM cases WHERE guild_id=? AND user_id=? ORDER BY id DESC LIMIT 10', i.guildId, user.id);
        return rows.map(r => `**Case #${r.number ?? r.id} · ${r.action}** · <t:${Math.floor(r.at / 1000)}:R>\n${clip(r.reason, 200)} · by <@${r.moderator_id}>`).join('\n\n') || 'No cases recorded for this user.';
    }
    // Optional for everything except /mod warn (where the reason is the warning itself, so Discord requires it).
    const reason = i.options.getString('reason') ?? NO_REASON;
    const auditReason = clip(`${actor.id}: ${reason}`, 500);
    let targetId: string;
    let username: string | null = null;
    let note = '';
    let alreadyBanned = false;
    if (sub === 'unban') {
        targetId = i.options.getString('user_id', true).trim();
        if (!/^\d{17,20}$/.test(targetId))
            throw new AppError('VALIDATION_ERROR', `\`${clip(targetId, 30)}\` is not a valid Discord user ID. IDs are 17–20 digits.`);
        const existing = await existingBan(i.guild, targetId);
        if (existing === null)
            throw new AppError('VALIDATION_ERROR', 'That user is not banned here.');
        // /mod unban lifts local bans only. Genrebans and hardbans belong to the developers.
        await assertLocalUnban(store, i.guild, targetId, existing);
        store.assertAuthorized(i.guildId);
        await i.guild.members.unban(targetId, auditReason);
    } else {
        const user = i.options.getUser('user', true);
        targetId = user.id;
        username = user.tag ?? user.username ?? null;
        assertNotProtectedUser(targetId, actor.id);
        const target = await memberOrNull(i.guild, targetId);
        if ([actor.id, me.id, i.guild.ownerId].includes(targetId))
            throw new AppError('VALIDATION_ERROR', 'You cannot target yourself, this bot, or the server owner.');
        if (target)
            checkTarget(actor, target, me);
        store.assertAuthorized(i.guildId);
        if (sub === 'ban') {
            // Already banned (by hand, another bot, or before the ban log): Discord's ban is left alone and
            // this reason/evidence goes on their record instead of the command being refused.
            const existing = await existingBan(i.guild, targetId);
            // A genreban or hardban belongs to the developers; its reason and record stay theirs.
            if (existing && banTypeFromReason(existing.reason) !== 'local')
                throw new AppError('VALIDATION_ERROR', `That user is already banned here by a Ghost Vanguard ${banTypeFromReason(existing.reason)}, which only a developer can change. Nothing was recorded.`);
            if (existing) alreadyBanned = true;
            const deleteMessageSeconds = alreadyBanned ? 0 : i.options.getInteger('delete_messages') ?? 0;
            if (!alreadyBanned) {
                // Tell them why (with an Appeal button when appeals are on) while they still share a server with the bot.
                if (!await sendBanNotice(store, i.guild, user, reason)) note = 'The ban DM could not be delivered (their DMs may be closed).';
                await i.guild.members.ban(targetId, { reason: auditReason, deleteMessageSeconds });
                if (deleteMessageSeconds)
                    note = `${note ? note + ' ' : ''}Their messages from the last ${deleteMessageSeconds === 3600 ? 'hour' : deleteMessageSeconds === 86400 ? '24 hours' : '7 days'} were deleted.`;
            }
        } else {
            if (!target)
                throw new AppError('VALIDATION_ERROR', 'That user is not a member of this server.');
            if (sub === 'kick') {
                if (!target.kickable)
                    throw new AppError('VALIDATION_ERROR', 'That member cannot be kicked by this bot.');
                await target.kick(auditReason);
            } else if (sub === 'timeout' || sub === 'untimeout') {
                // Helpers may time out for up to an hour; longer needs Moderator or Discord's Timeout Members.
                if (sub === 'timeout' && i.options.getInteger('minutes', true) > 60 && rankOf(store, i.guildId, actor.id, actor) < RANKS.moderator && !actor.permissions.has(PermissionFlagsBits.ModerateMembers))
                    throw new AppError('PERMISSION_ERROR', 'Helpers can time out for up to 60 minutes. Ask a Moderator for longer.');
                if (!target.moderatable)
                    throw new AppError('VALIDATION_ERROR', 'That member cannot be timed out by this bot.');
                await target.timeout(sub === 'timeout' ? i.options.getInteger('minutes', true) * 60000 : null, auditReason);
            } else if (sub === 'warn') {
                const delivered = await user.send({ embeds: [embed(`Warning · ${i.guild.name}`, reason, Colors.Orange)], allowedMentions: { parse: [] } }).then(() => true, () => false);
                if (!delivered)
                    note = 'The warning DM could not be delivered (their DMs may be closed), so tell them in the channel.';
            }
        }
    }
    const id = store.recordCase(i.guildId, targetId, actor.id, sub, reason, { username, evidence: sub === 'ban' ? i.options.getString('evidence') : null });
    if (alreadyBanned) {
        const user = i.options.getUser('user', true);
        const { record, isNew } = recordExistingBan(store, logs, i.guildId, { id: targetId, tag: user.tag, username: user.username, avatar: user.displayAvatarURL?.() ?? null }, actor.id, reason, i.options.getString('evidence'));
        note = [`They were **already banned** on Discord, so the ban itself did not change. Your reason${i.options.getString('evidence') ? ' and evidence were' : ' was'} ${isNew ? 'used to start' : 'added to'} their ban record in #bans.`, note].filter(Boolean).join('\n');
    }
    // Warning points: enough warnings trigger an automatic timeout, kick or ban.
    // Only members can be escalated (a ban on someone already gone needs a Moderator's own decision).
    if (sub === 'warn' && await memberOrNull(i.guild, targetId))
        note = [note, await escalateWarnings(store, logs, i.guild, targetId, actor.id, rankOf(store, i.guildId, actor.id, actor) >= RANKS.moderator || !!actor.permissions?.has(PermissionFlagsBits.BanMembers))].filter(Boolean).join('\n');
    logs.push(i.guildId, embed(`Case #${id} · ${sub}`, `**User:** <@${targetId}> ${username ? `${username} ` : ''}(${targetId})\n**Moderator:** <@${actor.id}>\n**Reason:** ${reason}${note ? `\n${note}` : ''}`, Colors.Orange));
    return `Recorded case #${id}: **${sub}** for <@${targetId}>${username ? ` (${username})` : ''}.\n**User ID:** \`${targetId}\` · **Moderator:** <@${actor.id}> · <t:${Math.floor(Date.now() / 1000)}:f>\n**Reason:** ${reason}${note ? `\n${note}` : ''}`;
}
