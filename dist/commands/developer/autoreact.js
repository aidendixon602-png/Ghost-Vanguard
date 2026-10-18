import { SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { DEFAULT_EMOJI, MAX_PER_SERVER, parseEmoji } from '../../features/autoreact.js';
export default defineCommand(new SlashCommandBuilder().setName('autoreact').setDescription('Developer: auto-react to chosen members\' messages in this server')
    .addSubcommand(s => s.setName('add').setDescription(`React to every message from a member (${DEFAULT_EMOJI} by default)`)
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
    .addStringOption(o => o.setName('emoji').setDescription(`Emoji to react with (default ${DEFAULT_EMOJI})`).setMaxLength(64)))
    .addSubcommand(s => s.setName('remove').setDescription('Stop auto-reacting to a member')
    .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('Members the bot auto-reacts to in this server')), { responseKind: 'info', category: 'developer', developerOnly: true }, async (ctx, i) => {
    const guild = i.guildId;
    const sub = i.options.getSubcommand();
    if (sub === 'list') {
        const rows = ctx.store.all('SELECT user_id, emoji FROM autoreact_users WHERE guild_id=? ORDER BY at', guild);
        if (!rows.length)
            return 'No auto-reactions in this server. Add one with `,autoreact add`.';
        return [`**Auto-reactions in this server (${rows.length}):**`, ...rows.map(r => `${r.emoji}  <@${r.user_id}>`)].join('\n');
    }
    const user = i.options.getUser('user', true);
    if (sub === 'remove') {
        const removed = ctx.store.run('DELETE FROM autoreact_users WHERE guild_id=? AND user_id=?', guild, user.id).changes;
        return removed ? `Stopped auto-reacting to <@${user.id}>.` : `<@${user.id}> was not on the auto-react list.`;
    }
    const emoji = parseEmoji(i.options.getString('emoji'));
    if (!emoji)
        throw new AppError('VALIDATION_ERROR', 'Use one emoji, like 🐐, or a custom emoji from a server the bot is in.');
    const exists = ctx.store.get('SELECT 1 FROM autoreact_users WHERE guild_id=? AND user_id=?', guild, user.id);
    if (!exists && Number(ctx.store.get('SELECT COUNT(*) AS n FROM autoreact_users WHERE guild_id=?', guild)?.n ?? 0) >= MAX_PER_SERVER)
        throw new AppError('VALIDATION_ERROR', `This server already has ${MAX_PER_SERVER} auto-reactions. Remove one first.`);
    ctx.store.run('INSERT INTO autoreact_users(guild_id,user_id,emoji,by_id,at) VALUES(?,?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET emoji=excluded.emoji, by_id=excluded.by_id, at=excluded.at', guild, user.id, emoji, i.user.id, Date.now());
    return `${exists ? 'Updated' : 'Added'}: the bot will react ${emoji} to every message from <@${user.id}> in this server.`;
});
