import { Colors, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { embed } from '../../ui/ui.js';
import { activeWarnings, WARN_DEFAULTS, warnConfig } from '../../features/warn-points.js';
import { setFeature } from '../../features/settings.js';
const level = (n, what) => n ? `${n} warnings → ${what}` : `${what}: off`;
export default defineCommand(new SlashCommandBuilder().setName('warnings').setDescription('Warning points: automatic timeout, kick or ban after repeated warnings')
    .addSubcommand(s => s.setName('status').setDescription('Show the warning levels, or how many warnings someone has')
    .addUserOption(o => o.setName('user').setDescription('Member to check')))
    .addSubcommand(s => s.setName('setup').setDescription('Change the warning levels (0 turns a level off)')
    .addBooleanOption(o => o.setName('enabled').setDescription('Automatic actions on or off').setRequired(true))
    .addIntegerOption(o => o.setName('timeout_at').setDescription('Warnings for a timeout (default 3)').setMinValue(0).setMaxValue(50))
    .addIntegerOption(o => o.setName('timeout_minutes').setDescription('How long the timeout is (default 60)').setMinValue(1).setMaxValue(40320))
    .addIntegerOption(o => o.setName('kick_at').setDescription('Warnings for a kick (default 5)').setMinValue(0).setMaxValue(50))
    .addIntegerOption(o => o.setName('ban_at').setDescription('Warnings for a ban (default off)').setMinValue(0).setMaxValue(50))
    .addIntegerOption(o => o.setName('days').setDescription('How long a warning counts (default 30 days)').setMinValue(1).setMaxValue(365)))
    .addSubcommand(s => s.setName('pardon').setDescription('Wipe someone\'s active warnings (cases stay in their history)')
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Why').setRequired(true).setMaxLength(300))), { category: 'moderation', access: 'security', cooldown: 1500 }, async (ctx, i) => {
    const sub = i.options.getSubcommand(), guild = i.guildId;
    if (sub === 'status') {
        const c = warnConfig(ctx.store, guild), user = i.options.getUser('user');
        const levels = `**Warning points:** ${c.enabled ? '🟢 on' : '⚪ off'} · warnings count for **${c.days} days**\n• ${level(c.timeoutAt, `${c.timeoutMinutes} min timeout`)}\n• ${level(c.kickAt, 'kick')}\n• ${level(c.banAt, 'ban')}`;
        return user ? `<@${user.id}> has **${activeWarnings(ctx.store, guild, user.id)}** active warning(s).\n\n${levels}` : levels;
    }
    if (sub === 'pardon') {
        const user = i.options.getUser('user', true), reason = i.options.getString('reason', true);
        const before = activeWarnings(ctx.store, guild, user.id);
        const n = ctx.store.recordCase(guild, user.id, i.user.id, 'pardon', reason);
        ctx.logs.push(guild, embed(`Case #${n} · pardon`, `<@${user.id}>'s ${before} active warning(s) were wiped by <@${i.user.id}>.\n**Reason:** ${reason}`, Colors.Green));
        return `Pardoned <@${user.id}>: their ${before} active warning(s) no longer count.`;
    }
    const cur = warnConfig(ctx.store, guild);
    const next = setFeature(ctx.store, guild, 'warnpoints', WARN_DEFAULTS, { enabled: i.options.getBoolean('enabled', true), timeoutAt: i.options.getInteger('timeout_at') ?? cur.timeoutAt, timeoutMinutes: i.options.getInteger('timeout_minutes') ?? cur.timeoutMinutes, kickAt: i.options.getInteger('kick_at') ?? cur.kickAt, banAt: i.options.getInteger('ban_at') ?? cur.banAt, days: i.options.getInteger('days') ?? cur.days }, i.user.id);
    ctx.logs.push(guild, embed('Warning points changed', `By <@${i.user.id}> · ${next.enabled ? 'on' : 'off'} · timeout ${next.timeoutAt || 'off'} · kick ${next.kickAt || 'off'} · ban ${next.banAt || 'off'} · ${next.days} days`, Colors.Orange));
    return `**Warning points ${next.enabled ? 'on' : 'off'}.**\n• ${level(next.timeoutAt, `${next.timeoutMinutes} min timeout`)}\n• ${level(next.kickAt, 'kick')}\n• ${level(next.banAt, 'ban')}\nWarnings count for ${next.days} days.`;
}, { subcommands: { status: { responseKind: 'info' } } });
