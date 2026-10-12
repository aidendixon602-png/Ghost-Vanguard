import 'dotenv/config';
import { resolve } from 'node:path';

export function parseIds(value = ''): Set<string> {
    return new Set(value.split(',').map(v => v.trim()).filter(v => /^\d{17,20}$/.test(v)));
}

export const VERSION = '2.25.2';
export const CONFIG_VERSION = 3;

export const config = {
    token: process.env.DISCORD_TOKEN?.trim() ?? '',
    clientId: process.env.DISCORD_CLIENT_ID?.trim() ?? '',
    developers: parseIds(process.env.DEVELOPER_IDS ?? process.env.MIDTOWN_DEVELOPER_IDS),
    guildRetentionDays: Number(process.env.GUILD_RETENTION_DAYS ?? 90),
    databaseBackupDirectory: resolve(process.env.DATABASE_BACKUP_DIRECTORY || './data/database-backups'),
    databaseBackupMinutes: Number(process.env.DATABASE_BACKUP_INTERVAL_MINUTES ?? 60),
    backupRecent: Number(process.env.DATABASE_BACKUP_KEEP_RECENT ?? 24),
    backupDaily: Number(process.env.DATABASE_BACKUP_KEEP_DAILY ?? 14),
    backupWeekly: Number(process.env.DATABASE_BACKUP_KEEP_WEEKLY ?? 8),
    logFormat: process.env.LOG_FORMAT || 'pretty',
    logLevel: process.env.LOG_LEVEL || 'info',
    ownerId: process.env.BOT_OWNER_ID || '1277709272041394187',
    /** Extra Supreme Leaders besides BOT_OWNER_ID (comma-separated IDs). */
    supremeExtra: parseIds(process.env.SUPREME_LEADER_IDS || '843909457616044092'),
    /** Optional uptime check URL (e.g. https://hc-ping.com/<uuid>); pinged every minute. */
    heartbeatUrl: /^https:\/\//.test(process.env.HEARTBEAT_URL?.trim() ?? '') ? process.env.HEARTBEAT_URL!.trim() : '',
    /** DM a gzipped database backup to the Supreme Leaders once a day. */
    dailyBackupDm: process.env.DAILY_BACKUP_DM !== 'false',
    ownerUsername: process.env.BOT_OWNER_USERNAME || 'web_w2z',
    snapshotActionDelayMs: Number(process.env.SNAPSHOT_ACTION_DELAY_MS || 0),
    dbPath: resolve(process.env.DATABASE_PATH || './data/vanguard.db'),
    host: process.env.HEALTH_HOST || '127.0.0.1',
    port: Number(process.env.HEALTH_PORT || 7475),
    roverKey: process.env.ROVER_API_KEY?.trim() ?? '',
    bloxlinkKey: process.env.BLOXLINK_API_KEY?.trim() ?? '',
    messageContentEnabled: process.env.MESSAGE_CONTENT_ENABLED !== 'false',
    aiEnabled: process.env.AI_ENABLED === 'true',
    openaiKey: process.env.OPENAI_API_KEY?.trim() ?? '',
    openaiModel: process.env.OPENAI_MODEL?.trim() || 'gpt-6-luna',
};

export function validateConfig(): string[] {
    const errors: string[] = [];
    if (!config.token || config.token.includes('YOUR_'))
        errors.push('Set DISCORD_TOKEN in .env.');
    if (!/^\d{17,20}$/.test(config.clientId))
        errors.push('Set DISCORD_CLIENT_ID to the Application ID from the Discord Developer Portal.');
    if (!config.developers.size)
        errors.push('Set DEVELOPER_IDS to your Discord user ID.');
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
        errors.push('HEALTH_PORT must be between 1 and 65535.');
    if (config.aiEnabled && !config.openaiKey)
        errors.push('AI_ENABLED=true requires OPENAI_API_KEY.');
    if (!Number.isInteger(config.snapshotActionDelayMs) || config.snapshotActionDelayMs < 0 || config.snapshotActionDelayMs > 60000)
        errors.push('SNAPSHOT_ACTION_DELAY_MS must be an integer between 0 and 60000.');
    for (const [key, value] of Object.entries({ GUILD_RETENTION_DAYS: config.guildRetentionDays, DATABASE_BACKUP_INTERVAL_MINUTES: config.databaseBackupMinutes, DATABASE_BACKUP_KEEP_RECENT: config.backupRecent, DATABASE_BACKUP_KEEP_DAILY: config.backupDaily, DATABASE_BACKUP_KEEP_WEEKLY: config.backupWeekly }))
        if (!Number.isInteger(value) || value < 1 || value > 10000)
            errors.push(`${key} must be an integer from 1 to 10000.`);
    const rawIds = process.env.DEVELOPER_IDS ?? process.env.MIDTOWN_DEVELOPER_IDS ?? '';
    if (rawIds.split(',').some(id => !/^\d{17,20}$/.test(id.trim())))
        errors.push('Every DEVELOPER_IDS entry must be a valid Discord user ID.');
    return errors;
}
