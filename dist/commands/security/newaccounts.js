import { Colors, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { embed } from '../../ui/ui.js';
import { newAccountConfig, setNewAccountConfig } from '../../security/new-accounts.js';
const LABEL = {
    hold: 'held (timed out) until the account is old enough',
    kick: 'kicked (they can rejoin once old enough)',
    alert: 'reported to staff only',
};
export default defineCommand(new SlashCommandBuilder().setName('newaccounts').setDescription('Hold brand-new Discord accounts (ban evaders) until they are old enough')
    .addSubcommand(s => s.setName('status').setDescription('Show the new-account rule for this server'))
    .addSubcommand(s => s.setName('on').setDescription('Turn the new-account rule on or change it')
    .addIntegerOption(o => o.setName('min_account_age_days').setDescription('Accounts younger than this are handled (default 7)').setMinValue(1).setMaxValue(90))
    .addStringOption(o => o.setName('action').setDescription('What happens to them (default: hold)').addChoices({ name: 'Hold: time out until old enough (recommended)', value: 'hold' }, { name: 'Kick: they can rejoin once old enough', value: 'kick' }, { name: 'Alert staff only', value: 'alert' })))
    .addSubcommand(s => s.setName('off').setDescription('Stop handling new accounts')), { category: 'security', access: 'security', cooldown: 1500 }, async (ctx, i) => {
    const sub = i.options.getSubcommand(), guild = i.guildId, current = newAccountConfig(ctx.store, guild);
    if (sub === 'status') {
        if (!current.enabled)
            return '**New-account rule: off.** Turn it on with `/raid newaccounts on`.';
        const me = await i.guild.members.fetchMe();
        const perm = current.action === 'kick' ? PermissionFlagsBits.KickMembers : PermissionFlagsBits.ModerateMembers;
        const warn = current.action !== 'alert' && !me.permissions.has(perm) ? `\n⚠ Vanguard is missing **${current.action === 'kick' ? 'Kick Members' : 'Timeout Members'}**, so new accounts are only reported.` : '';
        return `**New-account rule: ON**\nDiscord accounts younger than **${current.minAgeDays} days** are **${LABEL[current.action]}** when they join. Staff get an alert with Let in / Kick / Ban buttons, and a warning when the name resembles a banned account.\nBots and whitelisted accounts are skipped. During \`/raid mode\`, raid mode handles joins instead.${warn}`;
    }
    if (sub === 'off') {
        setNewAccountConfig(ctx.store, guild, i.user.id, { enabled: false });
        ctx.logs.push(guild, embed('New-account rule turned off', `By <@${i.user.id}>`, Colors.Orange));
        return 'New-account rule is **off**. Accounts that are already held stay timed out until it ends; lift one early with the **Let in** button or `/mod untimeout`.';
    }
    const next = setNewAccountConfig(ctx.store, guild, i.user.id, {
        enabled: true,
        minAgeDays: i.options.getInteger('min_account_age_days') ?? current.minAgeDays,
        action: i.options.getString('action') ?? current.action,
    });
    ctx.logs.push(guild, embed('New-account rule updated', `By <@${i.user.id}> · accounts under ${next.minAgeDays} days are ${LABEL[next.action]}`, Colors.Green));
    return `New-account rule is **on**: accounts younger than **${next.minAgeDays} days** are **${LABEL[next.action]}** when they join. Only new joins are affected.`;
}, { subcommands: { status: { responseKind: 'info' } } });
