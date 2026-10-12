import { Colors, type Message, type PartialMessage, type ReadonlyCollection, type Snowflake } from 'discord.js';
import type { Store } from '../database/db.js';
import type { LogQueue } from '../logging.js';
import { clip } from '../core.js';
import { logsCategory, recordEvent } from '../audit/event-log.js';

/**
 * Deleted and edited messages, with the original text, in the server logging channel ("messages"
 * category of /setup logs). Only messages Vanguard saw while running have their text and author;
 * for older ones those parts are marked unavailable rather than guessed. Bot messages are skipped.
 * Discord does not say who deleted a message here: a moderator's deletion appears separately
 * from the audit log, so "Deleted by" is never filled in by guesswork.
 */
const text = (m: Message | PartialMessage) => m.partial || m.content == null ? null : m.content;
const author = (m: Message | PartialMessage) => m.author ? { name: m.author.tag ?? m.author.username, iconURL: typeof m.author.displayAvatarURL === 'function' ? m.author.displayAvatarURL() : null } : null;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

function attachments(m: Message | PartialMessage): { line: string | null; image: string | null } {
    const list = [...(m.attachments?.values() ?? [])];
    if (!list.length) return { line: null, image: null };
    const kb = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
    const line = list.slice(0, 8).map(a => `[${clip(a.name ?? 'file', 60)}](${a.proxyURL ?? a.url}) (${kb(a.size ?? 0)})`).join('\n');
    // Discord keeps a deleted file only briefly; it is previewed while still available.
    const image = list.find(a => (a.contentType?.startsWith('image/') ?? false) || IMAGE.test(a.name ?? ''));
    return { line: `**Attachments:** ${line}${list.length > 8 ? `\n…and ${list.length - 8} more` : ''}`, image: image ? image.proxyURL ?? image.url : null };
}

export function logDeletedMessage(store: Store, logs: LogQueue, m: Message | PartialMessage) {
    if (!m.guildId || m.author?.bot || m.webhookId || !logsCategory(store, m.guildId, 'messages')) return;
    const body = text(m);
    const files = attachments(m);
    recordEvent(store, logs, m.guildId, { category: 'messages', action: '🗑️ Message Deleted', color: Colors.Red, targetId: m.author?.id ?? null,
        author: author(m), channelId: m.channelId, image: files.image,
        details: [
            `**Author:** ${m.author ? `<@${m.author.id}> (\`${m.author.id}\`)` : 'Unavailable (message sent before Vanguard started)'}`,
            `**Channel:** <#${m.channelId}>`,
            `**Message ID:** \`${m.id}\``,
            `**Content:** ${body === null ? 'Unavailable (message sent before Vanguard started)' : body ? clip(body, 1000) : '*No text*'}`,
            files.line ?? '',
        ].filter(Boolean) });
}

export function logEditedMessage(store: Store, logs: LogQueue, before: Message | PartialMessage, after: Message | PartialMessage) {
    if (!after.guildId || after.author?.bot || after.webhookId || !logsCategory(store, after.guildId, 'messages')) return;
    const old = text(before), now = text(after);
    if (old === null || old === now || now === null) return; // unknown "before", embeds loading or pins also fire "edits"
    recordEvent(store, logs, after.guildId, { category: 'messages', action: '✏️ Message Edited', color: Colors.Yellow, targetId: after.author?.id ?? null,
        author: author(after), channelId: after.channelId,
        details: [
            `**Author:** <@${after.author?.id}> (\`${after.author?.id}\`)`,
            `**Channel:** <#${after.channelId}> · [jump to message](${after.url})`,
            `**Before:** ${clip(old || '*empty*', 1000)}`,
            `**After:** ${clip(now || '*empty*', 1000)}`,
        ] });
}

export function logBulkDelete(store: Store, logs: LogQueue, messages: ReadonlyCollection<Snowflake, Message | PartialMessage>) {
    const first = messages.first();
    if (!first?.guildId || !logsCategory(store, first.guildId, 'messages')) return;
    const known = [...messages.values()].filter(m => text(m) && !m.author?.bot).slice(0, 15).reverse();
    recordEvent(store, logs, first.guildId, { category: 'messages', action: `🧹 ${messages.size} Messages Bulk-Deleted`, color: Colors.Red, channelId: first.channelId,
        details: [`**Channel:** <#${first.channelId}>`, ...known.map(m => `${m.author?.username ?? 'unknown'}: ${clip(text(m)!, 120)}`)] });
}
