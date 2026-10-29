import { NO_REASON } from '../../core.js';
import { Colors, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { sendBanNotice } from '../../features/appeals.js';
import { defineCommand } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { assertNotProtectedUser, checkTarget, embed, memberOrNull } from '../../ui/ui.js';
import { confirmDanger } from '../../ui/danger-ui.js';
import { staffReason } from '../../security/raidmode.js';
import { banTypeFromReason, existingBan } from '../../security/network-ban.js';
import { classify, finish, outcomeEmbed } from '../../ui/progress.js';
import { recordExistingBan } from '../../audit/ban-log.js';

const DURATIONS = [['1 hour', 1], ['6 hours', 6], ['12 hours', 12], ['1 day', 24], ['3 days', 72], ['7 days', 168], ['14 days', 336], ['30 days', 720]] as const;

export default defineCommand(new SlashCommandBuilder().setName('tempban').setDescription('Ban a user for a set time; Vanguard lifts the ban automatically')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addIntegerOption(o => o.setName('duration').setDescription('How long').setRequired(true).addChoices(...DURATIONS.map(([name, value]) => ({ name, value }))))
    .addStringOption(o => o.setName('reason').setDescription('Reason (optional)').setMaxLength(450))
    .addIntegerOption(o => o.setName('delete_messages').setDescription('Also delete recent messages').addChoices({ name: 'Keep messages', value: 0 }, { name: 'Last hour', value: 3600 }, { name: 'Last 24 hours', value: 86400 }, { name: 'Last 7 days', value: 604800 }))
    .addStringOption(o => o.setName('evidence').setDescription('Evidence: links or a short description (shown in the ban log)').setMaxLength(500)),
{ category: 'moderation', access: 'member', requiredPermissions: [PermissionFlagsBits.BanMembers], botPermissions: [PermissionFlagsBits.BanMembers], cooldown: 1500 }, async (ctx, i) => {
    const user = i.options.getUser('user', true), hours = i.options.getInteger('duration', true), reason = (i.options.getString('reason') ?? NO_REASON), seconds = i.options.getInteger('delete_messages') ?? 0, evidence = i.options.getString('evidence');
    const label = DURATIONS.find(([, h]) => h === hours)?.[0] ?? `${hours} hours`;
    const target = await memberOrNull(i.guild, user.id), me = await i.guild.members.fetchMe();
    if ([ctx.actor!.id, me.id, i.guild.ownerId].includes(user.id)) throw new AppError('VALIDATION_ERROR', 'You cannot target yourself, this bot, or the server owner.');
    assertNotProtectedUser(user.id, ctx.actor!.id);
    if (target) checkTarget(ctx.actor!, target, me);
    await confirmDanger(ctx, i, {
        title: `Ban for ${label}`, summary: `**${user.tag}** (\`${user.id}\`)\n**Reason:** ${reason}`,
        consequences: [`They are banned now and automatically unbanned in ${label}.`, seconds ? 'Their recent messages are permanently deleted.' : 'Their messages are kept.', 'A case is recorded against your account and counts toward anti-nuke limits.'],
        label: `Ban ${user.username} for ${label}`.slice(0, 80), reversal: '`/mod unban` lifts it early.',
        working: { title: `Banning ${user.username} for ${label}`, detail: `**${user.tag}** (\`${user.id}\`)\nChecking existing bans, then banning…` },
        run: async (c: any, b: any) => { try {
            const existing = await existingBan(b.guild, user.id);
            // A genreban or hardban is the developers' to change: never put a timer on it.
            if (existing && banTypeFromReason(existing.reason) !== 'local')
                throw new AppError('VALIDATION_ERROR', `That user is already banned here by a Ghost Vanguard ${banTypeFromReason(existing.reason)}, which only a developer can change. Nothing was recorded.`);
            const until = Date.now() + hours * 3600000;
            // Already banned (by hand or another bot): keep the ban and give it an end date instead of refusing.
            if (!existing) {
                await sendBanNotice(c.store, b.guild, user, reason, `This ban ends automatically <t:${Math.floor(until / 1000)}:R>.`);
                await b.guild.members.ban(user.id, { reason: staffReason(c.actor!.id, `tempban ${label}: ${reason}`), deleteMessageSeconds: seconds });
            }
            const number = c.store.recordCase(b.guildId, user.id, c.actor!.id, `tempban (${label})`, reason, { username: user.tag, evidence });
            c.store.run('INSERT OR IGNORE INTO guild_data(guild_id) VALUES(?)', b.guildId);
            c.store.run('INSERT INTO tempbans VALUES(?,?,?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET until=excluded.until,moderator_id=excluded.moderator_id,reason=excluded.reason,case_number=excluded.case_number', b.guildId, user.id, until, c.actor!.id, reason, number);
            c.logs.push(b.guildId, embed(`Case #${number} · tempban (${label})`, `**User:** <@${user.id}> (${user.id})\n**Moderator:** <@${c.actor!.id}>\n**Unbanned:** <t:${Math.floor(until / 1000)}:R>\n**Reason:** ${reason}${existing ? '\n-# They were already banned; this put an end date on that ban.' : ''}`, Colors.Orange));
            let extra = '';
            if (existing) {
                const { record } = recordExistingBan(c.store, c.logs, b.guildId, { id: user.id, tag: user.tag, username: user.username, avatar: user.displayAvatarURL?.() ?? null }, c.actor!.id, reason, evidence, Date.now(), { kind: 'tempban', duration: label, expiresAt: until });
                extra = `\nThey were **already banned**, so instead of a new ban their existing ban now **ends automatically** <t:${Math.floor(until / 1000)}:R>. Their ban record in #bans was updated.`;
            }
            return finish(b, outcomeEmbed(`Tempban succeeded: ${user.username}`, { outcome: 'success', reason: `Case #${number}: **${user.tag}** (\`${user.id}\`) banned until <t:${Math.floor(until / 1000)}:f>.\n**Moderator:** <@${c.actor!.id}> · **Reason:** ${reason}${extra}` }));
        } catch (error) { return finish(b, outcomeEmbed('', classify(error, 'tempban'))); } },
    });
});
