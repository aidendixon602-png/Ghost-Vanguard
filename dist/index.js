import { selfRestart } from './bot/updater-link.js';
import { autoReact } from './features/autoreact.js';
import { reconcileStartupMembers } from './security/startup-members.js';
import { ScamProtection } from './security/scam.js';
import { applyDefaultAntinuke } from './security/locked-antinuke.js';
import { handleRaidJoin, sweepTempbans } from './security/raidmode.js';
import { handleNewAccountJoin } from './security/new-accounts.js';
import { processStaffMention } from './security/antiping.js';
import { rejectRecoveryWait, recoveryApiWait } from './recovery/recovery-api.js';
import { ActivityType, Client, Colors, Events, Partials, GatewayIntentBits, MessageFlags } from 'discord.js';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { cleanLegacyGuildCommands, syncCommands } from './bot/command-sync.js';
import { registerComponents } from './ui/components.js';
import { config, validateConfig, VERSION } from './config.js';
import { presenceLines, ProtectionStats } from './security/protection-stats.js';
import { DatabaseBackups } from './database/database-backups.js';
import { Store } from './database/db.js';
import { endStartupSummary, failure, logEvent } from './errors.js';
import { closingRule, startupSummary, style } from './console-ui.js';
import { Interactions } from './bot/interactions.js';
import { printStartupInvite } from './bot/invite.js';
import { GuildLifecycle } from './bot/lifecycle.js';
import { LogQueue } from './logging.js';
import { Registry } from './bot/registry.js';
import { indexTree, treeJson } from './bot/command-tree.js';
import { Roblox } from './integrations/roblox.js';
import { Security } from './security/security.js';
import { Snapshots } from './recovery/snapshots.js';
import { recordAuditEvent, recordMemberEvent } from './audit/event-log.js';
import { catchUp, lastSeen, markSeen } from './audit/downtime.js';
import { presenceOverride } from './bot/dev-tools.js';
import { clearAutomod, processAutomod } from './features/automod.js';
import { checkAltAccount, historyOnJoin, sendWelcome } from './features/joins.js';
import { logRankChange } from './features/hr.js';
import { runSchedules } from './features/schedules.js';
import { handleAppealDm } from './features/appeals.js';
import { announceComeback, dailyBackupDm, heartbeat } from './features/bot-health.js';
import { aiModerate } from './features/ai-moderation.js';
import { reportWebhook } from './features/webhooks.js';
import { logBulkDelete, logDeletedMessage, logEditedMessage } from './features/message-logs.js';
import { withdrawSharedBan } from './features/roblox-tools.js';
import { forgetHeldBot, lockServerSettings, quarantineNewBot } from './features/antinuke-plus.js';
import { activeBan, assertLocalUnban, enforceOnJoin, enforceOnUnban, existingBan, liftNetworkBan, networkDeps, recordId, sweepNetworkBans } from './security/network-ban.js';
import { handleBanLogInteraction, onBanAdd, onBanRemove, registerBanLogRenderer } from './audit/ban-log.js';
import { reportBotError } from './audit/bot-errors.js';
import { recoveryEmbed } from './ui/notice.js';
import { warnEmptyDatabase } from './features/bot-health.js';
const errors = validateConfig();
if (errors.length) {
    console.error(`\n${style.red('✖ Midtown Vanguard cannot start.')} Fix these settings in .env:\n${errors.map(e => `  • ${e}`).join('\n')}\n`);
    process.exit(1);
}
const healthUrl = `http://${config.host}:${config.port}/healthz`;
const store = new Store(config.dbPath);
const owner = randomUUID();
if (!store.acquireLease('bot', owner)) {
    console.error('Another Vanguard process is using this database. Stop it first or wait 30 seconds after a crash.');
    store.close();
    process.exit(1);
}
// Read before anything updates it: when this database's bot was last running.
const offlineSince = lastSeen(store);
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration, GatewayIntentBits.GuildMessages, ...(config.messageContentEnabled ? [GatewayIntentBits.MessageContent] : [])], partials: [Partials.Message, Partials.GuildMember],
    rest: { rejectOnRateLimit: rejectRecoveryWait },
    allowedMentions: { parse: [], repliedUser: false } });
client.rest.on('rateLimited', recoveryApiWait);
const logs = new LogQueue(store, client), security = new Security(store, logs), roblox = new Roblox(store, logs), snapshots = new Snapshots(store);
const scam = new ScamProtection(store, logs);
snapshots.onAudit = (guildId, title, detail) => logs.push(guildId, recoveryEmbed(title, detail, client.user?.id, Colors.Blurple));
registerBanLogRenderer(store, logs);
const registry = new Registry();
try {
    await registry.load();
    registerComponents(registry);
    indexTree(registry);
    if (store.get('PRAGMA quick_check')?.quick_check !== 'ok')
        throw new Error('Database integrity check failed');
}
catch (error) {
    logEvent('command_load_failure', failure(error));
    try {
        store.run('DELETE FROM leases WHERE name=? AND owner=?', 'bot', owner);
    }
    catch (cleanupError) {
        logEvent('startup_lease_cleanup_failure', failure(cleanupError));
    }
    store.close();
    process.exit(1);
}
const confirmations = new Map();
const lifecycle = new GuildLifecycle(store, client, id => {
    router.clearGuild(id);
    scam.clearGuild(id);
    clearAutomod(id);
    roblox.clearGuild(id);
}, async (guild) => {
    await scam.initialize(guild);
    store.save(store.settings(guild.id));
    // Every authorized server runs the fixed anti-nuke preset unless staff switched it off.
    await applyDefaultAntinuke(store, guild, logs, async (g) => snapshots.numberOf(g.id, await snapshots.save(g, client.user?.id ?? 'system', 'snapshot', 'baseline')));
    // Reconcile only after authorization. No unauthorized guild fetches or role actions.
    await reconcileStartupMembers(store, security, guild);
});
const databaseBackups = new DatabaseBackups(store);
const stats = new ProtectionStats(client, store, id => startupReady && lifecycle.isReady(id));
const router = new Interactions({ stats, databaseBackups, client, store, security, snapshots, roblox, logs, lifecycle, registry, confirmations, ai: { inFlight: 0 } });
let readyAt = 0, startupReady = false, shuttingDown = false;
const timers = [];
logs.canDeliver = id => startupReady && lifecycle.isReady(id);
// Genrebans and hardbans act only once startup has finished and the server is ready.
const network = networkDeps({ client, store, logs, lifecycle }, () => startupReady);
function task(label, promise) {
    void promise.catch(error => logEvent('task_failure', { task: label, ...failure(error) }));
}
function protectedTask(label, guildId, fn) {
    if (startupReady && lifecycle.isReady(guildId))
        task(label, store.withAuthorized(guildId, fn).catch(error => {
            // Also tell the server's staff (without internals or secrets), at most once per task every 10 minutes.
            reportBotError(store, logs, guildId, label, error);
            throw error;
        }));
}
let presenceIndex = 0, lastPresence = 0;
/**
 * Rotate the bot's custom status. The minute timer passes no argument; joins and leaves
 * pass `soon` so the new server count shows quickly. The gaps stay well inside Discord's
 * presence-update limits (the timer check sits below 60s because timers can fire early).
 */
function presence(soon = false) {
    stats.invalidate();
    if (!client.isReady() || Date.now() - lastPresence < (soon ? 15000 : 50000))
        return;
    // A developer-set status (/dev status) replaces the rotation until it expires or is reset.
    const override = presenceOverride(store);
    const lines = override ? [override.text] : presenceLines(stats.get());
    client.user.setPresence({ activities: [{ name: 'Custom Status', type: ActivityType.Custom, state: lines[presenceIndex++ % lines.length] }], status: override?.mode ?? 'online' });
    lastPresence = Date.now();
}
databaseBackups.onFailure = async (message) => {
    // Explicitly requested developer alerts; no credentials or raw database records are sent.
    const targets = new Set([config.ownerId, ...config.developers]);
    for (const id of targets)
        try {
            const user = await client.users.fetch(id);
            await user.send({ content: `Midtown Vanguard: ${message}`, allowedMentions: { parse: [] } });
        }
        catch {
            logEvent('developer_alert_unavailable', { developer: id });
        }
};
async function scheduledLayouts() {
    for (const guild of client.guilds.cache.values()) {
        if (!startupReady || !lifecycle.isReady(guild.id))
            continue;
        const b = store.get('SELECT * FROM backup_config WHERE guild_id=?', guild.id);
        if (!b?.enabled || b.last_at && Date.now() - b.last_at < b.interval_hours * 3600000 || snapshots.locks.busy(guild.id))
            continue;
        await store.withAuthorized(guild.id, async () => {
            await snapshots.locks.run([guild.id], async () => {
                await snapshots.save(guild, client.user.id, 'backup', 'scheduled');
                store.run('UPDATE backup_config SET last_at=? WHERE guild_id=?', Date.now(), guild.id);
                const stale = store.all("SELECT s.id FROM snapshots s JOIN snapshot_metadata m ON m.snapshot_id=s.id WHERE s.guild_id=? AND m.purpose='scheduled' ORDER BY s.id DESC LIMIT -1 OFFSET ?", guild.id, b.retention_count);
                for (const row of stale) {
                    store.run('DELETE FROM snapshots WHERE guild_id=? AND id=?', guild.id, row.id);
                    snapshots.audit(guild.id, client.user.id, 'scheduled_snapshot_expired', row.id, 'Scheduled layout backup retention; manual backups and rollback points retained.');
                }
            });
        });
    }
}
client.once(Events.ClientReady, async (c) => {
    try {
        if (c.user.id !== config.clientId)
            throw new Error('DISCORD_CLIENT_ID does not match the token application');
        for (const guild of client.guilds.cache.values()) {
            await lifecycle.joined(guild);
        }
        for (const row of store.all('SELECT guild_id,name FROM guild_data WHERE active=1'))
            if (!client.guilds.cache.has(row.guild_id))
                store.markGuild(row.guild_id, row.name, false);
        const commandsUpdated = await syncCommands(client.rest, config.clientId, treeJson(registry));
        for (const guild of client.guilds.cache.values())
            if (['AUTHORIZED', 'PENDING_AUTHORIZATION'].includes(store.authorization(guild.id)?.state))
                await cleanLegacyGuildCommands(client.rest, config.clientId, guild.id, store);
        readyAt = Date.now();
        startupReady = true;
        logEvent('ready', { bot: c.user.tag, version: VERSION, commands: registry.commands.size, servers: client.guilds.cache.size, health: healthUrl });
        logEvent('integrations', { rover: config.roverKey ? 'configured' : 'disabled', bloxlink: config.bloxlinkKey ? 'configured' : 'disabled', ai: config.aiEnabled ? 'configured' : 'disabled' });
        if (config.logFormat !== 'json')
            for (const line of startupSummary({ version: VERSION, tag: c.user.tag, servers: client.guilds.cache.size, commands: registry.commands.size, commandsUpdated,
                integrations: { RoVer: !!config.roverKey, Bloxlink: !!config.bloxlinkKey, AI: !!config.aiEnabled }, health: healthUrl }))
                console.log(line);
        printStartupInvite(client.guilds.cache.size);
        if (config.logFormat !== 'json')
            console.log(closingRule());
        endStartupSummary();
        markSeen(store);
        for (const guild of client.guilds.cache.values())
            protectedTask('restart notice', guild.id, () => catchUp(guild, store, logs, id => security.trusted(guild, id), offlineSince));
        presence();
        task('back online notice', announceComeback(client, offlineSince));
        task('heartbeat', heartbeat());
        task('network ban sweep', sweepNetworkBans(network));
        // A brand-new database while the bot is already in servers usually means data was lost
        // (a reinstall, a wiped folder). Tell the developers straight away so they can restore it.
        if (offlineSince === null && client.guilds.cache.size > 0)
            task('empty database warning', warnEmptyDatabase(client, client.guilds.cache.size));
        await databaseBackups.create('startup');
    }
    catch (error) {
        logEvent('startup_failure', failure(error));
        await shutdown(1);
    }
});
client.on(Events.InteractionCreate, i => {
    // Appeal buttons and forms in DMs have no server, so they skip the normal router.
    if (!i.inGuild() && (i.isButton() || i.isModalSubmit()) && i.customId.startsWith('appealdm:'))
        return task('appeal', handleAppealDm(i, store, client));
    // Ban log buttons live on log messages, outside the command menus (which are tidied up automatically).
    if (i.inCachedGuild() && (i.isButton() || i.isModalSubmit()) && i.customId.startsWith('banrec:')) {
        if (!startupReady || !lifecycle.isReady(i.guildId))
            return task('ban log button', i.reply({ content: 'Vanguard is still starting up. Try again in a moment.', flags: MessageFlags.Ephemeral }));
        return task('ban log button', handleBanLogInteraction(i, { store, logs, assertLocalUnban: async (guild, id) => assertLocalUnban(store, guild, id, await existingBan(guild, id)),
            network: {
                active: id => { const ban = activeBan(store, 'hardban', id) ?? activeBan(store, 'genreban', id); return ban ? { kind: ban.kind, record: recordId(ban) } : null; },
                lift: (id, by, reason) => liftNetworkBan(network, id, by, reason),
            } }));
    }
    task('interaction', router.handle(i));
});
client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
    protectedTask('audit', guild.id, () => security.audit(entry, guild));
    protectedTask('event log', guild.id, async () => recordAuditEvent(store, logs, entry, guild));
    protectedTask('webhook guard', guild.id, async () => reportWebhook(store, logs, entry, guild));
    protectedTask('settings lock', guild.id, () => lockServerSettings(store, logs, entry, guild, id => security.trusted(guild, id), (id, rule) => security.trustedFor(guild, id, rule)));
});
client.on(Events.MessageCreate, m => {
    if (m.guild)
        protectedTask('scam scanning', m.guild.id, () => scam.process(m));
    if (m.guild)
        protectedTask('automod', m.guild.id, () => processAutomod(store, logs, m, id => security.trusted(m.guild, id)));
    if (m.guild)
        protectedTask('ai moderation', m.guild.id, () => aiModerate(store, logs, m, id => security.trusted(m.guild, id)));
    if (m.guild)
        protectedTask('staff mentions', m.guild.id, () => processStaffMention({ store, security, logs, client }, m));
    if (m.guild)
        protectedTask('auto reactions', m.guild.id, () => autoReact(store, m));
});
client.on(Events.MessageDelete, m => {
    if (m.guildId)
        protectedTask('message log', m.guildId, async () => logDeletedMessage(store, logs, m));
});
client.on(Events.MessageBulkDelete, messages => {
    const g = messages.first()?.guildId;
    if (g)
        protectedTask('message log', g, async () => logBulkDelete(store, logs, messages));
});
client.on(Events.MessageUpdate, (old, m) => {
    if (m.guildId)
        protectedTask('message log', m.guildId, async () => logEditedMessage(store, logs, old, m));
    if (m.guild)
        protectedTask('edited scam scanning', m.guild.id, () => scam.process(m));
    if (m.guild)
        protectedTask('edited mentions', m.guild.id, () => processStaffMention({ store, security, logs, client }, m));
});
client.on(Events.GuildMemberRemove, member => {
    stats.invalidate();
    protectedTask('event log', member.guild.id, async () => recordMemberEvent(store, logs, member, false));
    if (member.user.bot)
        protectedTask('bot quarantine cleanup', member.guild.id, async () => forgetHeldBot(store, member.guild.id, member.id));
});
client.on(Events.GuildMemberAdd, member => {
    stats.invalidate();
    protectedTask('event log', member.guild.id, async () => recordMemberEvent(store, logs, member, true));
    // Someone with an active genreban or hardban is banned straight away; nothing else runs for them.
    if (activeBan(store, 'hardban', member.id) ?? activeBan(store, 'genreban', member.id)) {
        protectedTask('network ban', member.guild.id, () => enforceOnJoin(network, member.guild, member.id));
        return;
    }
    protectedTask('join flood', member.guild.id, () => security.join(member));
    // Raid mode handles joins while it is on; otherwise the new-account rule checks young accounts.
    protectedTask('new account checks', member.guild.id, async () => {
        const trusted = (id) => security.trusted(member.guild, id);
        if (await handleRaidJoin(store, logs, member, trusted) === 'ignored')
            await handleNewAccountJoin(store, logs, member, trusted);
    });
    protectedTask('rejoin quarantine', member.guild.id, () => security.reconcile(member));
    protectedTask('history on join', member.guild.id, async () => historyOnJoin(store, logs, member));
    protectedTask('alt check', member.guild.id, () => checkAltAccount(store, logs, roblox, member, id => security.trusted(member.guild, id)));
    protectedTask('welcome', member.guild.id, () => sendWelcome(store, member));
    if (member.user.bot)
        protectedTask('bot quarantine', member.guild.id, () => quarantineNewBot(store, logs, member));
    const s = store.settings(member.guild.id);
    if (s.authorized && s.syncOnJoin && !member.user.bot && s.verifiedRoleId)
        protectedTask('join verification', member.guild.id, () => roblox.sync(member));
});
client.on(Events.GuildMemberUpdate, (old, member) => {
    protectedTask('quarantine enforcement', member.guild.id, () => security.reconcile(member));
    protectedTask('rank change log', member.guild.id, () => logRankChange(store, logs, old, member));
});
client.on(Events.GuildBanAdd, ban => {
    if (!startupReady || !lifecycle.isReady(ban.guild.id))
        return;
    roblox.rememberBan(ban.guild.id, ban.user.id);
    // Every ban gets a record in #bans, whoever made it.
    protectedTask('ban log', ban.guild.id, () => onBanAdd(store, logs, ban.guild, ban.user, ban.reason ?? null));
});
client.on(Events.GuildBanRemove, ban => {
    protectedTask('hardban', ban.guild.id, () => enforceOnUnban(network, ban.guild, ban.user.id));
    if (startupReady && lifecycle.isReady(ban.guild.id))
        task('network unban', store.withAuthorized(ban.guild.id, async () => withdrawSharedBan(store, ban.guild.id, ban.user.id)));
    protectedTask('ban log', ban.guild.id, () => onBanRemove(store, logs, ban.guild, ban.user));
});
client.on(Events.GuildCreate, guild => {
    task('guild join', lifecycle.joined(guild, true).then(async () => {
        if (['AUTHORIZED', 'PENDING_AUTHORIZATION'].includes(store.authorization(guild.id)?.state))
            await cleanLegacyGuildCommands(client.rest, config.clientId, guild.id, store);
    }));
    presence(true);
});
client.on(Events.GuildDelete, guild => {
    lifecycle.departed(guild.id);
    presence(true);
});
client.on(Events.Error, error => logEvent('discord_error', failure(error)));
client.on(Events.ShardDisconnect, () => console.warn('[discord] Gateway disconnected. Live protection is unavailable until reconnection.'));
client.on(Events.ShardResume, () => console.log('[discord] Gateway resumed.'));
const server = createServer((req, res) => {
    if (req.url !== '/healthz') {
        res.writeHead(404);
        res.end();
        return;
    }
    const databaseHealth = store.health();
    const healthy = databaseHealth.connected && client.isReady() && startupReady && !shuttingDown;
    res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ service: 'Midtown Vanguard', version: VERSION, ready: healthy, uptimeSeconds: Math.floor(process.uptime()), connectedSince: readyAt || null, guilds: client.guilds.cache.size, database: databaseHealth, protection: stats.get() }));
});
server.on('error', () => {
    console.error('Health server failed to bind. Check HEALTH_HOST/HEALTH_PORT and stop duplicate processes.');
    task('shutdown', shutdown(1));
});
server.listen(config.port, config.host, () => logEvent('health_listening', { url: healthUrl }));
timers.push(setInterval(() => task('logs', logs.flush()), 2000));
timers.push(setInterval(() => task('temporary bans', sweepTempbans(store, logs, client, id => lifecycle.isReady(id))), 60000));
timers.push(setInterval(() => task('verification refresh', roblox.refresh(client, id => lifecycle.isReady(id))), 60000));
timers.push(setInterval(presence, 60000));
timers.push(setInterval(() => {
    try {
        markSeen(store);
    }
    catch { }
}, 60000));
timers.push(setInterval(() => task('member roster refresh', stats.refreshMembers()), 60000));
timers.push(setInterval(() => task('database backups', databaseBackups.scheduled()), 60000));
timers.push(setInterval(() => task('layout backups', scheduledLayouts()), 60000));
timers.push(setInterval(() => { if (startupReady)
    task('schedules', runSchedules({ store, logs, client, ready: id => lifecycle.isReady(id), locks: snapshots.locks })); }, 60000));
timers.push(setInterval(() => task('heartbeat', heartbeat()), 60000));
timers.push(setInterval(() => { if (startupReady)
    task('daily backup DM', dailyBackupDm(store, client, kind => databaseBackups.create(kind))); }, 600000));
timers.push(setInterval(() => task('network ban sweep', sweepNetworkBans(network)), 600000));
timers.push(setInterval(() => task('inactive guild cleanup', databaseBackups.purgeInactive()), 3600000));
timers.push(setInterval(() => {
    for (const guild of client.guilds.cache.values())
        protectedTask('automatic scam readiness', guild.id, () => scam.initialize(guild));
}, 60000));
timers.push(setInterval(() => {
    const health = store.health();
    if (!health.connected)
        logEvent('database_health_failure', { status: health.status });
}, 60000));
timers.push(setInterval(() => {
    try {
        store.cleanup();
    }
    catch {
        console.error('[retention] Database cleanup failed.');
    }
}, 3600000));
timers.push(setInterval(() => {
    try {
        if (!store.acquireLease('bot', owner)) {
            console.error('Database process lease lost. Stopping this instance.');
            task('shutdown', shutdown(1));
        }
    }
    catch {
        console.error('Cannot renew database process lease. Stopping.');
        task('shutdown', shutdown(1));
    }
}, 10000));
async function shutdown(code = 0) {
    if (shuttingDown)
        return;
    shuttingDown = true;
    timers.forEach(clearInterval);
    lifecycle.close();
    client.destroy();
    server.close();
    try {
        if (startupReady)
            markSeen(store);
        store.run('DELETE FROM leases WHERE name=? AND owner=?', 'bot', owner);
    }
    catch { }
    // Awaiting tasks can still finish; process termination prevents use after database close.
    store.close();
    process.exit(code);
}
selfRestart.run = code => task('shutdown', shutdown(code));
process.on('SIGINT', () => task('shutdown', shutdown()));
process.on('SIGTERM', () => task('shutdown', shutdown()));
process.on('uncaughtException', error => {
    logEvent('uncaught_exception', failure(error));
    task('shutdown', shutdown(1));
});
process.on('unhandledRejection', error => {
    logEvent('unhandled_rejection', failure(error));
    task('shutdown', shutdown(1));
});
try {
    await client.login(config.token);
}
catch (error) {
    const code = String(error?.code ?? ''), why = code === 'TokenInvalid' ? 'Discord rejected DISCORD_TOKEN. Reset the token in the Developer Portal (Bot page) and paste the new one into .env.'
        : /disallowed intents/i.test(String(error?.message)) ? 'An intent is switched off. Developer Portal → Bot: turn on Server Members Intent and Message Content Intent.'
            : 'Check your internet connection, VPN or firewall, then try again.';
    console.error(`Discord login failed: ${code || 'error'} — ${String(error?.message ?? error).slice(0, 200)}
${why}`);
    await shutdown(1);
}
