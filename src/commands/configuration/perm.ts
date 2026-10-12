import { SlashCommandBuilder } from 'discord.js';
import { defineCommand, type CommandContext } from '../../bot/registry.js';
import { discordPermPage, permPage } from '../../ui/perm-ui.js';

export default defineCommand(new SlashCommandBuilder().setName('perm').setDescription('See which roles can use Vanguard, and which can reorder roles')
    .addSubcommand(s => s.setName('list').setDescription('Browse the roles that hold Vanguard command access')
        .addIntegerOption(o => o.setName('page').setDescription('Page to open').setMinValue(1).setMaxValue(1000)))
    .addSubcommand(s => s.setName('discord').setDescription('Roles holding Administrator or Manage Roles, which can reorder the hierarchy')
        .addIntegerOption(o => o.setName('page').setDescription('Page to open').setMinValue(1).setMaxValue(1000))),
{ category: 'configuration', access: 'security', responseKind: 'info', cooldown: 3000 }, async (ctx: CommandContext, i) => {
    const page = i.options.getInteger('page') ?? 1;
    await i.editReply(i.options.getSubcommand() === 'discord'
        ? discordPermPage(ctx, i.guildId, i.user.id, page)
        : permPage(ctx, i.guildId, i.user.id, page));
});
