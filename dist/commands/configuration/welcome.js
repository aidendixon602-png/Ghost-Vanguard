import { ChannelType, Colors, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { embed } from '../../ui/ui.js';
import { renderWelcome, sendWelcome, WELCOME_DEFAULTS, welcomeConfig } from '../../features/joins.js';
import { setFeature } from '../../features/settings.js';
export default defineCommand(new SlashCommandBuilder().setName('welcome').setDescription('Greet new members, with a Verify with Roblox button')
    .addSubcommand(s => s.setName('setup').setDescription('Turn welcome messages on or off')
    .addBooleanOption(o => o.setName('enabled').setDescription('On or off').setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('Where to welcome people').addChannelTypes(ChannelType.GuildText))
    .addStringOption(o => o.setName('message').setDescription('Text. Use {user}, {name}, {server}, {count}').setMaxLength(1500))
    .addBooleanOption(o => o.setName('verify_button').setDescription('Add a Verify with Roblox button (needs a verified role set up)')))
    .addSubcommand(s => s.setName('test').setDescription('Send the welcome message for yourself to check how it looks')), { category: 'configuration', access: 'security', cooldown: 1500 }, async (ctx, i) => {
    const guild = i.guildId;
    if (i.options.getSubcommand() === 'test') {
        const w = welcomeConfig(ctx.store, guild);
        if (!w.enabled || !w.channelId)
            throw new AppError('VALIDATION_ERROR', 'Welcome messages are off. Use `/setup welcome setup enabled:true channel:#welcome`.');
        await sendWelcome(ctx.store, ctx.actor);
        return `Sent a test welcome to <#${w.channelId}>.`;
    }
    const current = welcomeConfig(ctx.store, guild);
    const enabled = i.options.getBoolean('enabled', true), channelId = i.options.getChannel('channel')?.id ?? current.channelId;
    if (enabled && !channelId)
        throw new AppError('VALIDATION_ERROR', 'Pick a **channel** for welcome messages.');
    const next = setFeature(ctx.store, guild, 'welcome', WELCOME_DEFAULTS, { enabled, channelId, message: i.options.getString('message') ?? current.message, verifyButton: i.options.getBoolean('verify_button') ?? current.verifyButton }, i.user.id);
    ctx.logs.push(guild, embed('Welcome messages changed', `By <@${i.user.id}> · ${enabled ? `on → <#${channelId}>` : 'off'}`, Colors.Orange));
    const verifyNote = next.verifyButton && !ctx.store.settings(guild).verifiedRoleId ? '\n⚠ The Verify button only shows once a verified role is set with `/setup security verified_role`.' : '';
    return enabled ? `Welcome messages **on** in <#${channelId}>.\n**Preview:** ${renderWelcome(next.message, ctx.actor)}${next.verifyButton ? '\nWith a **Verify with Roblox** button.' : ''}${verifyNote}\nTry it with \`/setup welcome test\`.` : 'Welcome messages **off**.';
});
