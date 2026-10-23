import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, EmbedBuilder } from 'discord.js';
import { dmTrusted } from '../bot/trusted-dm.js';
import { envGlobalAlertChannel } from '../bot/env-rules.js';
import { clip } from '../core.js';
/**
 * Global anti-nuke feed: every anti-nuke trigger in any Midtown server is also posted to one channel
 * chosen by a Developer (`/dev alerts`), so the whole network can be watched from one place.
 * Each card shows the server, the person, what they did, the limit, the punishment and the roles
 * they held at that moment (captured before any strip), with a Jump to Server button.
 */
const KEY = 'global_antinuke_alert';
/**
 * Where the global feed goes. GLOBAL_ALERT_CHANNEL_ID in .env wins over `/dev alerts` (pass the client so the
 * channel's server can be found); GLOBAL_ALERT_WARNINGS=true also posts first-time warnings there.
 */
export function globalAlertTarget(store, client) {
    const fixed = envGlobalAlertChannel();
    if (fixed) {
        const guildId = client?.channels?.cache?.get(fixed)?.guildId;
        if (guildId)
            return { guildId, channelId: fixed, warnings: /^(1|true|yes|on)$/i.test(process.env.GLOBAL_ALERT_WARNINGS?.trim() ?? ''), by: 'env', at: 0 };
    }
    const raw = store.get('SELECT value FROM runtime_meta WHERE key=?', KEY)?.value;
    if (!raw)
        return null;
    try {
        const t = JSON.parse(String(raw));
        return t?.guildId && t?.channelId ? t : null;
    }
    catch {
        return null;
    }
}
export function setGlobalAlertTarget(store, target) {
    if (!target)
        store.run('DELETE FROM runtime_meta WHERE key=?', KEY);
    else
        store.run('INSERT INTO runtime_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', KEY, JSON.stringify(target));
}
export function snapshotMember(member) {
    if (!member)
        return { username: null, avatarUrl: null, bot: null, roles: [] };
    const roles = [...(member.roles?.cache?.values() ?? [])]
        .filter(r => r.id !== member.guild?.id)
        .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
        .map(r => r.name);
    let avatarUrl = null;
    try {
        avatarUrl = member.displayAvatarURL?.() ?? member.user?.displayAvatarURL?.() ?? null;
    }
    catch { }
    return { username: member.user?.username ?? null, avatarUrl, bot: member.user?.bot ?? null, roles };
}
const cap = (s) => s[0].toUpperCase() + s.slice(1);
export function globalAlertCard(info) {
    const punishment = cap(info.rule.punishment ?? 'strip');
    const warn = info.mode === 'warn', exempt = info.mode === 'exempt', watch = info.mode !== 'enforce' && !warn && !exempt;
    const e = new EmbedBuilder()
        .setColor(exempt ? Colors.Blurple : warn ? Colors.Yellow : watch ? Colors.Orange : info.failed ? Colors.DarkOrange : Colors.Red)
        .setTitle(warn ? 'Anti-nuke Warning' : exempt ? 'Anti-nuke Alert (not punished)' : 'Anti-nuke Triggered')
        .addFields({ name: 'Guild', value: `**${clip(info.guild.name, 200)}**\n\`${info.guild.id}\``, inline: true }, { name: 'User', value: `${info.snapshot.username ? clip(info.snapshot.username, 100) : 'Unknown'}\n(\`${info.actor}\`)`, inline: true }, { name: 'Bot', value: info.snapshot.bot === null ? 'Unknown' : info.snapshot.bot ? 'Yes' : 'No', inline: true }, { name: 'Triggered Action', value: info.rule.title, inline: true }, { name: 'Threshold', value: `${info.rule.count} in ${info.rule.seconds}s`, inline: true }, { name: 'Punishment', value: exempt ? `None (${info.exemptReason ?? 'exempt'})` : warn ? `Warning (next time: ${punishment})` : watch ? `None (watch-only mode; would be ${punishment})` : info.failed ? `${punishment} (failed: check role order)` : punishment, inline: true }, { name: 'Highest Role', value: clip(info.snapshot.roles[0] ?? 'None', 200), inline: false }, { name: 'Roles Held', value: clip(info.snapshot.roles.join(', ') || 'None', 1024), inline: false });
    if (info.reverted && info.mode === 'enforce') {
        const { completed, failed, skipped } = info.reverted;
        e.addFields({ name: 'Changes Reverted', value: [`${completed} undone`, failed && `${failed} failed`, skipped && `${skipped} skipped`].filter(Boolean).join(' · '), inline: false });
    }
    if (info.snapshot.username)
        e.setAuthor({ name: clip(info.snapshot.username, 200), iconURL: /^https:\/\//.test(info.snapshot.avatarUrl ?? '') ? info.snapshot.avatarUrl : undefined });
    e.setFooter({ text: `Global anti-nuke alert · Incident #${info.incident}` }).setTimestamp();
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Jump to Server').setURL(info.jumpUrl));
    return { embed: e, row };
}
/** Queue the card for the global channel (durable: it survives restarts and retries). Warnings only when switched on. */
export function sendGlobalAlert(store, logs, info, client) {
    const target = globalAlertTarget(store, client);
    if (!target)
        return false;
    if (info.mode === 'warn' && !target.warnings)
        return false;
    const { embed, row } = globalAlertCard(info);
    logs.push(target.guildId, embed, [row], target.channelId);
    return true;
}
/**
 * The same card, DMed to the trusted people (TRUSTED_DM_IDS, default: the bot owner) for every anti-nuke
 * strip in any server. On by default; `/dev alerts dm:false` turns it off. During a nuke the same person
 * is DMed about at most once every 5 minutes per server, and at most 15 DMs go out per 10 minutes, so a
 * raid can't flood your DMs (the global channel and each server's log still get every alert).
 */
const DM_KEY = 'global_antinuke_dm';
export function dmSetting(store) {
    const raw = store.get('SELECT value FROM runtime_meta WHERE key=?', DM_KEY)?.value;
    try {
        const v = raw ? JSON.parse(String(raw)) : null;
        return { on: v?.on ?? true, warnings: v?.warnings ?? false };
    }
    catch {
        return { on: true, warnings: false };
    }
}
export function setDmSetting(store, value) {
    store.run('INSERT INTO runtime_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', DM_KEY, JSON.stringify(value));
}
const recentDms = new Map();
let windowStart = 0, windowCount = 0;
export const DM_PER_ACTOR_MS = 5 * 60000, DM_WINDOW_MS = 10 * 60000, DM_WINDOW_MAX = 15;
/** Test hook: forget the rate limits. */
export const resetDmLimits = () => { recentDms.clear(); windowStart = 0; windowCount = 0; };
export async function dmGlobalAlert(client, store, info, now = Date.now()) {
    const setting = dmSetting(store);
    if (!setting.on || (info.mode === 'warn' && !setting.warnings))
        return 0;
    const key = `${info.guild.id}:${info.actor}`;
    if ((recentDms.get(key) ?? 0) > now)
        return 0;
    if (now - windowStart > DM_WINDOW_MS) {
        windowStart = now;
        windowCount = 0;
    }
    if (windowCount >= DM_WINDOW_MAX)
        return 0;
    recentDms.set(key, now + DM_PER_ACTOR_MS);
    windowCount++;
    if (recentDms.size > 2000)
        for (const [k, until] of recentDms)
            if (until <= now)
                recentDms.delete(k);
    const { embed, row } = globalAlertCard(info);
    return dmTrusted(client, { embeds: [embed], components: [row] });
}
