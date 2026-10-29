import { Colors, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { embed } from '../../ui/ui.js';
import { setFeature } from '../../features/settings.js';
import { permissionAudit, PLUS_DEFAULTS, plusConfig } from '../../features/antinuke-plus.js';

const onOff = (v: boolean) => v ? '🟢 on' : '⚪ off';

export default defineCommand(new SlashCommandBuilder().setName('antinuke-plus').setDescription('Extra anti-nuke layers and a permission safety audit')
    .addSubcommand(s => s.setName('scan').setDescription('Safety scan: powerful roles, roles above Vanguard, bots with Administrator'))
    .addSubcommand(s => s.setName('settings').setDescription('Turn the extra protection layers on or off (all on by default)')
        .addBooleanOption(o => o.setName('raid_auto').setDescription('A join flood switches raid mode on by itself'))
        .addIntegerOption(o => o.setName('raid_hours').setDescription('How long automatic raid mode lasts (default 1)').setMinValue(1).setMaxValue(24))
        .addBooleanOption(o => o.setName('settings_lock').setDescription('Put back server name/icon/settings changed by non-whitelisted people'))
        .addBooleanOption(o => o.setName('bot_quarantine').setDescription('New powerful bots lose their permissions until a Head Admin approves'))
        .addBooleanOption(o => o.setName('join_gate').setDescription('Automatic raid mode raises the verification level to High until it ends'))
        .addBooleanOption(o => o.setName('message_waves').setDescription('Stop the same message from several new accounts (delete, time out, raid mode)'))),
{ category: 'antinuke', access: 'security', cooldown: 3000 }, async (ctx, i) => {
    if (i.options.getSubcommand() === 'scan') return permissionAudit(i.guild);
    const cur = plusConfig(ctx.store, i.guildId);
    const next = setFeature(ctx.store, i.guildId, 'antinukeplus', PLUS_DEFAULTS, {
        raidAuto: i.options.getBoolean('raid_auto') ?? cur.raidAuto, raidAutoHours: i.options.getInteger('raid_hours') ?? cur.raidAutoHours,
        settingsLock: i.options.getBoolean('settings_lock') ?? cur.settingsLock, botQuarantine: i.options.getBoolean('bot_quarantine') ?? cur.botQuarantine,
        joinGate: i.options.getBoolean('join_gate') ?? cur.joinGate ?? true, messageWaves: i.options.getBoolean('message_waves') ?? cur.messageWaves ?? true }, i.user.id);
    const text = `**Raid auto-trigger:** ${onOff(next.raidAuto)} (${next.raidAutoHours}h)\n**Join gate:** ${onOff(next.joinGate !== false)}\n**Message waves:** ${onOff(next.messageWaves !== false)}\n**Server settings lock:** ${onOff(next.settingsLock)}\n**New bot quarantine:** ${onOff(next.botQuarantine)}`;
    ctx.logs.push(i.guildId, embed('Anti-nuke extras changed', `By <@${i.user.id}>\n${text}`, Colors.Orange));
    return `${text}\n-# These work while anti-nuke is enabled.`;
}, { subcommands: { scan: { responseKind: 'info' } } });
