import { config } from '../config.js';
import { askRestart, fallbackRestart } from './updater-link.js';
/** Only an exact ,restart message from a human in a server is treated as this command. */
export function isPrefixRestartMessage(message) {
    return !message.author.bot
        && message.guildId !== null
        && message.content.trim().toLowerCase() === ',restart';
}
/** Prefix commands require an explicit ID in DEVELOPER_IDS; BOT_OWNER_ID is not an implicit exception. */
export function canUsePrefixRestart(userId) {
    return config.developers.has(userId);
}
/**
 * Restart only for IDs explicitly listed in DEVELOPER_IDS. Prefer launch.js IPC; use the
 * existing non-zero-exit fallback only when the launcher does not answer.
 */
export async function requestPrefixRestart(userId, deps = { isDeveloper: canUsePrefixRestart, askRestart, fallbackRestart }) {
    if (!deps.isDeveloper(userId))
        return 'not-authorized';
    const accepted = await deps.askRestart(userId);
    if (accepted === true)
        return 'restarting';
    if (accepted === false)
        return 'busy';
    return deps.fallbackRestart();
}
