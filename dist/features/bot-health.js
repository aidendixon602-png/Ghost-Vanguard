import { AttachmentBuilder, Colors } from 'discord.js';
import { readFile, stat } from 'node:fs/promises';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { config, VERSION } from '../config.js';
import { embed } from '../ui/ui.js';
import { logEvent } from '../errors.js';
import { dmTrusted } from '../bot/trusted-dm.js';
import { formatDuration } from '../audit/downtime.js';
/**
 * Bot health:
 *  - "Back online" DM to the trusted DM list (TRUSTED_DM_IDS, default the bot owner) when the bot starts after being down for 3+ minutes.
 *  - Heartbeat: when HEARTBEAT_URL is set (for example a free healthchecks.io check), the bot pings
 *    it every minute. If the pings stop, that service alerts you, even while the bot is offline.
 *  - Daily database backup sent by DM to the trusted DM list only (DAILY_BACKUP_DM=false turns it off).
 */
// Only TRUSTED_DM_IDS (default: the bot owner) ever receive these, never every Supreme Leader or developer.
const dmLeaders = dmTrusted;
export async function announceComeback(client, offlineSince, now = Date.now()) {
    if (!offlineSince || now - offlineSince < 3 * 60000)
        return;
    await dmLeaders(client, { embeds: [embed('🟢 Ghost Vanguard is back online', `It was offline for about **${formatDuration(now - offlineSince)}** (from <t:${Math.floor(offlineSince / 1000)}:f> to <t:${Math.floor(now / 1000)}:f>).\nVersion ${VERSION}. Anti-nuke checked the audit log for anything that happened while it was down.`, Colors.Green)], allowedMentions: { parse: [] } });
}
export async function heartbeat() {
    if (!config.heartbeatUrl)
        return;
    await fetch(config.heartbeatUrl, { method: 'GET', signal: AbortSignal.timeout(10000) }).catch(error => logEvent('heartbeat_failure', { detail: error instanceof Error ? error.message : String(error) }));
}
const DAILY = 'daily_backup_dm';
const LIMIT = 9.5 * 1024 * 1024;
const gzipAsync = promisify(gzip);
/** Once a day: make a verified backup and DM it (gzipped) to the Supreme Leaders. */
export async function dailyBackupDm(store, client, create, now = Date.now()) {
    if (!config.dailyBackupDm || !client.isReady())
        return;
    const last = Number(store.get('SELECT value FROM runtime_meta WHERE key=?', DAILY)?.value ?? 0);
    if (now - last < 24 * 3600000)
        return;
    store.run('INSERT INTO runtime_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', DAILY, String(now));
    if (!last)
        return; // first run: start the daily clock instead of sending right after an update
    const backup = await create('daily');
    // Do not even try to load a huge file into memory; databases compress ~5x at best.
    if ((await stat(backup.path)).size > 100 * 1024 * 1024) {
        await dmLeaders(client, { embeds: [embed('Daily database backup', 'Today\'s backup is too big for a Discord DM. It is saved on the server in the database-backups folder.', Colors.Orange)] });
        return;
    }
    const zipped = await gzipAsync(await readFile(backup.path));
    const name = `vanguard-${new Date(backup.at).toISOString().slice(0, 10)}.db.gz`;
    if (zipped.length > LIMIT) {
        await dmLeaders(client, { embeds: [embed('Daily database backup', `Today's backup is ${(zipped.length / 1048576).toFixed(1)} MB, too big for a Discord DM. It is saved on the server in the database-backups folder.`, Colors.Orange)] });
        return;
    }
    const sent = await dmLeaders(client, { embeds: [embed('📦 Daily database backup', `Attached: **${name}** (${(zipped.length / 1024).toFixed(0)} KB).\nKeep it private: it contains server settings, cases and verification links. To restore it, unzip it and follow \`npm run database:restore\`.`, Colors.Blurple)], files: [new AttachmentBuilder(zipped, { name })] });
    logEvent('daily_backup_dm', { size: zipped.length, sent });
}
/**
 * Started with an empty database while already in servers: DM every developer and Supreme
 * Leader once, with what to do. Restoring is never automatic here, because the new database
 * may already hold changes people want to keep.
 */
export async function warnEmptyDatabase(client, servers) {
    const text = [
        '⚠️ **Ghost Vanguard started with an empty database** while it is in **' + servers + '** server(s).',
        'If this was not on purpose (a reinstall, a Clone, a wiped `data` folder), every server\'s settings are missing: whitelists, staff ranks, logs, cases and ban records.',
        '',
        '**To get them back:** use a **📦 Daily database backup** this bot DMed you before it happened (a `.db.gz` file: unzip it), the `data` archive you downloaded, or `data/database-backups` if it still exists. Stop the bot, put the file at `data/vanguard.db`, and start it again.',
    ].join('\n');
    await dmTrusted(client, { content: text, allowedMentions: { parse: [] } });
}
