import { ChannelType, Colors, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { clip } from '../../core.js';
import { embed } from '../../ui/ui.js';
import { APPEALS_DEFAULTS, appealsConfig } from '../../features/appeals.js';
import { setFeature } from '../../features/settings.js';
export default defineCommand(new SlashCommandBuilder().setName('appeals').setDescription('Ban appeals: banned users get an Appeal button by DM; staff accept or deny')
    .addSubcommand(s => s.setName('setup').setDescription('Turn appeals on or off and pick the staff channel they go to')
    .addBooleanOption(o => o.setName('enabled').setDescription('On or off').setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('Staff-only channel for appeals').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(s => s.setName('pending').setDescription('Appeals waiting for a decision')), { category: 'moderation', access: 'security', cooldown: 1500 }, async (ctx, i) => {
    const guild = i.guildId;
    if (i.options.getSubcommand() === 'pending') {
        const rows = ctx.store.all("SELECT * FROM appeals WHERE guild_id=? AND status='pending' ORDER BY id LIMIT 15", guild);
        return rows.map(r => `**#${r.id}** · <@${r.user_id}> · <t:${Math.floor(r.at / 1000)}:R>\n${clip(String(r.text), 150)}`).join('\n\n') || 'No appeals are waiting.';
    }
    const enabled = i.options.getBoolean('enabled', true), channel = i.options.getChannel('channel');
    const current = appealsConfig(ctx.store, guild);
    const channelId = channel?.id ?? current.channelId;
    if (enabled && !channelId)
        return 'Pick a **channel** for appeals to go to (a staff-only channel).';
    setFeature(ctx.store, guild, 'appeals', APPEALS_DEFAULTS, { enabled, channelId }, i.user.id);
    ctx.logs.push(guild, embed('Ban appeals changed', `By <@${i.user.id}> · ${enabled ? `on → <#${channelId}>` : 'off'}`, Colors.Orange));
    return enabled
        ? `Appeals **on**. People banned with \`/mod ban\` or \`/mod tempban\` get a DM with the reason and an **Appeal** button. Appeals show up in <#${channelId}> with **Accept (unban)** and **Deny**.\n-# Their DMs must be open, and the DM is sent just before the ban.`
        : 'Appeals **off**. Banned users still get a DM with the reason, without the Appeal button.';
}, { subcommands: { pending: { responseKind: 'info' } } });
