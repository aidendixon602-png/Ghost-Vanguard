import { SlashCommandBuilder } from 'discord.js';
import { serverPage } from '../../ui/components.js';
import { defineCommand } from '../../bot/registry.js';
export default defineCommand(new SlashCommandBuilder().setName('authorizedservers').setDescription('Developer: list every server Vanguard is authorized in')
    .addIntegerOption(o => o.setName('page').setDescription('Page number').setMinValue(1).setMaxValue(100000)), { responseKind: 'info', category: 'developer', developerOnly: true, requiresAuthorization: false }, async (ctx, i) => {
    await i.editReply(serverPage(ctx, i.user.id, (i.options.getInteger('page') ?? 1) - 1));
});
