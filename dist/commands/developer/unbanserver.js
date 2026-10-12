import { SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { confirmDanger } from '../../ui/danger-ui.js';
import { classify, finish, outcomeEmbed } from '../../ui/progress.js';
export default defineCommand(new SlashCommandBuilder().setName('unbanserver').setDescription('Developer: remove a server ban')
    .addStringOption(o => o.setName('guild_id').setDescription('Server ID').setRequired(true).setMinLength(17).setMaxLength(20)), { category: 'developer', developerOnly: true, requiresAuthorization: false }, async (ctx, i) => {
    const id = i.options.getString('guild_id', true);
    const name = ctx.store.authorization(id)?.name ?? 'Unknown server';
    await confirmDanger(ctx, i, {
        title: 'Remove a server ban',
        summary: `**${name}**\n\`${id}\``,
        consequences: [
            'The server may invite Vanguard again.',
            'It stays deauthorized until a developer runs `/dev authserver` inside it.',
            'No protection is enabled by this alone.',
        ],
        label: 'Remove ban',
        reversal: '`/dev banserver` re-applies the ban at any time.',
        working: { title: `Removing the ban on ${name}`, detail: `\`${id}\`` },
        run: async (c, b) => {
            try {
                return finish(b, outcomeEmbed('Server ban removed', { outcome: 'success', reason: String(await c.lifecycle.unban(id, b.user.id)) }));
            }
            catch (error) {
                return finish(b, outcomeEmbed('', classify(error, 'server_unban')));
            }
        },
    });
});
