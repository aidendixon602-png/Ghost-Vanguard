import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { clip } from '../../core.js';

export default defineCommand(new SlashCommandBuilder().setName('note').setDescription('Private staff notes on a member (never shown to them)')
    .addSubcommand(s => s.setName('add').setDescription('Write a note about a member').addUserOption(o => o.setName('user').setDescription('Member').setRequired(true))
        .addStringOption(o => o.setName('text').setDescription('Note').setRequired(true).setMaxLength(1000)))
    .addSubcommand(s => s.setName('list').setDescription('Read the notes on a member').addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)))
    .addSubcommand(s => s.setName('remove').setDescription('Delete a note by its number').addIntegerOption(o => o.setName('number').setDescription('Note number from /mod notes list').setRequired(true).setMinValue(1))),
{ category: 'moderation', access: 'member', requiredPermissions: [PermissionFlagsBits.ModerateMembers], cooldown: 1500 }, async (ctx, i) => {
    const sub = i.options.getSubcommand(), guild = i.guildId;
    if (sub === 'add') {
        const user = i.options.getUser('user', true);
        if (ctx.store.get('SELECT COUNT(*) AS n FROM member_notes WHERE guild_id=? AND user_id=?', guild, user.id)?.n >= 100)
            throw new AppError('VALIDATION_ERROR', 'This member already has 100 notes. Remove old ones first.');
        ctx.store.run('INSERT OR IGNORE INTO guild_data(guild_id) VALUES(?)', guild);
        const id = Number(ctx.store.run('INSERT INTO member_notes(guild_id,user_id,author_id,text,at) VALUES(?,?,?,?,?)', guild, user.id, i.user.id, i.options.getString('text', true), Date.now()).lastInsertRowid);
        const number = ctx.store.get('SELECT number FROM member_notes WHERE guild_id=? AND id=?', guild, id)?.number;
        return `Note **#${number}** added for <@${user.id}>. Only staff can read it with /mod notes list.`;
    }
    if (sub === 'list') {
        const user = i.options.getUser('user', true);
        const rows = ctx.store.all('SELECT * FROM member_notes WHERE guild_id=? AND user_id=? ORDER BY id DESC LIMIT 15', guild, user.id);
        return `**Staff notes · ${user.tag}**\n${rows.map(r => `**#${r.number}** · <@${r.author_id}> · <t:${Math.floor(r.at / 1000)}:R>\n${clip(r.text, 300)}`).join('\n\n') || 'No notes.'}`;
    }
    const number = i.options.getInteger('number', true);
    const row = ctx.store.get('SELECT * FROM member_notes WHERE guild_id=? AND number=?', guild, number);
    if (!row) throw new AppError('VALIDATION_ERROR', `Note #${number} does not exist in this server.`);
    ctx.store.run('DELETE FROM member_notes WHERE guild_id=? AND number=?', guild, number);
    ctx.store.history(guild, `note/${number}`, row, null, i.user.id);
    return `Note #${number} removed.`;
}, { subcommands: { list: { responseKind: 'info' } } });
