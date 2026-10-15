import { Colors, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { clip } from '../../core.js';
import { embed } from '../../ui/ui.js';
import { confirmDanger } from '../../ui/danger-ui.js';

const NUMBER = (o: any) => o.setName('number').setDescription('Case number, e.g. 12').setRequired(true).setMinValue(1);
const who = (id: string) => /^\d{17,20}$/.test(id) ? `<@${id}>` : 'Vanguard';

export default defineCommand(new SlashCommandBuilder().setName('case').setDescription('View, search, re-word or delete moderation cases')
    .addSubcommand(s => s.setName('view').setDescription('Show one case: who, what, why and when').addIntegerOption(NUMBER))
    .addSubcommand(s => s.setName('reason').setDescription('Change the reason recorded on a case').addIntegerOption(NUMBER)
        .addStringOption(o => o.setName('reason').setDescription('New reason').setRequired(true).setMaxLength(500)))
    .addSubcommand(s => s.setName('delete').setDescription('Security admins: permanently delete a case record').addIntegerOption(NUMBER))
    .addSubcommand(s => s.setName('search').setDescription('Find cases by member, staff member, action, words in the reason or date')
        .addUserOption(o => o.setName('user').setDescription('The member the case is about'))
        .addUserOption(o => o.setName('moderator').setDescription('Staff member who made it'))
        .addStringOption(o => o.setName('action').setDescription('Type of case').addChoices(...['warn', 'timeout', 'kick', 'ban', 'unban', 'tempban', 'softban', 'massban', 'purge', 'automod timeout', 'new-account hold'].map(v => ({ name: v, value: v }))))
        .addStringOption(o => o.setName('reason_contains').setDescription('Words in the reason').setMaxLength(100))
        .addIntegerOption(o => o.setName('days').setDescription('Only the last N days').setMinValue(1).setMaxValue(3650))
        .addIntegerOption(o => o.setName('page').setDescription('Page').setMinValue(1).setMaxValue(10000)))
    .addSubcommand(s => s.setName('recent').setDescription('The latest cases in this server').addIntegerOption(o => o.setName('page').setDescription('Page (1 = newest)').setMinValue(1).setMaxValue(10000))),
{ category: 'moderation', access: 'member', requiredPermissions: [PermissionFlagsBits.ModerateMembers], cooldown: 1500 }, async (ctx, i) => {
    const sub = i.options.getSubcommand(), guild = i.guildId;
    if (sub === 'search') {
        const where = ['guild_id=?'], args: (string | number)[] = [guild];
        const user = i.options.getUser('user'), mod = i.options.getUser('moderator'), action = i.options.getString('action'), words = i.options.getString('reason_contains'), days = i.options.getInteger('days');
        if (user) { where.push('user_id=?'); args.push(user.id); }
        if (mod) { where.push('moderator_id=?'); args.push(mod.id); }
        if (action) { where.push('(action=? OR action LIKE ?)'); args.push(action, `${action} (%`); }
        if (words) { where.push("reason LIKE ? ESCAPE '\\'"); args.push(`%${words.replace(/[\\%_]/g, c => '\\' + c)}%`); }
        if (days) { where.push('at>=?'); args.push(Date.now() - days * 86400000); }
        if (where.length === 1) throw new AppError('VALIDATION_ERROR', 'Pick at least one filter (user, moderator, action, reason words or days).');
        const total = Number(ctx.store.get(`SELECT COUNT(*) AS n FROM cases WHERE ${where.join(' AND ')}`, ...args)?.n ?? 0);
        const pages = Math.max(1, Math.ceil(total / 10)), page = Math.min(i.options.getInteger('page') ?? 1, pages);
        const rows = ctx.store.all(`SELECT * FROM cases WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 10 OFFSET ?`, ...args, (page - 1) * 10);
        const filters = [user && `member <@${user.id}>`, mod && `by <@${mod.id}>`, action && `action **${action}**`, words && `reason has "${clip(words, 40)}"`, days && `last ${days} days`].filter(Boolean).join(' · ');
        return `**Case search · ${total} found · page ${page}/${pages}**\n-# ${filters}\n${rows.map(r => `**#${r.number}** · ${r.action} · <@${r.user_id}> · by ${who(r.moderator_id)} · <t:${Math.floor(r.at / 1000)}:R>\n${clip(String(r.reason), 120)}`).join('\n') || 'No cases match.'}`;
    }
    if (sub === 'recent') {
        const total = Number(ctx.store.get('SELECT COUNT(*) AS n FROM cases WHERE guild_id=?', guild)?.n ?? 0);
        const pages = Math.max(1, Math.ceil(total / 10)), page = Math.min(i.options.getInteger('page') ?? 1, pages);
        const rows = ctx.store.all('SELECT * FROM cases WHERE guild_id=? ORDER BY id DESC LIMIT 10 OFFSET ?', guild, (page - 1) * 10);
        return `**Recent cases · page ${page}/${pages}** (${total} total)\n${rows.map(r => `**#${r.number}** · ${r.action} · <@${r.user_id}> · by ${who(r.moderator_id)} · <t:${Math.floor(r.at / 1000)}:R>`).join('\n') || 'No cases yet.'}`;
    }
    const number = i.options.getInteger('number', true);
    const row = ctx.store.get('SELECT * FROM cases WHERE guild_id=? AND number=?', guild, number);
    if (!row) throw new AppError('VALIDATION_ERROR', `Case #${number} does not exist in this server. Use /mod case recent.`);
    if (sub === 'view')
        return `**Case #${row.number} · ${row.action}**\n**User:** <@${row.user_id}> (${row.user_id})\n**Moderator:** ${who(row.moderator_id)}\n**When:** <t:${Math.floor(row.at / 1000)}:f>\n**Reason:** ${clip(row.reason, 1500)}`;
    if (sub === 'reason') {
        const reason = i.options.getString('reason', true);
        ctx.store.run('UPDATE cases SET reason=? WHERE guild_id=? AND number=?', reason, guild, number);
        ctx.store.history(guild, `case/${number}`, { reason: row.reason }, { reason }, i.user.id);
        ctx.logs.push(guild, embed(`Case #${number} · reason changed`, `By <@${i.user.id}>\n**Before:** ${clip(row.reason, 700)}\n**After:** ${clip(reason, 700)}`, Colors.Orange));
        return `Case #${number} reason updated.`;
    }
    await confirmDanger(ctx, i, {
        title: `Delete case #${number}`,
        summary: `**${row.action}** · <@${row.user_id}> · by ${who(row.moderator_id)}\n${clip(row.reason, 500)}`,
        consequences: ['The case disappears from /mod history and /mod case.', 'Nothing in Discord is undone (bans, timeouts and kicks stay as they are).', 'The deletion is posted to the security log.'],
        label: `Delete case #${number}`,
        reversal: 'None. The configuration history keeps a copy of the deleted case.',
        run: async (c: any, b: any) => {
            c.store.run('DELETE FROM cases WHERE guild_id=? AND number=?', guild, number);
            c.store.history(guild, `case/${number}`, row, null, b.user.id);
            c.logs.push(guild, embed(`Case #${number} deleted`, `By <@${b.user.id}> · was ${row.action} for <@${row.user_id}>`, Colors.Red));
            return `Case #${number} deleted.`;
        },
    });
}, { subcommands: { delete: { access: 'security' }, view: { responseKind: 'info' }, recent: { responseKind: 'info' }, search: { responseKind: 'info' } } });
