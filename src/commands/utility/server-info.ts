import { SlashCommandBuilder } from 'discord.js';
import { serverInfo } from '../../ui/info-ui.js';
import { defineCommand } from '../../bot/registry.js';

export default defineCommand(new SlashCommandBuilder().setName('server-info').setDescription('Browse complete server details and Vanguard protection status'), { requiresAuthorization: false, responseKind: 'info' }, async (ctx, i) => {
    await i.editReply(serverInfo(ctx, i.guild, i.user.id));
});
