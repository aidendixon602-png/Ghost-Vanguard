import { RateLimitError } from 'discord.js';
import { logEvent } from '../errors.js';
import { MAX_RATE_LIMIT_WAIT_MS } from './limits.js';
// Guilds with a restore in progress, and where to send their progress messages.
const activeRecoveries = new Map();
export async function withRecoveryApi(guildId, progress, fn) {
    activeRecoveries.set(guildId, progress ?? (async () => { }));
    try {
        return await fn();
    }
    finally {
        activeRecoveries.delete(guildId);
    }
}
/** How long Discord told us to wait, in milliseconds. Accepts rate-limit events and surfaced 429 errors. */
export function waitMs(info) {
    const retryAfterSeconds = Number(info?.rawError?.retry_after ?? info?.data?.retry_after ?? info?.retry_after);
    return Math.max(0, Number(info?.retryAfter) || 0, Number(info?.timeToReset) || 0, Number(info?.sublimitTimeout) || 0, Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0);
}
export function isRecoveryLimit(error) {
    return error instanceof RateLimitError || (error?.status ?? error?.httpStatus) === 429;
}
const isGuildRoute = (route) => /^\/guilds\//.test(route);
/**
 * Hook for discord.js `rejectOnRateLimit`. While a restore is running, waits
 * longer than the cap are rejected so the restore can stop and report; every
 * other request is left to discord.js to queue and retry.
 */
export function rejectRecoveryWait(info) {
    return isGuildRoute(info.route)
        && activeRecoveries.has(info.majorParameter)
        && waitMs(info) > MAX_RATE_LIMIT_WAIT_MS;
}
/** Reports a rate-limit wait to the restore that triggered it. */
export function recoveryApiWait(info) {
    const report = activeRecoveries.get(info.majorParameter);
    if (!report || !isGuildRoute(info.route))
        return;
    const ms = waitMs(info);
    const seconds = Math.ceil(ms / 1000);
    const tooLong = ms > MAX_RATE_LIMIT_WAIT_MS;
    logEvent('recovery_api_wait', {
        guildId: info.majorParameter,
        route: info.route,
        method: info.method,
        retryAfterMs: ms,
        result: tooLong ? 'stop_and_report' : 'retry_after_discord_wait',
    });
    const message = tooLong
        ? `Stopping recovery: Discord requires ${seconds}s on ${info.method} ${info.route}.`
        : `Discord API wait: ${seconds}s on ${info.method} ${info.route}; retrying automatically.`;
    void report(message).catch(() => { });
}
