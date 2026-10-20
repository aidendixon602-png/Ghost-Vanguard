import { SlashCommandBuilder } from 'discord.js';
import { botInfo } from '../../ui/info-ui.js';
import { defineCommand } from '../../bot/registry.js';
export default defineCommand(new SlashCommandBuilder().setName('bot-info').setDescription('About Vanguard: developer, uptime and protection statistics'), { requiresAuthorization: false, responseKind: 'info' }, async (ctx, i) => {
    await i.editReply({ embeds: [botInfo(ctx)], allowedMentions: { parse: [] } });
});
