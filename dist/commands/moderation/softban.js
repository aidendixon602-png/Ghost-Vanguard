import { NO_REASON } from '../../core.js';
import { Colors, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { checkTarget, embed, memberOrNull } from '../../ui/ui.js';
import { confirmDanger } from '../../ui/danger-ui.js';
import { staffReason } from '../../security/raidmode.js';
import { existingBan } from '../../security/network-ban.js';
import { classify, finish, outcomeEmbed } from '../../ui/progress.js';
export default defineCommand(new SlashCommandBuilder().setName('softban').setDescription('Ban then immediately unban: kicks a member and deletes their recent messages')
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason (optional)').setMaxLength(450))
    .addIntegerOption(o => o.setName('delete_messages').setDescription('How much of their history to delete (default 24 hours)').addChoices({ name: 'Last hour', value: 3600 }, { name: 'Last 24 hours', value: 86400 }, { name: 'Last 7 days', value: 604800 })), { category: 'moderation', access: 'member', requiredPermissions: [PermissionFlagsBits.BanMembers], botPermissions: [PermissionFlagsBits.BanMembers], cooldown: 1500 }, async (ctx, i) => {
    const user = i.options.getUser('user', true), reason = (i.options.getString('reason') ?? NO_REASON), seconds = i.options.getInteger('delete_messages') ?? 86400;
    const target = await memberOrNull(i.guild, user.id), me = await i.guild.members.fetchMe();
    if ([ctx.actor.id, me.id, i.guild.ownerId].includes(user.id))
        throw new AppError('VALIDATION_ERROR', 'You cannot target yourself, this bot, or the server owner.');
    if (target)
        checkTarget(ctx.actor, target, me);
    await confirmDanger(ctx, i, {
        title: 'Softban a member', summary: `**${user.tag}** (\`${user.id}\`)\n**Reason:** ${reason}`,
        consequences: ['They are removed from the server but can rejoin with an invite.', `Their messages from the last ${seconds === 3600 ? 'hour' : seconds === 86400 ? '24 hours' : '7 days'} are permanently deleted.`, 'A case is recorded against your account and counts toward anti-nuke limits.'],
        label: `Softban ${user.username}`.slice(0, 80), reversal: 'They can rejoin; deleted messages are gone.',
        working: { title: `Softbanning ${user.username}`, detail: `**${user.tag}** (\`${user.id}\`)\nBanning to delete messages, then lifting the ban…` },
        run: async (c, b) => {
            try {
                // A softban ends by unbanning, so it must never run on someone who is already banned:
                // that would lift their real ban (including a genreban or hardban).
                if (await existingBan(b.guild, user.id))
                    throw new AppError('VALIDATION_ERROR', 'That user is already banned. A softban ends by unbanning, so it would set them free: nothing was changed. To add your reason to their ban, use `/mod ban` instead.');
                // Roles and server ownership can change while the confirmation is open.
                const target = await memberOrNull(b.guild, user.id), me = await b.guild.members.fetchMe({ force: true });
                if ([c.actor.id, me.id, b.guild.ownerId].includes(user.id))
                    throw new AppError('VALIDATION_ERROR', 'You cannot target yourself, this bot, or the server owner.');
                if (target)
                    checkTarget(c.actor, target, me);
                await b.guild.members.ban(user.id, { reason: staffReason(c.actor.id, `softban: ${reason}`), deleteMessageSeconds: seconds });
                // Never report a softban as done while they are still banned.
                const lifted = await b.guild.members.unban(user.id, staffReason(c.actor.id, 'softban: lifting the ban')).then(() => true, () => false);
                const number = c.store.recordCase(b.guildId, user.id, c.actor.id, 'softban', reason, { username: user.tag });
                c.logs.push(b.guildId, embed(`Case #${number} · softban`, `**User:** <@${user.id}> (${user.id})\n**Moderator:** <@${c.actor.id}>\n**Reason:** ${reason}`, Colors.Orange));
                if (!lifted)
                    return finish(b, outcomeEmbed('', { outcome: 'failed', reason: `Case #${number}: **${user.tag}** was banned and their messages deleted, but the ban could not be lifted again, so **they are still banned**. Unban them with \`/mod unban user_id:${user.id}\`.` }));
                return finish(b, outcomeEmbed(`Softban succeeded: ${user.username}`, { outcome: 'success', reason: `Case #${number}: **${user.tag}** (\`${user.id}\`) softbanned. They can rejoin; their recent messages were deleted.\n**Moderator:** <@${c.actor.id}> · **Reason:** ${reason}` }));
            }
            catch (error) {
                return finish(b, outcomeEmbed('', classify(error, 'softban')));
            }
        },
    });
});
