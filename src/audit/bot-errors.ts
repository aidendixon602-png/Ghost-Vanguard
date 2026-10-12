import { Colors } from 'discord.js';
import type { Store } from '../database/db.js';
import type { LogQueue } from '../logging.js';
import { clip } from '../core.js';
import { embed } from '../ui/ui.js';
import { redact } from './redact.js';

/**
 * Background errors (a log that could not be written, a protection task that failed) are posted
 * to the server's logging channel so staff know, with no stack traces and with anything that
 * looks like a credential removed. Each task reports at most once every 10 minutes per server.
 */
export const ERROR_QUIET_MS = 10 * 60000;
const last = new Map<string, number>();

/** Errors that are expected and already explained elsewhere are not reported. */
const IGNORED = /AUTHORIZATION_ERROR|Unknown (Member|Message|User|Ban)|Missing Access|Cross-guild database mutation/i;

export function reportBotError(store: Store, logs: LogQueue, guildId: string, task: string, error: unknown, now = Date.now()): boolean {
    const message = error instanceof Error ? `${(error as any).code ?? ''} ${error.message}`.trim() : String(error);
    if (IGNORED.test(message)) return false;
    const key = `${guildId}:${task}`;
    if ((last.get(key) ?? 0) > now - ERROR_QUIET_MS) return false;
    last.set(key, now);
    try {
        logs.push(guildId, embed(`⚠️ Bot error · ${task}`, `Midtown Vanguard hit an error while running **${task}**.\n**Error:** ${clip(redact(message), 300)}\nIt keeps running; if this repeats, check the bot's permissions and role position with \`/security health\`.`, Colors.DarkOrange));
        return true;
    } catch { return false; }
}
