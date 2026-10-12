import { Colors } from 'discord.js';
import { AppError, failure, logEvent } from '../errors.js';
import { embed } from './ui.js';
const code = (error) => typeof error === 'object' && error && 'code' in error ? Number(error.code) : NaN;
const status = (error) => typeof error === 'object' && error && 'status' in error ? Number(error.status) : NaN;
export const MISSING_BAN_PERMISSION = 'Midtown Vanguard is missing the **Ban Members** permission.';
export const BOT_BELOW_TARGET = 'Role hierarchy: Midtown Vanguard’s highest role is not above the user’s highest role. Move the bot’s role higher in Server Settings → Roles.';
/** Turns any error from a ban (or similar) action into a staff-readable outcome. */
export function classify(error, context = 'action') {
    const c = code(error);
    if (c === 50013 || c === 50001)
        return { outcome: 'missing-permissions', reason: `${MISSING_BAN_PERMISSION} Discord refused the request (it also refuses when the bot’s role is below the user’s).` };
    if (c === 10013 || c === 50035)
        return { outcome: 'invalid-target', reason: 'That is not a valid Discord user ID, or the account no longer exists.' };
    if (c === 10026)
        return { outcome: 'invalid-target', reason: 'That user is not banned here.' };
    if (c === 10004)
        return { outcome: 'failed', reason: 'The bot is no longer in that server.' };
    if (status(error) === 429 || c === 429)
        return { outcome: 'rate-limited', reason: 'Discord rate-limited the request. Try again in a minute.' };
    if (error instanceof AppError && error.category !== 'INTERNAL_ERROR' && error.category !== 'DATABASE_ERROR') {
        if (/already (?:has an active|banned)/i.test(error.message))
            return { outcome: 'already', reason: error.message };
        if (/bot role above|role is not above|equal or higher role/i.test(error.message))
            return { outcome: 'hierarchy', reason: /bot role above/i.test(error.message) ? BOT_BELOW_TARGET : `Role hierarchy: ${error.message}` };
        if (/Midtown Vanguard is missing/i.test(error.message))
            return { outcome: 'missing-permissions', reason: error.message };
        if (/user ID|no user|no Discord account|not banned here|could not find/i.test(error.message))
            return { outcome: 'invalid-target', reason: error.message };
        return { outcome: 'not-allowed', reason: error.message };
    }
    const f = failure(error);
    logEvent(`${context}_failure`, { reference: f.reference, category: f.category, details: f.details });
    return { outcome: 'failed', reason: f.category === 'DATABASE_ERROR' ? 'The database could not save the record, so nothing was reported as done.' : 'Something went wrong talking to Discord.', reference: f.reference };
}
/** The in-progress message. */
export function workingEmbed(title, detail) {
    return embed(`⏳ ${title}`, `${detail}\n\n_Working… this message updates when it finishes._`, Colors.Yellow);
}
export const OUTCOME_TITLE = {
    'already': '➖ No change: already done',
    'missing-permissions': '⛔ Failed: missing permissions',
    'hierarchy': '⛔ Failed: role hierarchy',
    'invalid-target': '✕ Failed: invalid user',
    'not-allowed': '⛔ Failed: not allowed',
    'rate-limited': '✕ Failed: rate limited',
    'failed': '✕ Failed',
};
/** The final message for a single-server action. */
export function outcomeEmbed(successTitle, result) {
    if (result.outcome === 'success')
        return embed(`✅ ${successTitle}`, result.reason, Colors.Green);
    const body = `${result.reason}${'reference' in result && result.reference ? `\n\nReference: **${result.reference}**` : ''}`;
    return embed(OUTCOME_TITLE[result.outcome], body, result.outcome === 'already' ? Colors.Grey : Colors.Red);
}
/** Shows the working state on an already-acknowledged interaction. Never throws. */
export async function showWorking(i, title, detail) {
    try {
        await i.editReply({ embeds: [workingEmbed(title, detail)], components: [], allowedMentions: { parse: [] } });
    }
    catch { }
}
/** Marker returned by an action that has already written its own final message. */
export const RENDERED = Symbol('rendered');
/** Writes the final embed and returns the marker. */
export async function finish(i, e) {
    await i.editReply({ embeds: [e], components: [], allowedMentions: { parse: [] } });
    return RENDERED;
}
