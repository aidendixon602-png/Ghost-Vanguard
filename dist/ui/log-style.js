import { Colors, EmbedBuilder } from 'discord.js';
import { PRODUCT_NAME, PRODUCT_NAME_UPPER } from '../branding.js';
/**
 * "Signal" log theme. Presentation only: the outbox keeps the original embed, and this is applied
 * when a log is delivered (or refreshed), so queued alerts and live ban records pick it up too.
 * Commands, DMs and control panels keep their own UI.
 */
export const LOG_PALETTE = {
    cyan: 0x67e8f9,
    violet: 0xa78bfa,
    mint: 0x6ee7b7,
    amber: 0xfbbf24,
    coral: 0xfb7185,
    slate: 0x94a3b8,
};
const SCOPE_LABEL = {
    activity: 'ACTIVITY', security: 'SECURITY', moderation: 'MODERATION', members: 'MEMBERS', roles: 'ROLES',
    channels: 'CHANNELS', server: 'SERVER', messages: 'MESSAGES', tickets: 'TICKETS',
};
const SCOPE_MARK = {
    activity: '◈', security: '◆', moderation: '⬡', members: '◉', roles: '◇',
    channels: '▣', server: '⬢', messages: '✦', tickets: '▤',
};
const BRAND_PREFIX = `${PRODUCT_NAME_UPPER} / `;
const LEADING_SYMBOLS = /^(?:[\p{Extended_Pictographic}\u{2600}-\u{27BF}\u{25A0}-\u{25FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}\u{200D}\u{2022}]\s*)+/u;
const cleanTitle = (value) => value.replace(LEADING_SYMBOLS, '').trim() || 'Activity';
const SUCCESS = /unbanned|approved|restored|created|joined|added|enabled|ready|recovered|accepted|unblocked|lifted|undone|success|promotion/i;
const WARNING = /warning|warned|held|observe|watch|quiet|pending|incomplete|failed|could not|error|blocked|rejected|denied|quarantine|lockdown|closing/i;
const DANGER = /deleted|removed|banned|kicked|incident|triggered|bulk-deleted|demotion|emergency/i;
/** Pick a stable scope from the event title so older outbox rows get the same theme. */
export function logScopeFor(title) {
    if (/anti-nuke|incident|blocked|quarantine|raid|scam|whitelist|protection|settings lock|powerful bot|bot (approved|rejected|held)|webhook|alt account|threat|emergency|lockdown|automod|ai moderation|support|bot error|permission/i.test(title))
        return 'security';
    if (/ticket|appeal|transcript|rating/i.test(title))
        return 'tickets';
    if (/message/i.test(title))
        return 'messages';
    if (/channel|thread|voice|category|overwrite/i.test(title))
        return 'channels';
    if (/\brole|promotion|demotion|staff|rank/i.test(title))
        return 'roles';
    if (/\bcase\b|\bban|kick|timeout|warn|mute|nick|slowmode|unban|reban|softban|genreb|hardban|moderation/i.test(title))
        return 'moderation';
    if (/member (joined|left)|join|leave|account|verification|verify|roblox/i.test(title))
        return 'members';
    if (/server|guild|invite|emoji|sticker|integration|bot added|startup|restart|back online|settings/i.test(title))
        return 'server';
    return 'activity';
}
/** Keep the meaning of custom colours (ban records, priority cards) inside the Signal palette. */
function toneFromColor(color) {
    const r = (color >> 16) & 255, g = (color >> 8) & 255, b = color & 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    if (delta < 24)
        return 'slate';
    const hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    const deg = (hue * 60 + 360) % 360;
    if (deg < 20 || deg >= 330)
        return 'coral';
    if (deg < 70)
        return 'amber';
    if (deg < 170)
        return 'mint';
    if (deg < 255)
        return 'cyan';
    return 'violet';
}
export function logToneFor(title, color) {
    switch (color) {
        case Colors.Red:
        case Colors.DarkRed: return 'coral';
        case Colors.Orange:
        case Colors.DarkOrange:
        case Colors.Yellow:
        case Colors.Gold: return 'amber';
        case Colors.Green:
        case Colors.DarkGreen: return 'mint';
        case Colors.Blue:
        case Colors.DarkBlue:
        case Colors.Aqua:
        case Colors.DarkAqua: return 'cyan';
        case Colors.Purple:
        case Colors.Greyple: return 'violet';
        case Colors.Grey:
        case Colors.DarkGrey:
        case Colors.LightGrey:
        case Colors.DarkButNotBlack:
        case Colors.NotQuiteBlack: return 'slate';
        case Colors.Blurple: return logScopeFor(title) === 'security' ? 'violet' : 'cyan';
        default: if (color !== undefined)
            return toneFromColor(color);
    }
    if (SUCCESS.test(title))
        return 'mint';
    if (WARNING.test(title))
        return 'amber';
    if (DANGER.test(title))
        return 'coral';
    return logScopeFor(title) === 'roles' ? 'violet' : 'cyan';
}
/** Idempotent: a card already wearing the Signal header is left alone. */
export function styleLogEmbed(input, scope) {
    const source = input instanceof EmbedBuilder ? input.toJSON() : input;
    if (source.author?.name?.startsWith(BRAND_PREFIX))
        return source;
    const e = EmbedBuilder.from(source);
    const title = cleanTitle(source.title ?? source.author?.name ?? 'Activity');
    const family = scope ?? logScopeFor(title);
    e.setColor(LOG_PALETTE[logToneFor(title, source.color)]);
    e.setTitle(`${SCOPE_MARK[family]} ${title}`.slice(0, 256));
    e.setAuthor({ name: `${BRAND_PREFIX}${SCOPE_LABEL[family]}`.slice(0, 256) });
    // A record's avatar (ban log, full event card) stays visible without competing with the brand header.
    if (source.author?.icon_url && !source.thumbnail?.url)
        e.setThumbnail(source.author.icon_url);
    const footer = source.footer?.text?.trim();
    e.setFooter({
        text: (footer ? footer.includes(PRODUCT_NAME) ? footer : `${PRODUCT_NAME} · ${footer}` : PRODUCT_NAME).slice(0, 2048),
        iconURL: source.footer?.icon_url,
    });
    if (!source.timestamp)
        e.setTimestamp();
    return e.toJSON();
}
