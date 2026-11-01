import { confirmDanger } from '../../ui/danger-ui.js';
import { archivePlan, deleteArchive } from '../../audit/archive-cleanup.js';
import { ChannelType, Colors, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { configureEventLog, eventLogConfig, LOG_CATEGORIES, LOG_RETENTION_DAYS, recentEvents, type LogCategory } from '../../audit/event-log.js';
import { embed } from '../../ui/ui.js';
import { applyLogMerge, BANS_CHANNEL, checkChannel, describeCheck, describeMerge, LEGACY_LOG_ROUTES, LOG_CATEGORY, LOGGING_CHANNEL, logChannels, planLogMerge, serverPermissionGaps, setLogChannels, setupLogChannels, type LogRoute } from '../../audit/log-setup.js';

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
    .addSubcommand(s => s.setName('setup').setDescription('Set up active log channels and reuse matching legacy log channels')
        .addChannelOption(o => o.setName('bans_channel').setDescription(`Use this channel for ban logs instead of #${BANS_CHANNEL}`).addChannelTypes(ChannelType.GuildText))
        .addChannelOption(o => o.setName('logging_channel').setDescription(`Use this channel for server logs instead of #${LOGGING_CHANNEL}`).addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(s => s.setName('route').setDescription('Choose a channel for one log type, or reset it to the default')
        .addStringOption(o => o.setName('type').setDescription('Log type').setRequired(true).addChoices(...Object.keys(LEGACY_LOG_ROUTES).map(value => ({ name: value, value }))))
        .addChannelOption(o => o.setName('channel').setDescription('Destination; omit to use the default log channel').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand(s => s.setName('merge').setDescription('Group Vanguard log channels under Ghost Vanguard Logs, leaving other bots’ logs alone'))
    .addSubcommand(s => s.setName('cleanup-archive').setDescription('Preview deletion of channels in the old log archive'))
    .addSubcommand(s => s.setName('check').setDescription('Check configured log channels and bot permissions, then send test embeds'))
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
    if (sub === 'route') {
        const type = i.options.getString('type', true) as LogRoute;
        if (!Object.hasOwn(LEGACY_LOG_ROUTES, type)) throw new AppError('VALIDATION_ERROR', 'Choose a supported log type.');
        const channel = i.options.getChannel('channel');
        if (channel) {
            const check = await checkChannel(i.guild, channel.id, type, false);
            if (!check.ok || check.publiclyVisible) throw new AppError('VALIDATION_ERROR', 'Choose a private text channel where Vanguard can view, send embeds and read history.');
        }
        const routes = { ...logChannels(ctx.store, guild).routes };
        if (channel) routes[type] = channel.id; else delete routes[type];
        setLogChannels(ctx.store, guild, { routes }, i.user.id);
        return `**${type} logs:** ${channel ? `<#${channel.id}>` : 'default log channel'}. Event logging and category switches still apply; check \`/setup logs status\`.`;
    }
    if (sub === 'merge') {
        await i.guild.channels.fetch();
        const plan = planLogMerge(ctx.store, i.guild);
        const leftAlone = plan.untouched.slice(0, 15).map(u => `• <#${u.channelId}> — ${u.why}`);
        if (!plan.categoryId && !plan.moves.length)
            return 'Log channels are not set up here yet. Run `/setup logs setup` first; `/setup logs merge` then tidies up any channel that ends up in the wrong category.';
        if (!plan.moves.length && !plan.renames.length)
            return ['**Every Vanguard log channel is already grouped under Ghost Vanguard Logs.**',
                ...(leftAlone.length || plan.untouched.length > 15 ? ['', '**Left alone:**', ...leftAlone,
                    ...(plan.untouched.length > 15 ? [`• Plus ${plan.untouched.length - 15} more channels.`] : [])] : [])].join('\n');
        const rename = plan.renames[0];
        return confirmDanger(ctx, i, {
            title: 'Merge log channels',
            label: 'Merge channels',
            summary: `Move ${plan.moves.length} Ghost Vanguard log channel(s) into **${LOG_CATEGORY}**${rename ? ` and rename **#${rename.from}** to **#${rename.to}**` : ''}.`,
            consequences: [
                ...plan.moves.slice(0, 15).map(m => `<#${m.channelId}> moves from ${m.from ? `**${m.from}**` : 'no category'} · ${m.why}`),
                ...(plan.moves.length > 15 ? [`Plus ${plan.moves.length - 15} more Vanguard channels.`] : []),
                ...(rename ? [`**#${rename.from}** is the same channel after the rename: same ID, permissions and messages.`] : []),
                ...leftAlone,
                'Channels that are not Vanguard\'s own log destinations are never moved, renamed, reused or deleted.',
                'No message history, permission override or webhook is changed; the channels are only regrouped.',
            ],
            reversal: 'Drag each channel back to its old category; nothing is deleted and the settings keep working either way.',
            working: { title: 'Merging log channels', detail: 'Grouping Vanguard\'s channels under Ghost Vanguard Logs.' },
            run: async (c, b) => describeMerge(await applyLogMerge(c.store, b.guild, b.userId)),
        });
    }
    if (sub === 'cleanup-archive') {
        await i.guild.channels.fetch();
        const plan = archivePlan(i.guild, ctx.store);
        if (!plan.categories.length) return 'No archived Veil log categories were found.';
        return confirmDanger(ctx, i, {
            title: 'Delete archived channels', label: 'Delete archived channels',
            summary: `Delete up to ${plan.channels.length} archived channels and ${plan.categories.length} empty archive categories.`,
            consequences: [
                ...plan.channels.slice(0, 15).map(c => `<#${c.id}>`),
                ...(plan.channels.length > 15 ? [`Plus ${plan.channels.length - 15} more archived channels.`] : []),
                'All channel types in this archive are included, even custom channels with unrelated names.',
                'All messages in deleted channels are permanently lost.',
                'Active log destinations and channels moved out of the archive are skipped.',
            ],
            reversal: 'Discord channel IDs and message history cannot be restored.',
            run: async (fresh, click) => deleteArchive(click.guild, fresh.store, plan, click.user.id),
        });
    }
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
        let skippedRoutes = false;
        let bansId: string | null, loggingId: string | null;
        if (sub === 'setup') {
            let result;
            try {
                result = await setupLogChannels(ctx.store, i.guild, i.user.id, { bans: i.options.getChannel('bans_channel') as any, logging: i.options.getChannel('logging_channel') as any });
            } catch (error) {
                throw new AppError('VALIDATION_ERROR', `Setup could not finish: ${error instanceof Error ? error.message : String(error)} Vanguard needs Manage Channels to create log channels.`);
            }
            bansId = result.bans.channel.id; loggingId = result.logging.channel.id;
            lines.push(`**Category:** ${result.category.name} · active log channels grouped together`, `**Ban logs:** <#${bansId}> · ${result.bans.how}`, `**Server logs:** <#${loggingId}> · ${result.logging.how}`);
            if (Object.keys(result.routes).length) lines.push('**Existing log channels:** reused for matching events; their permissions and message history were preserved.');
            if (result.archivedCategories.length) lines.push('**Other old Veil channels:** kept in the archive; no channels or messages were deleted.');
            for (const { route, check } of result.skipped) {
                skippedRoutes = true;
                lines.push(`**Not activated:** ${describeCheck(`#${LEGACY_LOG_ROUTES[route]}`, check)}`);
            }
            if (result.previousAlerts) lines.push(`Bot actions (anti-nuke, backups, restores, configuration changes, errors) now go to <#${loggingId}> instead of <#${result.previousAlerts}>.`);
        } else {
            bansId = logChannels(ctx.store, guild).bansChannelId; loggingId = eventLogConfig(ctx.store, guild).channelId;
            if (!bansId || !loggingId) throw new AppError('VALIDATION_ERROR', 'Log channels are not set up yet. Run `/setup logs setup` first.');
        }
        const bans = await checkChannel(i.guild, bansId!, 'ban logs'), logging = await checkChannel(i.guild, loggingId!, 'server logs');
        lines.push('', describeCheck('Ban logs', bans), describeCheck('Server logs', logging));
        let routesOk = true;
        for (const [route, id] of Object.entries(logChannels(ctx.store, guild).routes ?? {}) as [LogRoute, string][]) {
            if (!LEGACY_LOG_ROUTES[route]) continue;
            const result = await checkChannel(i.guild, id, route);
            routesOk &&= result.ok && !result.publiclyVisible;
            lines.push(describeCheck(`#${LEGACY_LOG_ROUTES[route]}`, result));
        }
        const gaps = serverPermissionGaps(i.guild);
        lines.push(gaps.length ? `**Server permissions missing:** ${gaps.join('; ')}` : '**Server permissions:** ✅ View Audit Log and Ban Members');
        const events = eventLogConfig(ctx.store, guild);
        const disabled = LOG_CATEGORIES.filter(category => !events.categories.has(category));
        if (!events.enabled) lines.push('**Event logging is off:** use `/setup logs enable` to resume.');
        if (disabled.length) lines.push(`**Disabled event categories:** ${disabled.join(', ')} · enable with \`/setup logs category\`.`);
        const ok = bans.ok && logging.ok && !bans.publiclyVisible && !logging.publiclyVisible && routesOk && !skippedRoutes && events.enabled && !gaps.length;
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
            `**Separate log channels:** ${Object.entries(extra.routes ?? {}).map(([name, id]) => `${name}: <#${id}>`).join(' · ') || 'none'}`,
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
}, { subcommands: { 'cleanup-archive': { access: 'owner', botPermissions: [PermissionFlagsBits.ManageChannels] } } });
