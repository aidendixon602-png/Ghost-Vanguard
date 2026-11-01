import { AUTOREACT_IDS, SERVER_AUTOREACT_IDS } from '../bot/access-ids.js';
/**
 * Automatic reactions, built into the bot: developers list members in `src/bot/access-ids.ts`
 * (`AUTOREACT_IDS` for every server, `SERVER_AUTOREACT_IDS` for one server). There is no slash command
 * and no database row, so changing the list needs a rebuild and restart.
 */
export const DEFAULT_EMOJI = '🐐';
const CUSTOM = /^<a?:\w{2,32}:\d{17,20}>$/;
const UNICODE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]️?⃣)[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍️]*$/u;
/** A single emoji the bot can react with, or null. Accepts unicode emoji and custom <:name:id>. */
export function parseEmoji(input) {
    const text = (input ?? '').trim();
    if (!text)
        return DEFAULT_EMOJI;
    if (CUSTOM.test(text))
        return text;
    return text.length <= 16 && UNICODE.test(text) ? text : null;
}
/** The emoji to react with for this member here, or null when they are not on the list. */
export function autoReactFor(guildId, userId) {
    if (!guildId)
        return null;
    const local = SERVER_AUTOREACT_IDS[guildId]?.[userId];
    const global = AUTOREACT_IDS[userId];
    // Not on either list: nothing to do. (A listed member with an empty value gets the default 🐐.)
    if (local === undefined && global === undefined)
        return null;
    return parseEmoji(local ?? global);
}
export async function autoReact(m) {
    if (!m.guildId || !m.author || m.system || m.webhookId)
        return;
    const emoji = autoReactFor(m.guildId, m.author.id);
    if (!emoji)
        return;
    // Missing permission, deleted message or an emoji the bot can no longer use: just skip it.
    await m.react(emoji).catch(() => undefined);
}
