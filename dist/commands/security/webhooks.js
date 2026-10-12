import { SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { webhookList } from '../../features/webhooks.js';
export default defineCommand(new SlashCommandBuilder().setName('webhooks').setDescription('List every webhook in the server and delete ones you do not trust'), { category: 'security', access: 'security', cooldown: 3000 }, async (_ctx, i) => {
    await i.editReply(await webhookList(i.guild));
});
