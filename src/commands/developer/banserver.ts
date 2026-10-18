import { SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { confirmDanger } from '../../ui/danger-ui.js';
import { classify, finish, outcomeEmbed } from '../../ui/progress.js';

export default defineCommand(new SlashCommandBuilder().setName('banserver').setDescription('Developer: ban a server from Vanguard')
    .addStringOption(o => o.setName('guild_id').setDescription('Server ID; omit for this server').setMinLength(17).setMaxLength(20))
    .addStringOption(o => o.setName('reason').setDescription('Ban reason').setMaxLength(500)), { category: 'developer', developerOnly: true, requiresAuthorization: false }, async (ctx, i) => {
    const id = i.options.getString('guild_id') ?? i.guildId;
    const name = ctx.client.guilds.cache.get(id)?.name ?? ctx.store.authorization(id)?.name ?? 'Unknown server';
    const reason = i.options.getString('reason') ?? 'Banned by approved developer';
    const here = id === i.guildId;
    await confirmDanger(ctx, i, {
        title: 'Ban a server from Vanguard',
        summary: `**${name}**\n\`${id}\`${here ? '  — **this is the server you are in right now**' : ''}`,
        consequences: [
            'The bot leaves this server and refuses every future invite.',
            'Anti-nuke protection stops immediately.',
            'Stored configuration, snapshots and audit history are kept.',
            `Reason recorded: ${reason}`,
        ],
        label: 'Ban server',
        reversal: '`,unbanserver <guild_id>` lifts the ban, but the bot has to be re-invited and re-authorized afterwards.',
        working: { title: `Banning ${name}`, detail: `\`${id}\`` },
        run: async (c, b) => {
            try {
                return finish(b, outcomeEmbed('Server banned', { outcome: 'success', reason: String(await c.lifecycle.ban(id, name, reason, b.user.id)) }));
            } catch (error) {
                return finish(b, outcomeEmbed('', classify(error, 'server_ban')));
            }
        },
    });
});
