import { Colors, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { embed } from '../../ui/ui.js';
import { raidState, setRaidMode } from '../../security/raidmode.js';
export default defineCommand(new SlashCommandBuilder().setName('raidmode').setDescription('During a raid, automatically kick or time out brand-new accounts that join')
    .addSubcommand(s => s.setName('on').setDescription('Start raid mode')
    .addIntegerOption(o => o.setName('min_account_age_days').setDescription('Accounts younger than this are handled (default 7)').setMinValue(1).setMaxValue(365))
    .addStringOption(o => o.setName('action').setDescription('What happens to them (default kick)').addChoices({ name: 'Kick (they can rejoin later)', value: 'kick' }, { name: 'Time out for 28 days (staff review)', value: 'timeout' }))
    .addIntegerOption(o => o.setName('hours').setDescription('Switch off automatically after this many hours (default 6; 0 = stay on)').setMinValue(0).setMaxValue(168)))
    .addSubcommand(s => s.setName('off').setDescription('End raid mode'))
    .addSubcommand(s => s.setName('status').setDescription('Show whether raid mode is on and how many joins it handled')), { category: 'security', access: 'security', cooldown: 1500 }, async (ctx, i) => {
    const sub = i.options.getSubcommand(), guild = i.guildId;
    if (sub === 'status') {
        const s = raidState(ctx.store, guild);
        return s.enabled
            ? `**Raid mode: ON** · accounts under **${s.minAgeDays} days** old are **${s.action === 'kick' ? 'kicked' : 'timed out'}**${s.until ? ` · ends <t:${Math.floor(s.until / 1000)}:R>` : ' · until switched off'}\nHandled so far: **${s.handled}** · started by ${s.by ? `<@${s.by}>` : 'unknown'}`
            : `**Raid mode: off.** Last run handled ${s.handled} join(s). Start it with \`/raid mode on\`.`;
    }
    if (sub === 'off') {
        const before = raidState(ctx.store, guild);
        setRaidMode(ctx.store, guild, false, i.user.id, { minAgeDays: before.minAgeDays, action: before.action });
        ctx.logs.push(guild, embed('Raid mode ended', `By <@${i.user.id}> · ${before.handled} join(s) handled`, Colors.Green));
        return `Raid mode is **off**. It handled ${before.handled} join(s).`;
    }
    const action = (i.options.getString('action') ?? 'kick'), minAgeDays = i.options.getInteger('min_account_age_days') ?? 7, hours = i.options.getInteger('hours') ?? 6;
    const me = await i.guild.members.fetchMe();
    const permission = action === 'kick' ? PermissionFlagsBits.KickMembers : PermissionFlagsBits.ModerateMembers;
    const missing = !me.permissions.has(permission) ? `\n⚠ Vanguard is missing **${action === 'kick' ? 'Kick Members' : 'Timeout Members'}**, so it cannot act yet.` : '';
    const s = setRaidMode(ctx.store, guild, true, i.user.id, { minAgeDays, action, hours: hours || undefined });
    ctx.logs.push(guild, embed('Raid mode started', `By <@${i.user.id}> · accounts under ${minAgeDays} days old are ${action === 'kick' ? 'kicked' : 'timed out'}${s.until ? ` · ends <t:${Math.floor(s.until / 1000)}:R>` : ''}`, Colors.Red));
    return `**Raid mode is ON.** New accounts younger than **${minAgeDays} days** will be **${action === 'kick' ? 'kicked' : 'timed out for 28 days'}** as they join${s.until ? `, until <t:${Math.floor(s.until / 1000)}:t>` : ''}. Bots and whitelisted accounts are not affected. A summary posts to the security log every 30 seconds.${missing}`;
}, { subcommands: { status: { responseKind: 'info' } } });
