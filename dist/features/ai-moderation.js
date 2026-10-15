import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors } from 'discord.js';
import { config } from '../config.js';
import { clip } from '../core.js';
import { checkTarget, embed } from '../ui/ui.js';
import { defaults } from '../bot/registry.js';
import { AppError, logEvent } from '../errors.js';
import { RANKS, rankOf } from '../bot/ranks.js';
import { staffReason } from '../security/raidmode.js';
import { automodConfig, isStaff } from './automod.js';
import { escalateWarnings } from './warn-points.js';
/**
 * AI moderation, report only. Messages from non-staff are checked with OpenAI's moderation model
 * (free to use with the bot's OPENAI_API_KEY). Nothing is deleted automatically: flagged messages
 * are sent to staff with Delete / Warn / Timeout buttons. Self-harm gets a gentle "check on them"
 * alert instead of punishment buttons.
 */
const LABELS = {
    harassment: 'Harassment', 'harassment/threatening': 'Threats', hate: 'Hate speech', 'hate/threatening': 'Hateful threats',
    sexual: 'Sexual content', 'sexual/minors': 'Sexual content involving minors', violence: 'Violence', 'violence/graphic': 'Graphic violence',
    'self-harm': 'Self-harm', 'self-harm/intent': 'Self-harm (intent)', 'self-harm/instructions': 'Self-harm (instructions)', illicit: 'Illegal activity', 'illicit/violent': 'Violent illegal activity',
};
export const CATEGORY_KEYS = Object.keys(LABELS);
/**
 * Turn an OpenAI moderation result into what staff see. Pure, for tests.
 *   low:    only categories OpenAI flagged AND scored 85%+
 *   normal: what OpenAI flagged
 *   high:   also anything scored 40%+ (borderline)
 * Ignored categories are dropped. "sexual/minors" is never ignored, and is always kept when OpenAI flags it.
 */
export function readVerdict(result, sensitivity = 'normal', ignore = []) {
    const scores = result?.category_scores ?? {}, flagged = result?.categories ?? {};
    let cats = Object.keys({ ...flagged, ...scores }).filter(k => (k === 'sexual/minors' && flagged[k]) ||
        sensitivity === 'high' ? flagged[k] || (scores[k] ?? 0) >= 0.4 : sensitivity === 'low' ? flagged[k] && (scores[k] ?? 0) >= 0.85 : !!flagged[k]);
    cats = cats.filter(c => c === 'sexual/minors' || !ignore.includes(c.split('/')[0]) && !ignore.includes(c));
    const top = Math.max(0, ...cats.map(c => scores[c] ?? 0));
    return { flagged: cats.length > 0, categories: cats, top, selfHarm: cats.length > 0 && cats.every(c => c.startsWith('self-harm')) };
}
const budget = new Map();
const recentAlert = new Map();
/** Text and up to 3 images in one call (OpenAI's omni moderation model reads both). */
export const AI_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export async function checkContent(text, images, sensitivity, ignore, fetchImpl = fetch) {
    const input = images.length ? [...(text ? [{ type: 'text', text: text.slice(0, 2000) }] : []), ...images.slice(0, 3).map(url => ({ type: 'image_url', image_url: { url } }))] : text.slice(0, 2000);
    const response = await fetchImpl('https://api.openai.com/v1/moderations', { method: 'POST', headers: { Authorization: `Bearer ${config.openaiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'omni-moderation-latest', input }), signal: AbortSignal.timeout(15000) }).catch(() => null);
    // An image OpenAI cannot read must not cost the text check: try again with the text alone.
    if (response?.status === 400 && images.length && text.trim())
        return checkContent(text, [], sensitivity, ignore, fetchImpl);
    if (!response?.ok) {
        logEvent('ai_moderation_unavailable', { status: response?.status ?? 'network' });
        return null;
    }
    const data = await response.json().catch(() => null);
    return readVerdict(data?.results?.[0], sensitivity, ignore);
}
export const checkMessage = (text, fetchImpl = fetch) => checkContent(text, [], 'normal', [], fetchImpl);
/** What automatic action a verdict earns under a mode. Pure, for tests. */
export function aiAction(mode, v) {
    if (v.selfHarm || mode === 'report')
        return 'report';
    if (mode === 'strict' && v.top >= 0.9)
        return 'delete+timeout';
    return v.top >= 0.8 ? 'delete' : 'report';
}
export async function aiModerate(store, logs, message, trusted, now = Date.now()) {
    if (!message.inGuild() || message.author.bot || message.webhookId || !config.openaiKey)
        return;
    const c = automodConfig(store, message.guild.id);
    if (!c.ai || c.aiIgnoreChannels.includes(message.channelId) || message.channel.parentId && c.aiIgnoreChannels.includes(message.channel.parentId))
        return;
    const text = (message.content ?? '').trim();
    const images = c.aiImages ? [...message.attachments.values()].filter(a => AI_IMAGE_TYPES.includes((a.contentType ?? '').split(';')[0].trim().toLowerCase()) && (a.size ?? 0) < 20_000_000).map(a => a.url) : [];
    if (text.length < 4 && !images.length)
        return;
    if (await isStaff(store, message, trusted))
        return;
    const key = `${message.guild.id}:${message.author.id}`;
    // One alert per person per 2 minutes. In report mode a repeat needs no check (staff already have an alert);
    // in delete/strict modes every message is still checked so later ones are removed too.
    const alertedRecently = now - (recentAlert.get(key) ?? 0) < 120000;
    if (alertedRecently && c.aiMode === 'report')
        return;
    // At most 120 checks a minute per server, so a raid cannot run up the API.
    const b = budget.get(message.guild.id);
    if (!b || now - b.start > 60000)
        budget.set(message.guild.id, { start: now, used: 1 });
    else if (++b.used > 120)
        return;
    const verdict = await checkContent(text, images, c.aiSensitivity, c.aiIgnoreCategories);
    if (!verdict?.flagged)
        return;
    if (!alertedRecently)
        recentAlert.set(key, now);
    if (recentAlert.size > 5000)
        for (const [k, t] of recentAlert)
            if (now - t > 600000)
                recentAlert.delete(k);
    const action = aiAction(c.aiMode, verdict);
    let result = '';
    if (action !== 'report') {
        const deleted = await message.delete().then(() => true, () => false);
        result = deleted ? '🗑 Message deleted automatically.' : '⚠ Could not delete the message (check Manage Messages).';
        if (action === 'delete+timeout' && message.member?.moderatable) {
            await message.member.timeout(3600000, 'Ghost Vanguard AI moderation (strict mode)').then(() => {
                result += ' ⏱ Timed out for 1 hour.';
                store.recordCase(message.guild.id, message.author.id, message.client.user.id, 'timeout', `AI moderation: ${verdict.categories.map(x => LABELS[x] ?? x).join(', ')}`);
            }, () => { result += ' ⚠ Could not time them out.'; });
        }
    }
    if (alertedRecently) {
        logEvent('ai_moderation_flag', { guildId: message.guild.id, userId: message.author.id, categories: verdict.categories, action, repeat: true });
        return;
    }
    // A little context helps staff tell banter from abuse.
    const context = [...message.channel.messages.cache.values()].filter(m => m.createdTimestamp < message.createdTimestamp && !m.author.bot).sort((x, y) => x.createdTimestamp - y.createdTimestamp).slice(-3)
        .map(m => `**${m.author.username}:** ${clip(m.content || '[attachment]', 120)}`).join('\n');
    const what = verdict.categories.map(x => LABELS[x] ?? x).join(', ');
    const link = `https://discord.com/channels/${message.guild.id}/${message.channelId}/${message.id}`;
    const body = `**Member:** <@${message.author.id}> (${message.author.tag})\n**Channel:** <#${message.channelId}>${action === 'report' ? ` · [jump to message](${link})` : ''}\n**Flagged for:** ${what} (${Math.round(verdict.top * 100)}% sure)${images.length ? ` · ${images.length} image(s) checked` : ''}\n${context ? `**Before it:**\n${context}\n` : ''}**Message:**\n>>> ${clip(text || '[image only]', 700)}`;
    if (verdict.selfHarm) {
        logs.push(message.guild.id, embed('💙 Someone may need support', `${body}\n\nThis looks like it may be about self-harm. Please check on them kindly rather than punishing them.`, Colors.Blue));
    }
    else {
        const buttons = [
            ...(action === 'report' ? [new ButtonBuilder().setCustomId(`aimod:delete:${message.channelId}:${message.id}`).setLabel('Delete message').setStyle(ButtonStyle.Secondary)] : []),
            new ButtonBuilder().setCustomId(`aimod:warn:${message.author.id}`).setLabel('Warn').setStyle(ButtonStyle.Primary),
            ...(action !== 'delete+timeout' ? [new ButtonBuilder().setCustomId(`aimod:timeout:${message.author.id}`).setLabel('Timeout 1h').setStyle(ButtonStyle.Danger)] : []),
            new ButtonBuilder().setCustomId('aimod:ok').setLabel('Not a problem').setStyle(ButtonStyle.Success)
        ];
        logs.push(message.guild.id, embed(`🤖 AI moderation · ${action === 'report' ? 'flagged message' : 'message removed'}`, `${body}${result ? `\n\n${result}` : '\n\n-# Nothing was removed. Pick an action, or press Not a problem if it is a joke.'}`, action === 'report' ? Colors.Orange : Colors.Red), [new ActionRowBuilder().addComponents(...buttons)]);
    }
    logEvent('ai_moderation_flag', { guildId: message.guild.id, userId: message.author.id, categories: verdict.categories, action });
}
export function registerAiModControls(registry) {
    registry.component({ prefix: 'aimod:', kinds: ['button'], metadata: { ...defaults, category: 'moderation', access: 'member', cooldown: 1000 }, execute: async (ctx, i) => {
            if (rankOf(ctx.store, i.guildId, i.user.id, ctx.actor) < RANKS.helper && i.user.id !== i.guild.ownerId)
                throw new AppError('PERMISSION_ERROR', 'Only staff can act on AI moderation alerts.');
            const [, action, a, b] = i.customId.split(':');
            // One decision per alert: the buttons are removed once someone acts.
            const handled = (what) => i.message?.edit({ components: [], embeds: i.message.embeds.length ? [embed(`${i.message.embeds[0].title ?? 'AI moderation'} · handled`, `${i.message.embeds[0].description ?? ''}\n\n**${what} by** <@${i.user.id}>`.slice(0, 3900), Colors.Green)] : [] }).catch(() => { });
            if (action === 'ok') {
                await handled('Marked as not a problem');
                return 'Marked as not a problem.';
            }
            if (action === 'delete') {
                const channel = await i.guild.channels.fetch(a).catch(() => null);
                if (!channel?.isTextBased())
                    return 'That channel is gone.';
                await channel.messages.delete(b).then(() => { }, () => { throw new AppError('VALIDATION_ERROR', 'That message is already gone (or Vanguard cannot delete it).'); });
                ctx.logs.push(i.guildId, embed('AI moderation · message deleted', `By <@${i.user.id}> in <#${a}>`, Colors.Greyple));
                await handled('Message deleted');
                return 'Message deleted.';
            }
            const member = await i.guild.members.fetch(a).catch(() => null);
            if (!member)
                return 'They are no longer in the server.';
            checkTarget(ctx.actor, member, await i.guild.members.fetchMe());
            if (action === 'warn') {
                const n = ctx.store.recordCase(i.guildId, member.id, i.user.id, 'warn', 'Flagged by AI moderation');
                const dm = await member.send({ embeds: [embed(`Warning · ${i.guild.name}`, 'A message you sent broke the server rules. Please keep it respectful.', Colors.Orange)] }).then(() => '', () => ' Their DMs are closed.');
                await handled('Warned');
                const extra = await escalateWarnings(ctx.store, ctx.logs, i.guild, member.id, i.user.id, rankOf(ctx.store, i.guildId, i.user.id, ctx.actor) >= RANKS.moderator);
                ctx.logs.push(i.guildId, embed(`Case #${n} · warn`, `**User:** <@${member.id}>\n**Moderator:** <@${i.user.id}>\n**Reason:** Flagged by AI moderation`, Colors.Orange));
                return `Case #${n}: warned <@${member.id}>.${dm} ${extra}`.trim();
            }
            if (action === 'timeout') {
                if (!member.moderatable)
                    throw new AppError('PERMISSION_ERROR', 'Vanguard cannot time out this member.');
                await member.timeout(3600000, staffReason(i.user.id, 'AI moderation alert'));
                await handled('Timed out (1h)');
                const n = ctx.store.recordCase(i.guildId, member.id, i.user.id, 'timeout', 'Flagged by AI moderation (1 hour)');
                ctx.logs.push(i.guildId, embed(`Case #${n} · timeout`, `**User:** <@${member.id}>\n**Moderator:** <@${i.user.id}>\n**Reason:** Flagged by AI moderation (1 hour)`, Colors.Orange));
                return `Case #${n}: <@${member.id}> timed out for 1 hour.`;
            }
            throw new AppError('VALIDATION_ERROR', 'Unknown action.');
        } });
}
