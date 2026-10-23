import { ChannelType, Colors, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { configureEventLog, eventLogConfig, LOG_CATEGORIES, LOG_RETENTION_DAYS, recentEvents, type LogCategory } from '../../audit/event-log.js';
import { embed } from '../../ui/ui.js';
import { BANS_CHANNEL, checkChannel, describeCheck, LOGGING_CHANNEL, logChannels, serverPermissionGaps, setLogChannels, setupLogChannels } from '../../audit/log-setup.js';

const CATEGORY_LABELS: Record<LogCategory, string> = {
    moderation: 'Moderation (bans, kicks, timeouts, prunes)',
    members: 'Members (joins, leaves, role and nickname changes)',
    roles: 'Roles (created, changed, deleted)',
    channels: 'Channels (created, changed, deleted, permissions)',
    server: 'Server (settings, invites, webhooks, emojis, bots, AutoMod)',
    messages: 'Messages (deleted by moderators, bulk deletes, pins)',
};

const choices = LOG_CATEGORIES.map(c => ({ name: CATEGORY_LABELS[c].slice(0, 100), value: c }));

export default defineCommand(new SlashCommandBuilder().setName('logs').setDescription('Server event logs: who changed what, viewable in Discord')
    .addSubcommand(s => s.setName('setup').setDescription(`Create or reuse #${BANS_CHANNEL} and #${LOGGING_CHANNEL}, check access and send a test`)
        .addChannelOption(o => o.setName('bans_channel').setDescription(`Use this channel for ban logs instead of #${BANS_CHANNEL}`).addChannelTypes(ChannelType.GuildText))
        .addChannelOption(o => o.setName('logging_channel').setDescription(`Use this channel for server logs instead of #${LOGGING_CHANNEL}`).addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(s => s.setName('check').setDescription('Check both log channels and the bot permissions, then send a test embed'))
    .addSubcommand(s => s.setName('exclude').setDescription('Stop (or start again) logging events from a channel')
        .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true))
        .addBooleanOption(o => o.setName('excluded').setDescription('True: do not log this channel · False: log it again').setRequired(true)))
    .addSubcommand(s => s.setName('bot-changes').setDescription('Skip routine bot changes, like member-count channel renames')
        .addBooleanOption(o => o.setName('ignore').setDescription('True: skip them (default) · False: log them').setRequired(true)))
    .addSubcommand(s => s.setName('status').setDescription('Show event logging settings'))
    .addSubcommand(s => s.setName('enable').setDescription('Turn on event logging')
        .addChannelOption(o => o.setName('channel').setDescription('Where to post events (default: the security log channel)').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(s => s.setName('disable').setDescription('Turn off event logging (stored history is kept)'))
    .addSubcommand(s => s.setName('category').setDescription('Choose which kinds of events are logged')
        .addStringOption(o => o.setName('name').setDescription('Category').setRequired(true).addChoices(...choices))
        .addBooleanOption(o => o.setName('enabled').setDescription('Log this category').setRequired(true)))
    .addSubcommand(s => s.setName('view').setDescription(`Browse logged events from the last ${LOG_RETENTION_DAYS} days`)
        .addStringOption(o => o.setName('category').setDescription('Only this category').addChoices(...choices))
        .addUserOption(o => o.setName('user').setDescription('Only events done by or to this user'))
        .addIntegerOption(o => o.setName('page').setDescription('Page number').setMinValue(1))), { category: 'security', access: 'security', requiredPermissions: [PermissionFlagsBits.ManageGuild] }, async (ctx, i) => {
    const guild = i.guildId, sub = i.options.getSubcommand();
    const settings = ctx.store.settings(guild);
    if (sub === 'view') {
        const category = i.options.getString('category') as LogCategory | null;
        const user = i.options.getUser('user');
        const result = recentEvents(ctx.store, guild, { category, userId: user?.id, page: i.options.getInteger('page') ?? 1 });
        const lines = result.rows.map(r => {
            const by = r.actor_id ? ` by <@${r.actor_id}>` : '';
            const target = r.target ? ` · ${r.target}` : '';
            return `<t:${Math.floor(r.at / 1000)}:R> **${r.action}**${by}${target}`;
        });
        const filters = [category && CATEGORY_LABELS[category].split(' (')[0], user && `user ${user.tag}`].filter(Boolean).join(', ');
        const body = lines.length ? lines.join('\n') : eventLogConfig(ctx.store, guild).enabled ? 'No events match yet.' : 'Event logging is off. Turn it on with `/setup logs enable`.';
        const view = embed(`Event log${filters ? ` · ${filters}` : ''}`, body, Colors.Blurple).setFooter({ text: `Page ${result.page} of ${result.pages} · ${result.total} event(s) · kept for ${LOG_RETENTION_DAYS} days` });
        await i.editReply({ embeds: [view], allowedMentions: { parse: [] } });
        return;
    }
    if (sub === 'setup' || sub === 'check') {
        await i.editReply({ embeds: [embed(sub === 'setup' ? 'Setting up log channels…' : 'Checking log channels…', 'Checking channels and permissions, then sending a test embed.', Colors.Blurple)] }).catch(() => undefined);
        const lines: string[] = [];
        let bansId: string | null, loggingId: string | null;
        if (sub === 'setup') {
            let result;
            try {
                result = await setupLogChannels(ctx.store, i.guild, i.user.id, { bans: i.options.getChannel('bans_channel') as any, logging: i.options.getChannel('logging_channel') as any });
            } catch (error) {
                throw new AppError('VALIDATION_ERROR', `Setup could not finish: ${error instanceof Error ? error.message : String(error)} Vanguard needs Manage Channels to create log channels.`);
            }
            bansId = result.bans.channel.id; loggingId = result.logging.channel.id;
            lines.push(`**Ban logs:** <#${bansId}> · ${result.bans.how}`, `**Server logs:** <#${loggingId}> · ${result.logging.how}`);
            if (result.previousAlerts) lines.push(`Bot actions (anti-nuke, backups, restores, configuration changes, errors) now go to <#${loggingId}> instead of <#${result.previousAlerts}>.`);
        } else {
            bansId = logChannels(ctx.store, guild).bansChannelId; loggingId = eventLogConfig(ctx.store, guild).channelId;
            if (!bansId || !loggingId) throw new AppError('VALIDATION_ERROR', 'Log channels are not set up yet. Run `/setup logs setup` first.');
        }
        const bans = await checkChannel(i.guild, bansId!, 'ban logs'), logging = await checkChannel(i.guild, loggingId!, 'server logs');
        lines.push('', describeCheck('Ban logs', bans), describeCheck('Server logs', logging));
        const gaps = serverPermissionGaps(i.guild);
        lines.push(gaps.length ? `**Server permissions missing:** ${gaps.join('; ')}` : '**Server permissions:** ✅ View Audit Log and Ban Members');
        const ok = bans.ok && logging.ok && !gaps.length;
        await i.editReply({ embeds: [embed(ok ? '✅ Log channels ready' : '⚠️ Log channels need attention', lines.join('\n'), ok ? Colors.Green : Colors.Orange)] });
        return;
    }
    if (sub === 'exclude') {
        const channel = i.options.getChannel('channel', true), excluded = i.options.getBoolean('excluded', true);
        const current = new Set(logChannels(ctx.store, guild).excludedChannels);
        excluded ? current.add(channel.id) : current.delete(channel.id);
        setLogChannels(ctx.store, guild, { excludedChannels: [...current] }, i.user.id);
        return excluded ? `Events from <#${channel.id}> are **no longer logged**. Ban logs and bot actions are unaffected.` : `Events from <#${channel.id}> are **logged again**.`;
    }
    if (sub === 'bot-changes') {
        const ignore = i.options.getBoolean('ignore', true);
        setLogChannels(ctx.store, guild, { ignoreBotRoutine: ignore }, i.user.id);
        return ignore ? 'Routine bot changes (channel renames and topic edits by bots, such as member counters) are **skipped**.' : 'Routine bot changes are **logged**.';
    }
    if (sub === 'status') {
        const config = eventLogConfig(ctx.store, guild);
        const channel = config.channelId ?? settings.logChannelId;
        const extra = logChannels(ctx.store, guild);
        const pending = Number(ctx.store.get('SELECT COUNT(*) AS n FROM outbox WHERE guild_id=? AND attempts>0', guild)?.n ?? 0);
        return [
            `**Ban logs:** ${extra.bansChannelId ? `<#${extra.bansChannelId}>` : 'not set up (`/setup logs setup`)'}`,
            `**Excluded channels:** ${extra.excludedChannels.length ? extra.excludedChannels.map(c => `<#${c}>`).join(', ') : 'none'}`,
            `**Routine bot changes:** ${extra.ignoreBotRoutine ? 'skipped' : 'logged'}`,
            `**Log entries waiting to retry:** ${pending}`,
            `**Event logging:** ${config.enabled ? 'on' : 'off'}`,
            `**Channel:** ${channel ? `<#${channel}>${config.channelId ? '' : ' (security log channel)'}` : 'none set'}`,
            `**Categories:**\n${LOG_CATEGORIES.map(c => `${config.categories.has(c) ? '✅' : '⬜'} ${CATEGORY_LABELS[c]}`).join('\n')}`,
            `**History:** kept for ${LOG_RETENTION_DAYS} days · browse with \`/setup logs view\``,
        ].join('\n');
    }
    if (sub === 'enable') {
        const chosen = i.options.getChannel('channel');
        const channelId = chosen?.id ?? eventLogConfig(ctx.store, guild).channelId ?? settings.logChannelId;
        if (!channelId)
            throw new AppError('VALIDATION_ERROR', 'Pick a channel, or set the security log channel first with `/setup security`.');
        const channel = i.guild.channels.cache.get(channelId);
        const me = i.guild.members.me;
        if (!channel || !me || !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]))
            throw new AppError('PERMISSION_ERROR', `Vanguard needs View Channel, Send Messages and Embed Links in <#${channelId}>.`);
        const config = configureEventLog(ctx.store, guild, { enabled: true, channelId: chosen?.id ?? eventLogConfig(ctx.store, guild).channelId });
        ctx.logs.push(guild, embed('Event logging enabled', `By <@${i.user.id}> · posting to <#${channelId}>`, Colors.Green), [], config.channelId);
        return `Event logging is **on** in <#${channelId}>. Logging ${config.categories.size} of ${LOG_CATEGORIES.length} categories; change them with \`/setup logs category\`.`;
    }
    if (sub === 'disable') {
        configureEventLog(ctx.store, guild, { enabled: false });
        ctx.logs.push(guild, embed('Event logging disabled', `By <@${i.user.id}>. Stored history is kept for ${LOG_RETENTION_DAYS} days.`, Colors.Orange));
        return `Event logging is **off**. Existing history stays viewable with \`/setup logs view\` for ${LOG_RETENTION_DAYS} days.`;
    }
    const name = i.options.getString('name', true) as LogCategory, on = i.options.getBoolean('enabled', true);
    configureEventLog(ctx.store, guild, { category: [name, on] });
    return `${CATEGORY_LABELS[name].split(' (')[0]} events are now **${on ? 'logged' : 'not logged'}**.`;
});
