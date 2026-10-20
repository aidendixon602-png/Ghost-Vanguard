import { Colors, PermissionFlagsBits } from 'discord.js';
import { embed } from '../ui/ui.js';
import { rankOf } from '../bot/ranks.js';
import { logEvent } from '../errors.js';
import { getFeature } from './settings.js';
/** Sites that are almost always fine to share; used when switching to allowlist mode for the first time. */
export const SAFE_DOMAINS = ['discord.com', 'discordapp.com', 'discordapp.net', 'roblox.com', 'youtube.com', 'youtu.be', 'tenor.com', 'giphy.com', 'twitter.com', 'x.com', 'twitch.tv', 'google.com'];
export const AUTOMOD_DEFAULTS = { spam: true, mentionLimit: 5, timeoutMinutes: 10, invites: true, allowedServers: {}, alts: true, ai: false, aiMode: 'report', aiSensitivity: 'normal', aiImages: true, aiIgnoreChannels: [], aiIgnoreCategories: [], links: 'off', allowedDomains: [], blockedDomains: [] };
export const automodConfig = (store, guild) => getFeature(store, guild, 'automod', AUTOMOD_DEFAULTS);
const URL_PATTERN = /https?:\/\/([^\s/?#<>|]+)(\S*)/gi;
const INVITE_HOSTS = ['discord.gg', 'dsc.gg'];
/** "https://WWW.Example.com:443/x" → "example.com". */
export const hostOf = (raw) => raw.toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '').replace(/\.$/, '');
/** "example.com" matches example.com and any sub-domain (cdn.example.com). */
export const domainMatches = (host, domain) => host === domain || host.endsWith(`.${domain}`);
/** Clean up what staff type: "https://www.Example.com/page" → "example.com". Null when it is not a domain. */
export function cleanDomain(input) {
    const host = hostOf(input.trim().replace(/^[a-z]+:\/\//i, '').split(/[/?#\s]/)[0] ?? '');
    return /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(host) ? host : null;
}
/** The first link in this text that the link rule does not allow, or null. Invite links are left to the invite blocker. */
export function blockedLink(text, c) {
    if (c.links === 'off')
        return null;
    for (const m of text.matchAll(URL_PATTERN)) {
        const host = hostOf(m[1]);
        if (INVITE_HOSTS.includes(host) || /^(discord|discordapp)\.com$/.test(host) && /^\/invite\//i.test(m[2] ?? ''))
            continue;
        if (c.blockedDomains.some(d => domainMatches(host, d)))
            return host;
        if (c.links === 'allowlist' && !c.allowedDomains.some(d => domainMatches(host, d)))
            return host;
    }
    return null;
}
export const INVITE_PATTERN = /(?:https?:\/\/)?(?:www\.)?(?:discord(?:app)?\.com\/invite|discord\.gg|dsc\.gg)\/([a-z0-9-]{2,32})/gi;
const recent = new Map();
const cooldown = new Map();
const inviteStrikes = new Map();
const inviteGuilds = new Map();
const normalize = (text) => text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300);
let calls = 0;
/** Drop entries that can no longer matter so memory stays flat on busy servers. */
function prune(now) {
    for (const [k, v] of recent)
        if (!v.length || now - v[v.length - 1].at > 60000)
            recent.delete(k);
    for (const [k, until] of cooldown)
        if (until < now)
            cooldown.delete(k);
    for (const [k, v] of inviteStrikes)
        if (!v.some(t => now - t < 600000))
            inviteStrikes.delete(k);
    for (const [k, v] of inviteGuilds)
        if (now - v.at > 3600000)
            inviteGuilds.delete(k);
}
/** What (if anything) is spammy about this message, given the sender's recent messages. Pure, for tests. */
export function spamVerdict(history, message, mentions, limit) {
    if (mentions >= limit)
        return { reason: `pinged ${mentions} people or roles in one message`, delete: [message.id] };
    const burst = history.filter(h => message.at - h.at <= 5000);
    if (burst.length >= 5)
        return { reason: `sent ${burst.length + 1} messages in 5 seconds`, delete: [...burst.map(h => h.id), message.id] };
    if (message.text.length >= 3) {
        const same = history.filter(h => message.at - h.at <= 30000 && h.text === message.text);
        if (same.length >= 3)
            return { reason: `repeated the same message ${same.length + 1} times`, delete: [...same.map(h => h.id), message.id] };
    }
    return null;
}
export async function isStaff(store, message, trusted) {
    const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member)
        return true; // cannot judge: leave it alone
    return member.id === message.guild.ownerId || trusted(member.id) || rankOf(store, message.guild.id, member.id, member) > 0
        || member.permissions.has(PermissionFlagsBits.ManageMessages) || member.permissions.has(PermissionFlagsBits.Administrator);
}
async function punish(store, logs, message, minutes, reason, deleted, title) {
    const member = message.member;
    let result = 'Messages deleted.';
    if (member?.moderatable) {
        await member.timeout(minutes * 60000, `Ghost Vanguard automod: ${reason}`).then(() => { result = `Messages deleted and timed out for ${minutes} minutes.`; }, () => { result = 'Messages deleted; the timeout failed (check Vanguard\'s role position).'; });
        store.recordCase(message.guild.id, message.author.id, message.client.user.id, 'automod timeout', `${title}: ${reason}`);
    }
    else
        result = 'Messages deleted; Vanguard cannot time this member out (role position).';
    logs.push(message.guild.id, embed(`Automod · ${title}`, `**Member:** <@${message.author.id}> (${message.author.tag})\n**Channel:** <#${message.channelId}>\n**What happened:** ${reason}\n**Result:** ${result}${deleted ? ` (${deleted} message${deleted === 1 ? '' : 's'})` : ''}`, Colors.Orange));
    logEvent('automod', { guildId: message.guild.id, userId: message.author.id, title, reason });
}
/** Delete a message, tell the sender briefly, and time them out on the third strike in 10 minutes. */
async function strike(store, logs, message, key, now, minutes, notice, logTitle, logLine) {
    await message.delete().catch(() => { });
    const strikes = [...(inviteStrikes.get(key) ?? []).filter(t => now - t < 600000), now];
    inviteStrikes.set(key, strikes);
    if (message.channel.isSendable())
        await message.channel.send({ content: `<@${message.author.id}>, ${notice}`, allowedMentions: { users: [message.author.id] } })
            .then(m => setTimeout(() => m.delete().catch(() => { }), 8000).unref?.(), () => { });
    if (strikes.length >= 3) {
        inviteStrikes.delete(key);
        await punish(store, logs, message, minutes, `${logLine} (3 strikes in 10 minutes)`, 1, logTitle);
    }
    else
        logs.push(message.guild.id, embed(`Automod · ${logTitle}`, `**Member:** <@${message.author.id}> · <#${message.channelId}>\n${logLine} · strike ${strikes.length}/3`, Colors.Greyple));
}
export async function processAutomod(store, logs, message, trusted, now = Date.now()) {
    if (!message.inGuild() || message.author.bot || message.webhookId || message.system)
        return;
    const config = automodConfig(store, message.guild.id);
    if (!config.spam && !config.invites && config.links === 'off')
        return;
    const key = `${message.guild.id}:${message.author.id}`;
    if ((cooldown.get(key) ?? 0) > now) {
        await message.delete().catch(() => { });
        return;
    }
    const text = message.content ?? '';
    const invites = config.invites ? [...text.matchAll(INVITE_PATTERN)].map(m => m[1]) : [];
    const badLink = blockedLink(text, config);
    // The person being replied to is pinged automatically; that is not spam.
    const replied = message.mentions.repliedUser?.id;
    const mentionCount = new Set([...message.mentions.users.keys()].filter(id => id !== message.author.id && id !== replied)).size + message.mentions.roles.size;
    const seen = { at: now, text: normalize(text), id: message.id, channel: message.channelId };
    const history = (recent.get(key) ?? []).filter(h => now - h.at <= 30000);
    recent.set(key, [...history, seen].slice(-12));
    if (++calls % 500 === 0)
        prune(now);
    const verdict = config.spam ? spamVerdict(history, seen, mentionCount, config.mentionLimit) : null;
    if (!verdict && !invites.length && !badLink)
        return;
    if (await isStaff(store, message, trusted))
        return;
    if (verdict) {
        cooldown.set(key, now + 10000);
        recent.delete(key);
        let deleted = 0;
        for (const h of [...history, seen].filter(h => verdict.delete.includes(h.id))) {
            const channel = message.guild.channels.cache.get(h.channel);
            if (channel?.isTextBased())
                await channel.messages.delete(h.id).then(() => deleted++, () => { });
        }
        await punish(store, logs, message, config.timeoutMinutes, verdict.reason, deleted, 'spam');
        return;
    }
    // Invites: allow ones to this server and to whitelisted partner servers.
    for (const code of invites) {
        let target = inviteGuilds.get(code);
        if (!target || now - target.at > 3600000) {
            let unknown = false;
            const invite = await message.client.fetchInvite(code).catch((e) => { unknown = e?.code === 10008; return null; });
            // A network error or rate limit is not proof: leave the message alone rather than punish a maybe-valid invite.
            if (!invite && !unknown)
                continue;
            target = { guild: invite?.guild?.id ?? null, at: now };
            inviteGuilds.set(code, target);
        }
        if (target.guild === message.guild.id || target.guild && config.allowedServers[target.guild])
            continue;
        await strike(store, logs, message, key, now, config.timeoutMinutes, 'invite links to other servers aren\'t allowed here.', 'invite link removed', `**Invite:** \`${code}\` (${target.guild ? `server ${target.guild}` : 'expired or invalid'})`);
        return;
    }
    if (badLink)
        await strike(store, logs, message, key, now, config.timeoutMinutes, 'that link isn\'t allowed here.', 'link removed', `**Link:** \`${badLink}\` (${config.blockedDomains.some(d => domainMatches(badLink, d)) ? 'blocked site' : 'not on the allowed list'})`);
}
export function clearAutomod(guild) {
    for (const map of [recent, cooldown, inviteStrikes])
        for (const k of map.keys())
            if (k.startsWith(`${guild}:`))
                map.delete(k);
}
