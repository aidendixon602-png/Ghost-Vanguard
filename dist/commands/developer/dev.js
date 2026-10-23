import { ActivityType, ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { config, VERSION } from '../../config.js';
import { defineCommand } from '../../bot/registry.js';
import { confirmDanger } from '../../ui/danger-ui.js';
import { AppError } from '../../errors.js';
import { broadcast, broadcastTargets, clearPresenceOverride, inspectGuild, setPresenceOverride } from '../../bot/dev-tools.js';
import { presenceLines } from '../../security/protection-stats.js';
import { spawnSync } from 'node:child_process';
import { askLauncher, describeUpdate } from '../../bot/updater-link.js';
import { DEVELOPER_ONLY_MESSAGE, botRank, RANKS } from '../../bot/ranks.js';
import { globalAlertCard, globalAlertTarget, setGlobalAlertTarget } from '../../security/global-alert.js';
import { RULES } from '../../core.js';
/** Which GitHub commit is running, and whether automatic updates are on (no secrets shown). */
function codeVersion() {
    const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
    const sha = commit.status === 0 ? commit.stdout.trim() : '';
    const updates = process.env.UPDATE_REPO && process.env.UPDATE_TOKEN ? `on (${process.env.UPDATE_REPO})` : 'off';
    return `${sha ? ` · commit \`${sha}\`` : ''}\n**Automatic updates:** ${updates}`;
}
export default defineCommand(new SlashCommandBuilder().setName('dev').setDescription('Developer tools: diagnostics, server lookup, announcements and bot status')
    .addSubcommand(s => s.setName('diagnostics').setDescription('Inspect runtime health without secrets'))
    .addSubcommand(s => s.setName('inspect').setDescription('Read-only overview of any server Vanguard knows')
    .addStringOption(o => o.setName('guild_id').setDescription('Server ID').setRequired(true).setMinLength(17).setMaxLength(20)))
    .addSubcommand(s => s.setName('broadcast').setDescription("Post an announcement to every authorized server's log channel")
    .addStringOption(o => o.setName('message').setDescription('Announcement text').setRequired(true).setMaxLength(1500))
    .addStringOption(o => o.setName('title').setDescription('Announcement title (default: Announcement)').setMaxLength(100))
    .addStringOption(o => o.setName('confirm').setDescription('Type SEND to deliver; leave empty to preview')))
    .addSubcommand(s => s.setName('status').setDescription('Show a custom bot status instead of the rotation')
    .addStringOption(o => o.setName('text').setDescription('Status text, e.g. 🔧 Maintenance at 8pm UTC').setRequired(true).setMaxLength(128))
    .addIntegerOption(o => o.setName('minutes').setDescription('Return to the rotation after this many minutes (default: until reset)').setMinValue(1).setMaxValue(10080))
    .addStringOption(o => o.setName('presence').setDescription('Online indicator').addChoices({ name: 'Online', value: 'online' }, { name: 'Idle', value: 'idle' }, { name: 'Do not disturb', value: 'dnd' })))
    .addSubcommand(s => s.setName('status-reset').setDescription('Return to the normal rotating status'))
    .addSubcommand(s => s.setName('alerts').setDescription('Developer: post every anti-nuke trigger from every server to one channel')
    .addChannelOption(o => o.setName('channel').setDescription('Where the global alerts go (leave empty to see the current setup)').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addBooleanOption(o => o.setName('warnings').setDescription('Also post first-time warnings, not just strips (default: no)'))
    .addBooleanOption(o => o.setName('off').setDescription('Stop the global alerts')))
    .addSubcommand(s => s.setName('update').setDescription('Automatic GitHub updates: see the status, or install now (Developer)')
    .addStringOption(o => o.setName('action').setDescription('What to do (default: status)').addChoices({ name: 'Show status', value: 'status' }, { name: 'Check and install now', value: 'now' })))
    .addSubcommand(s => s.setName('sync').setDescription('Re-register commands globally and clear duplicate guild-scoped copies in this server')
    .addStringOption(o => o.setName('guild_id').setDescription('Optional: instant test-sync to this server ID (creates temporary guild+global duplicates there)').setMinLength(17).setMaxLength(20))), { responseKind: 'info', category: 'developer', developerOnly: true, requiresAuthorization: false }, async (ctx, i) => {
    const sub = i.options.getSubcommand();
    if (sub === 'update') {
        const op = (i.options.getString('action') ?? 'status');
        // Anyone with /dev may look; installing a new version is for Developers (`,update` alias remains).
        if (op === 'now' && botRank(ctx.store, i.user.id) < RANKS.developer)
            throw new AppError('PERMISSION_ERROR', `${DEVELOPER_ONLY_MESSAGE}\nYou can still see the update status with \`/dev update\`.`);
        return describeUpdate(await askLauncher(op), op);
    }
    if (sub === 'alerts') {
        const current = globalAlertTarget(ctx.store);
        if (i.options.getBoolean('off')) {
            if (!current)
                return 'Global anti-nuke alerts are already off.';
            setGlobalAlertTarget(ctx.store, null);
            return `Global anti-nuke alerts are **off**. They were going to <#${current.channelId}>. Each server's own security log is unchanged.`;
        }
        const channel = i.options.getChannel('channel');
        const warnings = i.options.getBoolean('warnings');
        if (!channel) {
            if (!current)
                return '**Global anti-nuke alerts are off.** Turn them on with `/dev alerts channel:#channel`: every anti-nuke trigger in every server is then also posted there, with the server, the person, the roles they held and a Jump to Server button.';
            if (warnings !== null) {
                setGlobalAlertTarget(ctx.store, { ...current, warnings, by: i.user.id, at: Date.now() });
                return `Global anti-nuke alerts now ${warnings ? '**include**' : 'leave out'} first-time warnings. Channel: <#${current.channelId}>.`;
            }
            return `**Global anti-nuke alerts are on** in <#${current.channelId}> (\`${current.guildId}\`).\n**Warnings:** ${current.warnings ? 'posted too' : 'strips only'}\n-# Set by <@${current.by}> <t:${Math.floor(current.at / 1000)}:R>. Change with \`/dev alerts channel:\`, stop with \`/dev alerts off:true\`.`;
        }
        const guild = i.guild;
        const real = guild?.channels.cache.get(channel.id);
        if (!guild || !real || !real.isTextBased())
            throw new AppError('VALIDATION_ERROR', 'Pick a text channel in this server.');
        if (!ctx.store.isAuthorized(guild.id))
            throw new AppError('VALIDATION_ERROR', 'This server is not authorized for Midtown Vanguard, so alerts cannot be delivered here. Pick a channel in an authorized server.');
        const me = guild.members.me;
        const perms = me && 'permissionsFor' in real ? real.permissionsFor(me) : null;
        if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]))
            throw new AppError('VALIDATION_ERROR', `Midtown Vanguard needs **View Channel**, **Send Messages** and **Embed Links** in <#${real.id}>.`);
        const target = { guildId: guild.id, channelId: real.id, warnings: warnings ?? current?.warnings ?? false, by: i.user.id, at: Date.now() };
        setGlobalAlertTarget(ctx.store, target);
        const sample = globalAlertCard({ guild: { id: guild.id, name: guild.name }, actor: i.user.id, snapshot: { username: i.user.username, avatarUrl: i.user.displayAvatarURL(), bot: false, roles: ['Example role'] },
            rule: RULES.find(r => r.key === 'timeout'), mode: 'enforce', incident: 0, failed: false, reverted: { completed: 5, failed: 0, skipped: 0 }, jumpUrl: `https://discord.com/channels/${guild.id}` });
        sample.embed.setTitle('Anti-nuke Triggered (test)').setDescription('This is a test. Real alerts from every server will look like this.');
        ctx.logs.push(guild.id, sample.embed, [sample.row], real.id);
        return `**Global anti-nuke alerts are on.** Every anti-nuke trigger in every Midtown server will also be posted in <#${real.id}>${target.warnings ? ', including first-time warnings' : ' (strips only; add `warnings:true` to include first-time warnings)'}. A test alert is on its way there now.\n-# Keep this channel private: it lists people's roles across the network.`;
    }
    if (sub === 'inspect') {
        const id = i.options.getString('guild_id', true);
        if (!/^\d{17,20}$/.test(id))
            throw new AppError('VALIDATION_ERROR', 'That is not a valid server ID.');
        const guild = ctx.client.guilds.cache.get(id);
        return inspectGuild(ctx.store, id, guild?.name ?? null, guild?.memberCount ?? null).join('\n');
    }
    if (sub === 'broadcast') {
        const message = i.options.getString('message', true), title = i.options.getString('title') ?? 'Announcement';
        const ids = [...ctx.client.guilds.cache.keys()];
        if (i.options.getString('confirm') !== 'SEND') {
            const { deliver, noChannel } = broadcastTargets(ctx.store, ids);
            return `**Preview only, nothing was sent.**\n**Title:** 📢 ${title}\n**Message:** ${message}\n\nIt would reach **${deliver.length}** server log channel(s)${noChannel.length ? `; ${noChannel.length} authorized server(s) have no log channel and would be skipped` : ''}. Run again with \`confirm: SEND\` to deliver.`;
        }
        const { deliver, noChannel } = broadcastTargets(ctx.store, ids);
        await confirmDanger(ctx, i, {
            title: 'Send an announcement to every authorized server',
            summary: `**${title}**\n${message}`,
            consequences: [
                `Posts in **${deliver.length}** server log channel(s).`,
                noChannel.length ? `${noChannel.length} authorized server(s) have no log channel and are skipped.` : 'Every authorized server has a log channel.',
                'Server staff see this immediately.',
            ],
            label: `Send to ${deliver.length} server(s)`,
            reversal: 'None. Messages cannot be recalled once queued; they would have to be deleted by hand in each server.',
            run: async (c, b) => {
                const sent = await broadcast(c.store, c.logs, ids, title, message, b.user.id);
                return `Announcement queued for **${sent}** server log channel(s). Delivery follows the normal log queue, usually within a few seconds.`;
            },
        });
        return;
    }
    if (sub === 'status') {
        const text = i.options.getString('text', true), minutes = i.options.getInteger('minutes');
        const mode = (i.options.getString('presence') ?? 'online');
        const override = setPresenceOverride(ctx.store, text, mode, minutes);
        ctx.client.user?.setPresence({ activities: [{ name: 'Custom Status', type: ActivityType.Custom, state: text }], status: mode });
        return `Status set to **${text}** (${mode})${override.until ? `, returning to the rotation <t:${Math.floor(override.until / 1000)}:R>` : ' until `,dev status-reset`'}. It survives restarts.`;
    }
    if (sub === 'status-reset') {
        clearPresenceOverride(ctx.store);
        ctx.client.user?.setPresence({ activities: [{ name: 'Custom Status', type: ActivityType.Custom, state: ctx.stats ? presenceLines(ctx.stats.get())[0] : 'Ghost Vanguard' }], status: 'online' });
        return 'Back to the normal rotating status.';
    }
    if (sub === 'sync') {
        const { syncCommands, syncGuildCommands, cleanLegacyGuildCommands, clearGuildCommands, outdatedGlobalCommands } = await import('../../bot/command-sync.js');
        const { treeJson } = await import('../../bot/command-tree.js');
        const rest = ctx.client.rest;
        const desired = treeJson(ctx.registry);
        const guildOverride = i.options.getString('guild_id')?.trim();
        // Global is the single source of truth. Note the global commands the code no longer defines; the
        // bulk overwrite below deletes them.
        const removed = new Set(await outdatedGlobalCommands(rest, config.clientId, desired).catch(() => []));
        await syncCommands(rest, config.clientId, desired, { force: true });
        let extra = '';
        if (guildOverride && /^\d{17,20}$/.test(guildOverride)) {
            // Opt-in fast-test path: register guild-scoped copies so they appear in ~5s. They live ALONGSIDE
            // the global set, so that guild lists each command twice until cleared — hence the warning.
            try {
                await cleanLegacyGuildCommands(rest, config.clientId, guildOverride, ctx.store);
            }
            catch { }
            try {
                await syncGuildCommands(rest, config.clientId, guildOverride, desired);
                extra = `\n⚡ Instant test sync to **${guildOverride}** (~5s). These are guild-scoped copies, so that server lists each command **twice** (guild + global) until you run \`/dev sync\` there with no guild_id to clear them.`;
            }
            catch (e) {
                extra = `\nGuild sync failed for ${guildOverride}: ${String(e?.message ?? e).slice(0, 300)}`;
            }
        }
        else {
            // Default: this server uses the global set only. Remove any guild-scoped commands (from a legacy
            // version or an earlier instant sync) so each command shows exactly once — this is the duplicate fix.
            try {
                for (const name of await clearGuildCommands(rest, config.clientId, i.guildId))
                    removed.add(name);
            }
            catch { }
            try {
                await cleanLegacyGuildCommands(rest, config.clientId, i.guildId, ctx.store);
            }
            catch { }
        }
        const removedLine = removed.size
            ? `\n🗑️ Removed **${removed.size}** duplicate/outdated command(s): ${[...removed].slice(0, 30).map(n => `\`${n}\``).join(', ')}${removed.size > 30 ? ` …+${removed.size - 30} more` : ''}`
            : '\n✓ No duplicate or outdated commands found.';
        return `**Slash commands re-registered**\nGlobal: **${desired.length}** commands — global changes can take up to 1 hour to appear in Discord.${extra}${removedLine}\n\n-# Guild-scoped duplicates clear in seconds; reopen the command picker (or Ctrl+R) if the extra copies still show.`;
    }
    return `**Database:** ${ctx.store.get('PRAGMA quick_check')?.quick_check}\n**Connected servers:** ${ctx.client.guilds.cache.size}\n**Loaded commands:** ${ctx.registry.commands.size}\n**Version:** ${VERSION}${codeVersion()}\n**Verification:** Custom (VG- code in Roblox bio) — no Bloxlink/RoVer needed\n**RoVer configured:** ${!!config.roverKey}\n**Bloxlink configured:** ${!!config.bloxlinkKey}\n**AI configured:** ${config.aiEnabled && !!config.openaiKey}\n**Uptime:** ${Math.floor(process.uptime())} seconds`;
});
