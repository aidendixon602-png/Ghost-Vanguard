import { ActivityType, SlashCommandBuilder } from 'discord.js';
import { config, VERSION } from '../../config.js';
import { defineCommand } from '../../bot/registry.js';
import { confirmDanger } from '../../ui/danger-ui.js';
import { AppError } from '../../errors.js';
import { broadcast, broadcastTargets, clearPresenceOverride, inspectGuild, setPresenceOverride } from '../../bot/dev-tools.js';
import { presenceLines } from '../../security/protection-stats.js';
import { spawnSync } from 'node:child_process';
import { askLauncher, describeUpdate } from '../../bot/updater-link.js';
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
    .addSubcommand(s => s.setName('update').setDescription('Automatic GitHub updates: see the status, or install now (Developer)')
    .addStringOption(o => o.setName('action').setDescription('What to do (default: status)').addChoices({ name: 'Show status', value: 'status' }, { name: 'Check and install now', value: 'now' })))
    .addSubcommand(s => s.setName('sync').setDescription('Force re-register slash commands globally (and instantly in this server)')
    .addStringOption(o => o.setName('guild_id').setDescription('Optional: also push instantly to this server ID (bypasses 1h global cache)').setMinLength(17).setMaxLength(20))), { responseKind: 'info', category: 'developer', developerOnly: true, requiresAuthorization: false }, async (ctx, i) => {
    const sub = i.options.getSubcommand();
    if (sub === 'update') {
        const op = (i.options.getString('action') ?? 'status');
        // Updater: available as /dev update (`,update` alias remains).
        if (op === 'now' && explicitRank(ctx.store, i.guildId, i.user.id, ctx.actor ?? null) < RANKS.developer)
            throw new AppError('PERMISSION_ERROR', `${DEVELOPER_ONLY_MESSAGE}\nYou can still see the update status with \`,update\`.`);
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
        return `Status set to **${text}** (${mode})${override.until ? `, returning to the rotation <t:${Math.floor(override.until / 1000)}:R>` : ' until `,dev status-reset`'}. It survives restarts.`;
    }
    if (sub === 'status-reset') {
        clearPresenceOverride(ctx.store);
        ctx.client.user?.setPresence({ activities: [{ name: 'Custom Status', type: ActivityType.Custom, state: ctx.stats ? presenceLines(ctx.stats.get())[0] : 'Ghost Vanguard' }], status: 'online' });
        return 'Back to the normal rotating status.';
    }
    if (sub === 'sync') {
        const { syncCommands, syncGuildCommands, cleanLegacyGuildCommands } = await import('../../bot/command-sync.js');
        const { treeJson } = await import('../../bot/command-tree.js');
        const desired = treeJson(ctx.registry);
        const guildOverride = i.options.getString('guild_id')?.trim();
        await syncCommands(ctx.client.rest, config.clientId, desired, { force: true });
        let extra = '';
        const targetGuild = guildOverride || i.guildId;
        if (targetGuild && /^\d{17,20}$/.test(targetGuild)) {
            // The one-time legacy cleanup must run (and set its migration flag) BEFORE the instant sync,
            // or it would wipe the commands we register just below — and a later startup would too.
            try {
                await cleanLegacyGuildCommands(ctx.client.rest, config.clientId, targetGuild, ctx.store);
            }
            catch { }
            try {
                await syncGuildCommands(ctx.client.rest, config.clientId, targetGuild, desired);
                extra = `\nGuild instant sync: **${targetGuild}** — commands appear in ~5s (global can take up to 1h).`;
            }
            catch (e) {
                extra = `\nGuild sync failed for ${targetGuild}: ${String(e?.message ?? e).slice(0, 300)}`;
            }
        }
        else {
            try {
                await cleanLegacyGuildCommands(ctx.client.rest, config.clientId, i.guildId, ctx.store);
            }
            catch { }
        }
        return `**Slash commands re-registered**\nGlobal: **${desired.length}** commands — Discord will show them within 1 hour.\nThis server (\`${i.guildId}\`) was also pushed instantly, so try \`/verify\` / \`/dev\` now.${extra}\n\n-# Tip: refresh picker (Ctrl+K → type /dev) or re-invite with https://discord.com/api/oauth2/authorize?client_id=${config.clientId}&scope=applications.commands+bot&permissions=8`;
    }
    return `**Database:** ${ctx.store.get('PRAGMA quick_check')?.quick_check}\n**Connected servers:** ${ctx.client.guilds.cache.size}\n**Loaded commands:** ${ctx.registry.commands.size}\n**Version:** ${VERSION}${codeVersion()}\n**Verification:** Custom (VG- code in Roblox bio) — no Bloxlink/RoVer needed\n**RoVer configured:** ${!!config.roverKey}\n**Bloxlink configured:** ${!!config.bloxlinkKey}\n**AI configured:** ${config.aiEnabled && !!config.openaiKey}\n**Uptime:** ${Math.floor(process.uptime())} seconds`;
});
