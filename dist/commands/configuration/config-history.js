import { SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { previewHistory } from '../../ui/config-history.js';
export default defineCommand(new SlashCommandBuilder().setName('config-history').setDescription('See who changed Vanguard settings, and roll changes back')
    .addSubcommand(s => s.setName('list').setDescription('Show recent setting changes and who made them').addIntegerOption(o => o.setName('page').setDescription('History page').setMinValue(1).setMaxValue(1000000)))
    .addSubcommand(s => s.setName('restore').setDescription('Server owner: undo a setting change by its number').addIntegerOption(o => o.setName('id').setDescription('History entry ID').setRequired(true).setMinValue(1))), { category: 'configuration', access: 'security' }, async (ctx, i) => {
    if (i.options.getSubcommand() === 'restore') {
        await previewHistory(ctx, i, i.options.getInteger('id', true));
        return;
    }
    const total = Number(ctx.store.get('SELECT COUNT(*) AS n FROM configuration_history WHERE guild_id=?', i.guildId)?.n ?? 0);
    const pages = Math.max(1, Math.ceil(total / 10)), page = Math.min(i.options.getInteger('page') ?? 1, pages);
    const rows = ctx.store.all('SELECT id,component,actor_id,at FROM configuration_history WHERE guild_id=? ORDER BY id DESC LIMIT 10 OFFSET ?', i.guildId, (page - 1) * 10);
    const who = (id) => /^\d{17,20}$/.test(id) ? `<@${id}>` : id === 'system' ? 'Vanguard' : id;
    const lines = rows.map(r => `**#${r.id} · ${r.component}** · ${who(String(r.actor_id))} · <t:${Math.floor(r.at / 1000)}:f>`).join('\n') || 'No configuration history yet.';
    return `**Configuration history · page ${page}/${pages}** (${total} changes)\n${lines}\nRoll back with \`/setup history restore id:<#>\` (server owner).`;
}, { subcommands: { restore: { access: 'owner' } } });
