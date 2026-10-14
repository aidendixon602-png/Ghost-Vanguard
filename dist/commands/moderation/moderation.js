import { offerGenrebanException } from '../../security/network-exception.js';
import { activeBan } from '../../security/network-ban.js';
import { NO_REASON } from '../../core.js';
import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { moderate } from '../../security/moderation.js';
import { defineCommand } from '../../bot/registry.js';
import { confirmDanger } from '../../ui/danger-ui.js';
import { classify, finish, outcomeEmbed, showWorking } from '../../ui/progress.js';
export default defineCommand(new SlashCommandBuilder().setName('moderation').setDescription('Ban, kick, time out, warn, purge, and view a member\'s history')
    .addSubcommand(s => s.setName('ban').setDescription('Ban a user (asks to confirm)').addUserOption(o => o.setName('user').setDescription('Target').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason (optional)').setMaxLength(500)).addIntegerOption(o => o.setName('delete_messages').setDescription('Also delete their recent messages').addChoices({ name: 'Keep messages', value: 0 }, { name: 'Last hour', value: 3600 }, { name: 'Last 24 hours', value: 86400 }, { name: 'Last 7 days', value: 604800 })).addStringOption(o => o.setName('evidence').setDescription('Evidence: links or a short description (shown in the ban log)').setMaxLength(500)))
    .addSubcommand(s => s.setName('unban').setDescription('Lift a ban by user ID (owners/Head Admins can exempt a genreban here; hardbans need a developer)').addStringOption(o => o.setName('user_id').setDescription('Discord user ID').setRequired(true).setMinLength(17).setMaxLength(20)).addStringOption(o => o.setName('reason').setDescription('Reason (optional)').setMaxLength(500)))
    .addSubcommand(s => s.setName('kick').setDescription('Kick a member').addUserOption(o => o.setName('user').setDescription('Target').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason (optional)').setMaxLength(500)))
    .addSubcommand(s => s.setName('timeout').setDescription('Time out a member for a number of minutes').addUserOption(o => o.setName('user').setDescription('Target').setRequired(true)).addIntegerOption(o => o.setName('minutes').setDescription('Duration').setMinValue(1).setMaxValue(40320).setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason (optional)').setMaxLength(500)))
    .addSubcommand(s => s.setName('untimeout').setDescription('Remove a timeout').addUserOption(o => o.setName('user').setDescription('Target').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason (optional)').setMaxLength(500)))
    .addSubcommand(s => s.setName('warn').setDescription('Warn a member (sent by DM and recorded as a case)').addUserOption(o => o.setName('user').setDescription('Target').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true).setMaxLength(500)))
    .addSubcommand(s => s.setName('history').setDescription('Show a member\'s last 10 cases').addUserOption(o => o.setName('user').setDescription('Target').setRequired(true)))
    .addSubcommand(s => s.setName('purge').setDescription('Delete up to 100 recent messages in this channel (asks to confirm)').addIntegerOption(o => o.setName('count').setDescription('1 to 100; messages older than 14 days are skipped').setMinValue(1).setMaxValue(100).setRequired(true))), { category: 'moderation', cooldown: 1500, access: 'member' }, async (ctx, i) => {
    const sub = i.options.getSubcommand();
    // The original command interaction carries the options; the button does not, so the
    // confirmed run reads from `i` and only the reply goes to the button.
    const run = (c) => moderate(i, c.store, c.logs, c.actor);
    // Only the two that destroy data are gated. Kick, timeout and warn are routine and
    // reversible; prompting on those would train staff to click through prompts.
    if (sub === 'purge') {
        const count = i.options.getInteger('count', true);
        await confirmDanger(ctx, i, {
            title: 'Delete messages in this channel',
            summary: `Up to **${count}** recent message(s) in <#${i.channelId}>.`,
            consequences: [
                'Deleted messages cannot be recovered by anyone, including Discord.',
                'Messages older than 14 days are skipped by Discord and will survive.',
                'The deletion is recorded in the moderation log and the Discord audit log.',
            ],
            label: `Delete ${count} message(s)`,
            reversal: 'None. Deleted messages are gone permanently.',
            run,
        });
        return;
    }
    if (sub === 'ban') {
        const target = i.options.getUser('user', true);
        const seconds = i.options.getInteger('delete_messages') ?? 0;
        const window = seconds === 604800 ? 'the last 7 days' : seconds === 86400 ? 'the last 24 hours' : seconds === 3600 ? 'the last hour' : null;
        await confirmDanger(ctx, i, {
            title: 'Ban a user from this server',
            summary: `**${target.tag}**\n\`${target.id}\`\n**Reason:** ${(i.options.getString('reason') ?? NO_REASON)}`,
            consequences: [
                'They are removed and cannot rejoin while banned.',
                window
                    ? `**Their messages from ${window} are permanently deleted.** This cannot be undone.`
                    : 'Their messages are kept.',
                'A moderation case is recorded against your account.',
            ],
            label: `Ban ${target.username}`.slice(0, 80),
            reversal: window
                ? '`/mod unban` restores access, but the deleted messages are gone for good.'
                : '`/mod unban` restores access.',
            working: { title: `Banning ${target.username}`, detail: `**${target.tag}** (\`${target.id}\`)\nChecking role positions and existing bans, then banning…` },
            run: async (c, b) => {
                try {
                    return finish(b, outcomeEmbed(`Ban succeeded: ${target.username}`, { outcome: 'success', reason: await run(c) }));
                }
                catch (error) {
                    return finish(b, outcomeEmbed('', classify(error, 'ban')));
                }
            },
        });
        return;
    }
    if (sub === 'unban') {
        const id = i.options.getString('user_id', true);
        // Genreban (no hardban): the owner or a Head Admin may let them back into this server only.
        const genreban = /^\d{17,20}$/.test(id.trim()) && !activeBan(ctx.store, 'hardban', id.trim()) ? activeBan(ctx.store, 'genreban', id.trim()) : undefined;
        if (genreban)
            return offerGenrebanException(ctx, i, genreban, i.options.getString('reason') ?? NO_REASON);
        await showWorking(i, 'Unbanning', `User ID \`${id}\`\nChecking the ban type and permissions, then unbanning…`);
        try {
            await finish(i, outcomeEmbed('Unban succeeded', { outcome: 'success', reason: await run(ctx) }));
        }
        catch (error) {
            await finish(i, outcomeEmbed('', classify(error, 'unban')));
        }
        return;
    }
    return moderate(i, ctx.store, ctx.logs, ctx.actor);
}, { subcommands: {
        ban: { requiredPermissions: [PermissionFlagsBits.BanMembers], botPermissions: [PermissionFlagsBits.BanMembers] },
        unban: { requiredPermissions: [PermissionFlagsBits.BanMembers], botPermissions: [PermissionFlagsBits.BanMembers] },
        kick: { requiredPermissions: [PermissionFlagsBits.KickMembers], botPermissions: [PermissionFlagsBits.KickMembers] },
        timeout: { requiredPermissions: [PermissionFlagsBits.ModerateMembers], botPermissions: [PermissionFlagsBits.ModerateMembers] },
        untimeout: { requiredPermissions: [PermissionFlagsBits.ModerateMembers], botPermissions: [PermissionFlagsBits.ModerateMembers] },
        warn: { requiredPermissions: [PermissionFlagsBits.ModerateMembers] }, history: { requiredPermissions: [PermissionFlagsBits.ModerateMembers] },
        purge: { requiredPermissions: [PermissionFlagsBits.ManageMessages], botPermissions: [PermissionFlagsBits.ManageMessages], channelPermissions: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory], userChannelPermissions: [PermissionFlagsBits.ManageMessages] }
    } });
