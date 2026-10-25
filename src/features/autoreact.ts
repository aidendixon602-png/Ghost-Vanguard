import type { Message, PartialMessage } from 'discord.js';
import type { Store } from '../database/db.js';

/**
 * Automatic reactions: developers pick members (per server) whose messages the bot reacts to,
 * 🐐 by default. Managed with `/dev autoreact add`, `remove` and `list`.
 */

export const DEFAULT_EMOJI = '🐐';
export const MAX_PER_SERVER = 50;
const CUSTOM = /^<a?:\w{2,32}:\d{17,20}>$/;
const UNICODE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]️?⃣)[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍️]*$/u;

/** A single emoji the bot can react with, or null. Accepts unicode emoji and custom <:name:id>. */
export function parseEmoji(input: string | null | undefined): string | null {
    const text = (input ?? '').trim();
    if (!text) return DEFAULT_EMOJI;
    if (CUSTOM.test(text)) return text;
    return text.length <= 16 && UNICODE.test(text) ? text : null;
}

export function autoReactFor(store: Store, guildId: string, userId: string): string | null {
    return (store.get('SELECT emoji FROM autoreact_users WHERE guild_id=? AND user_id=?', guildId, userId)?.emoji as string | undefined) ?? null;
}

export async function autoReact(store: Store, m: Message | PartialMessage) {
    if (!m.guildId || !m.author || m.system || m.webhookId) return;
    const emoji = autoReactFor(store, m.guildId, m.author.id);
    if (!emoji) return;
    // Missing permission, deleted message or an emoji the bot can no longer use: just skip it.
    await m.react(emoji).catch(() => undefined);
}
