import { Colors, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { BOT_STAFF_IDS, SERVER_STAFF_IDS } from '../../bot/access-ids.js';
import { config } from '../../config.js';
import { embed } from '../../ui/ui.js';
import { activityReport, REPORT_DEFAULTS } from '../../features/schedules.js';
import { setFeature } from '../../features/settings.js';
import { developers } from '../../bot/developers.js';
import { botRank, canAssignBotRank, canAssignServerRank, RANKS, RANK_LABEL, SERVER_LEVELS, rankName, rankOf, isQuarantined, supremeLeaders, isSupreme } from '../../bot/ranks.js';
const label = (r) => r ? RANK_LABEL[rankName(r)] : 'No rank';
export default defineCommand(new SlashCommandBuilder().setName('staff').setDescription('Vanguard staff ranks: who can use which commands')
    .addSubcommand(s => s.setName('role').setDescription('Link a Discord role to a server rank (Head Admin, Admin, Moderator, Helper)')
    .addRoleOption(o => o.setName('role').setDescription('Discord role').setRequired(true))
    .addStringOption(o => o.setName('rank').setDescription('Rank for this role').setRequired(true).addChoices({ name: 'Head Admin', value: 'headadmin' }, { name: 'Admin', value: 'admin' }, { name: 'Moderator', value: 'moderator' }, { name: 'Helper', value: 'helper' }, { name: 'Remove rank', value: 'none' })))
    .addSubcommand(s => s.setName('user').setDescription('Assign a server rank to one user ID, below your own rank')
    .addStringOption(o => o.setName('user_id').setDescription('Discord user ID (enable Developer Mode to copy it)').setRequired(true).setMinLength(17).setMaxLength(20))
    .addStringOption(o => o.setName('rank').setDescription('Rank in this server only').setRequired(true).addChoices(...SERVER_LEVELS.map(value => ({ name: RANK_LABEL[value], value })), { name: 'Remove direct rank', value: 'none' })))
    .addSubcommand(s => s.setName('global').setDescription('Developer: make someone Supreme Leader, Overseer or Bot Manager in every server')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addStringOption(o => o.setName('rank').setDescription('Bot-wide rank').setRequired(true).addChoices({ name: 'Supreme Leader', value: 'supreme' }, { name: 'Overseer', value: 'overseer' }, { name: 'Bot Manager', value: 'botmanager' }, { name: 'Remove rank', value: 'none' })))
    .addSubcommand(s => s.setName('report').setDescription('Staff activity: actions per staff member')
    .addIntegerOption(o => o.setName('days').setDescription('How many days back (default 7)').setMinValue(1).setMaxValue(365))
    .addBooleanOption(o => o.setName('weekly').setDescription('Also turn the automatic weekly report on or off')))
    .addSubcommand(s => s.setName('list').setDescription('Show every rank in this server and bot-wide'))
    .addSubcommand(s => s.setName('check').setDescription('Show someone\'s Vanguard rank here')
    .addUserOption(o => o.setName('user').setDescription('User (default: you)'))), { category: 'configuration', access: 'owner', cooldown: 1500 }, async (ctx, i) => {
    const sub = i.options.getSubcommand(), guild = i.guildId;
    const myRank = rankOf(ctx.store, guild, i.user.id, ctx.actor);
    if (sub === 'report') {
        const weekly = i.options.getBoolean('weekly');
        if (weekly !== null)
            setFeature(ctx.store, guild, 'report', REPORT_DEFAULTS, { enabled: weekly }, i.user.id);
        const days = i.options.getInteger('days') ?? 7;
        return `**Staff activity · last ${days} day${days === 1 ? '' : 's'}**\n${activityReport(ctx.store, guild, i.client.user.id, days)}${weekly !== null ? `\n\nWeekly report in the security log is now **${weekly ? 'on' : 'off'}**.` : ''}`;
    }
    if (sub === 'check') {
        const user = i.options.getUser('user') ?? i.user;
        const member = await i.guild.members.fetch(user.id).catch(() => null);
        return `<@${user.id}> is **${label(rankOf(ctx.store, guild, user.id, member))}** in this server.${isQuarantined(ctx.store, guild, user.id) ? ' Protected bot access is suspended during quarantine.' : ''}`;
    }
    if (sub === 'list') {
        const roles = ctx.store.all('SELECT role_id,level FROM staff_roles WHERE guild_id=?', guild).sort((a, b) => RANKS[b.level] - RANKS[a.level]);
        const global = ctx.store.db.prepare('SELECT user_id,level FROM bot_staff ORDER BY level DESC').all();
        return [
            '**Bot-wide**',
            // The bot owner and DEVELOPER_IDS are Developers (the top rank); they are not listed again as Supreme Leaders.
            `Developer: ${[...new Set([config.ownerId, ...config.developers, ...(BOT_STAFF_IDS.developer ?? [])])].filter(Boolean).map(id => `<@${id}>`).join(' ') || 'none'}`,
            `Supreme Leader: ${[...new Set([...supremeLeaders(), ...(BOT_STAFF_IDS.supreme ?? []), ...global.filter(g => g.level === 'supreme').map(g => g.user_id)])].filter(id => !developers.has(id)).map(id => `<@${id}>`).join(' ') || 'none'}`,
            ...['overseer', 'botmanager'].map(l => `${RANK_LABEL[l]}: ${[...new Set([...(BOT_STAFF_IDS[l] ?? []), ...global.filter(g => g.level === l).map(g => g.user_id)])].map(id => `<@${id}>`).join(' ') || 'none'}`),
            '', '**This server**', `Server Owner: <@${i.guild.ownerId}>`,
            ...[...SERVER_LEVELS].reverse().map(l => `${RANK_LABEL[l]}: ${roles.filter(r => r.level === l).map(r => `<@&${r.role_id}>`).join(' ') || 'none'}`),
            ...ctx.store.all("SELECT user_id,kind FROM grants WHERE guild_id=? AND kind LIKE 'staff:%' AND (expires IS NULL OR expires>?)", guild, Date.now()).map(r => `<@${r.user_id}>: ${RANK_LABEL[String(r.kind).slice(6)] ?? 'Unknown rank'} (direct user ID)`),
            ...Object.entries(SERVER_STAFF_IDS[guild] ?? {}).map(([id, level]) => `<@${id}>: ${RANK_LABEL[level]} (source user ID)`),
            '', '-# Each rank can do everything below it. Head Admins and above assign server ranks with `/setup staff role` or `/setup staff user`, but never at or above their own rank; the server owner and Developers are exempt. Bot-wide ranks are Developer-only: `/setup staff global`.',
        ].join('\n');
    }
    if (sub === 'user') {
        const id = i.options.getString('user_id', true), rank = i.options.getString('rank', true);
        if (!/^\d{17,20}$/.test(id))
            throw new AppError('VALIDATION_ERROR', 'Enter a Discord user ID containing 17–20 digits.');
        if (SERVER_STAFF_IDS[guild]?.[id])
            throw new AppError('VALIDATION_ERROR', 'This user has a server rank in src/bot/access-ids.ts. Change it there, rebuild and restart.');
        if (rank !== 'none' && !SERVER_LEVELS.includes(rank))
            throw new AppError('VALIDATION_ERROR', 'Choose a server rank.');
        // Nobody can give or take a rank at or above their own; the server owner and Developers are exempt.
        const current = ([...SERVER_LEVELS].reverse().find(level => ctx.store.hasGrant(guild, id, `staff:${level}`)) ?? null);
        const decision = canAssignServerRank(ctx.store, guild, i.user.id, ctx.actor, rank === 'none' ? null : rank, current);
        if (!decision.ok)
            throw new AppError('PERMISSION_ERROR', decision.reason);
        const user = await i.client.users.fetch(id);
        if (user.bot)
            throw new AppError('VALIDATION_ERROR', 'Ranks are for people, not bots.');
        ctx.store.transaction(() => {
            for (const level of SERVER_LEVELS)
                ctx.store.revokeGrant(guild, id, `staff:${level}`, i.user.id);
            if (rank !== 'none')
                ctx.store.grant(guild, id, `staff:${rank}`, i.user.id);
        });
        ctx.logs.push(guild, embed('Direct server rank changed', `By <@${i.user.id}> · <@${id}> → ${rank === 'none' ? 'no direct rank' : RANK_LABEL[rank]}`, Colors.Orange));
        return `<@${id}> ${rank === 'none' ? 'no longer has a direct server rank' : `now has **${RANK_LABEL[rank]}** in this server only`}. Other role or bot-wide assignments still apply.`;
    }
    if (sub === 'global') {
        const botDecision = canAssignBotRank(i.user.id);
        if (!botDecision.ok)
            throw new AppError('PERMISSION_ERROR', botDecision.reason);
        const myBotRank = botRank(ctx.store, i.user.id);
        if (myBotRank < RANKS.developer)
            throw new AppError('PERMISSION_ERROR', 'Only a Developer can give or remove bot-wide ranks.');
        const user = i.options.getUser('user', true), rank = i.options.getString('rank', true);
        if (user.bot)
            throw new AppError('VALIDATION_ERROR', 'Ranks are for people, not bots.');
        if (developers.has(user.id) || isSupreme(user.id) || Object.values(BOT_STAFF_IDS).some(ids => ids.includes(user.id)))
            throw new AppError('VALIDATION_ERROR', `<@${user.id}> has their rank set in the bot settings or source ID assignments, so this command cannot change it.`);
        // You can only give, change or remove bot-wide ranks below your own.
        const theirs = ctx.store.db.prepare('SELECT level FROM bot_staff WHERE user_id=?').get(user.id)?.level;
        for (const level of [rank, theirs].filter(l => l && l !== 'none'))
            if (myBotRank <= RANKS[level])
                throw new AppError('PERMISSION_ERROR', `Only someone above ${RANK_LABEL[level]} can give or remove that rank.`);
        if (rank === 'none')
            ctx.store.db.prepare('DELETE FROM bot_staff WHERE user_id=?').run(user.id);
        else
            ctx.store.db.prepare('INSERT INTO bot_staff(user_id,level,by_id,at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET level=excluded.level,by_id=excluded.by_id,at=excluded.at').run(user.id, rank, i.user.id, Date.now());
        ctx.logs.push(guild, embed('Bot-wide rank changed', `By <@${i.user.id}> · <@${user.id}> → ${rank === 'none' ? 'no bot-wide rank' : RANK_LABEL[rank]}`, Colors.Orange));
        return `<@${user.id}> is now **${rank === 'none' ? 'no longer bot-wide staff' : RANK_LABEL[rank]}** in every server.`;
    }
    const role = i.options.getRole('role', true), rank = i.options.getString('rank', true);
    if (role.id === guild || role.managed)
        throw new AppError('VALIDATION_ERROR', 'Choose a normal staff role (not @everyone or a bot role).');
    const current = ctx.store.get('SELECT level FROM staff_roles WHERE guild_id=? AND role_id=?', guild, role.id)?.level;
    // You can only hand out (or take away) ranks below your own; the server owner and Developers are exempt.
    const decision = canAssignServerRank(ctx.store, guild, i.user.id, ctx.actor, rank === 'none' ? null : rank, current ?? null);
    if (!decision.ok)
        throw new AppError('PERMISSION_ERROR', decision.reason);
    ctx.store.transaction(() => {
        ctx.store.run('DELETE FROM permission_roles WHERE guild_id=? AND role_id=?', guild, role.id);
        if (rank === 'none')
            ctx.store.run('DELETE FROM staff_roles WHERE guild_id=? AND role_id=?', guild, role.id);
        else {
            ctx.store.run('INSERT OR IGNORE INTO guild_data(guild_id) VALUES(?)', guild);
            ctx.store.run('INSERT INTO staff_roles(guild_id,role_id,level,by_id,at) VALUES(?,?,?,?,?) ON CONFLICT(guild_id,role_id) DO UPDATE SET level=excluded.level,by_id=excluded.by_id,at=excluded.at', guild, role.id, rank, i.user.id, Date.now());
        }
    });
    ctx.store.history(guild, `staff/${role.id}`, current ? { level: current } : null, rank === 'none' ? null : { level: rank }, i.user.id);
    ctx.logs.push(guild, embed('Staff rank changed', `By <@${i.user.id}> · <@&${role.id}> → ${rank === 'none' ? 'no rank' : RANK_LABEL[rank]}`, Colors.Orange));
    return rank === 'none' ? `<@&${role.id}> no longer has a Vanguard rank.` : `Everyone with <@&${role.id}> is now **${RANK_LABEL[rank]}** in this server.`;
}, { subcommands: { list: { access: 'member', responseKind: 'info' }, check: { access: 'member', responseKind: 'info' }, report: { responseKind: 'info' },
        // Bot-wide ranks are bot management: Developers only. Server ranks need Head Admin or above, and
        // never at or above the caller's own rank (enforced in canAssignServerRank).
        global: { developerOnly: true } } });
