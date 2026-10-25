import { SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { confirmDanger } from '../../ui/danger-ui.js';
export default defineCommand(new SlashCommandBuilder().setName('deauthserver').setDescription('Developer: remove this server\'s authorization and leave')
    .addStringOption(o => o.setName('confirm').setDescription('Type DEAUTHORIZE').setRequired(true).setMaxLength(11).addChoices({ name: 'DEAUTHORIZE', value: 'DEAUTHORIZE' })), { category: 'developer', developerOnly: true, requiresAuthorization: false }, async (ctx, i) => {
    await confirmDanger(ctx, i, {
        title: 'Revoke this server and leave',
        summary: `**${i.guild?.name ?? 'This server'}**\n\`${i.guildId}\``,
        consequences: [
            'Anti-nuke protection is disabled and in-flight work is invalidated.',
            'The bot leaves the server.',
            'Stored configuration, snapshots and audit history are kept.',
        ],
        label: 'Revoke and leave',
        reversal: 'Re-invite the bot and run `/dev server authorize` within 120 seconds.',
        run: (c, b) => Promise.resolve(c.lifecycle.deauthorize(b.guild, b.user.id)),
    });
});
