import { SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { helpPage } from '../../ui/help-ui.js';
export default defineCommand(new SlashCommandBuilder().setName('help').setDescription('Browse every command you can use, by section'), { requiresAuthorization: false, responseKind: 'info' }, async (ctx, i) => {
    await i.editReply(helpPage(ctx, i.guildId, i.user.id));
});
