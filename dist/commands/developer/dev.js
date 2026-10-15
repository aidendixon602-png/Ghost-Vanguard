import { ActivityType, SlashCommandBuilder } from 'discord.js';
import { config, VERSION } from '../../config.js';
import { defineCommand } from '../../bot/registry.js';
import { confirmDanger } from '../../ui/danger-ui.js';
import { AppError } from '../../errors.js';
import { broadcast, broadcastTargets, clearPresenceOverride, inspectGuild, setPresenceOverride } from '../../bot/dev-tools.js';
import { presenceLines } from '../../security/protection-stats.js';
import { spawnSync } from 'node:child_process';
import { askLauncher, askRestart, describeUpdate, fallbackRestart } from '../../bot/updater-link.js';
import { DEVELOPER_ONLY_MESSAGE, explicitRank, RANKS } from '../../bot/ranks.js';
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
    .addSubcommand(s => s.setName('restart').setDescription('Developer: restart the bot (about 10 seconds offline); settings are kept'))
    .addSubcommand(s => s.setName('update').setDescription('Automatic GitHub updates: see the status, or install now (Developer)')
    .addStringOption(o => o.setName('action').setDescription('What to do (default: status)').addChoices({ name: 'Show status', value: 'status' }, { name: 'Check and install now', value: 'now' }))), { responseKind: 'info', category: 'developer', developerOnly: true, requiresAuthorization: false }, async (ctx, i) => {
    const sub = i.options.getSubcommand();
    if (sub === 'restart') {
        await confirmDanger(ctx, i, {
            title: 'Restart Ghost Vanguard',
            summary: `Version **${VERSION}** · ${ctx.client.guilds.cache.size} server(s)`,
            consequences: [
                'The bot goes offline for about 10 seconds in every server, then comes back on its own.',
                'All settings, whitelists, logs and records are kept (they are in the database).',
                'Anything happening during those seconds is caught up from the audit log when it is back.',
            ],
            label: 'Restart now',
            reversal: 'Nothing to undo: it starts again by itself.',
            run: async (_c, b) => {
                const ok = await askRestart(b.user.id);
                if (ok === null) {
                    const fallback = fallbackRestart();
                    if (fallback === 'scheduled')
                        return '🔄 **Restarting.** Ghost Vanguard will be back in about 10 seconds; run `/info ping` to check.\n-# The launcher on the host is an older version, so this used the backup method. Press Restart in the Wispbyte panel once to load the newest launcher.';
                    if (fallback === 'too-soon')
                        throw new AppError('VALIDATION_ERROR', 'The bot started less than 3 minutes ago. Wait a minute and try again (restarting this early could make the launcher undo the latest update).');
                    throw new AppError('VALIDATION_ERROR', 'Restarting from Discord needs the bot to be started with `node launch.js`. Use Restart in the Wispbyte panel instead.');
                }
                if (!ok)
                    throw new AppError('VALIDATION_ERROR', 'An update or restart is already in progress. Try again in a minute.');
                return '🔄 **Restarting.** Ghost Vanguard will be back in about 10 seconds; run `/info ping` to check.';
            },
        });
        return;
    }
    if (sub === 'update') {
        const op = (i.options.getString('action') ?? 'status');
        // Anyone with /dev may look; installing a new version is for Developers.
        if (op === 'now' && explicitRank(ctx.store, i.guildId, i.user.id, ctx.actor ?? null) < RANKS.developer)
            throw new AppError('PERMISSION_ERROR', `${DEVELOPER_ONLY_MESSAGE}\nYou can still see the update status with \`/dev update\`.`);
        return describeUpdate(await askLauncher(op), op);
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
        return `Status set to **${text}** (${mode})${override.until ? `, returning to the rotation <t:${Math.floor(override.until / 1000)}:R>` : ' until `/dev status-reset`'}. It survives restarts.`;
    }
    if (sub === 'status-reset') {
        clearPresenceOverride(ctx.store);
        ctx.client.user?.setPresence({ activities: [{ name: 'Custom Status', type: ActivityType.Custom, state: ctx.stats ? presenceLines(ctx.stats.get())[0] : 'Ghost Vanguard' }], status: 'online' });
        return 'Back to the normal rotating status.';
    }
    return `**Database:** ${ctx.store.get('PRAGMA quick_check')?.quick_check}\n**Connected servers:** ${ctx.client.guilds.cache.size}\n**Loaded commands:** ${ctx.registry.commands.size}\n**Version:** ${VERSION}${codeVersion()}\n**RoVer configured:** ${!!config.roverKey}\n**Bloxlink configured:** ${!!config.bloxlinkKey}\n**AI configured:** ${config.aiEnabled && !!config.openaiKey}\n**Uptime:** ${Math.floor(process.uptime())} seconds`;
});
