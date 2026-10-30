import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, EmbedBuilder, type Client, type GuildMember } from 'discord.js';
import { dmSecurityAlert } from '../bot/trusted-dm.js';
import { envGlobalAlertChannel } from '../bot/env-rules.js';
import type { Store } from '../database/db.js';
import type { LogQueue } from '../logging.js';
import type { Rule } from '../core.js';
import { clip } from '../core.js';

/**
 * Global anti-nuke feed: every anti-nuke trigger in any Midtown server is also posted to one channel
 * chosen by a Developer (`/dev alerts`), so the whole network can be watched from one place.
 * Each branded card shows the incident, response status, rollback and the roles held before any
 * strip, with an Open server log button. The same card is used for the global feed and DMs.
 */
const KEY = 'global_antinuke_alert';

export interface GlobalAlertTarget { guildId: string; channelId: string; warnings: boolean; by: string; at: number }

/**
 * Where the global feed goes. GLOBAL_ALERT_CHANNEL_ID in .env wins over `/dev alerts` (pass the client so the
 * channel's server can be found); GLOBAL_ALERT_WARNINGS=true also posts first-time warnings there.
 */
export function globalAlertTarget(store: Store, client?: Pick<Client, 'channels'>): GlobalAlertTarget | null {
    const fixed = envGlobalAlertChannel();
    if (fixed) {
        const guildId = (client?.channels?.cache?.get(fixed) as { guildId?: string } | undefined)?.guildId;
        if (guildId) return { guildId, channelId: fixed, warnings: /^(1|true|yes|on)$/i.test(process.env.GLOBAL_ALERT_WARNINGS?.trim() ?? ''), by: 'env', at: 0 };
    }
    const raw = store.get('SELECT value FROM runtime_meta WHERE key=?', KEY)?.value;
    if (!raw) return null;
    try { const t = JSON.parse(String(raw)); return t?.guildId && t?.channelId ? t : null; } catch { return null; }
}

export function setGlobalAlertTarget(store: Store, target: GlobalAlertTarget | null) {
    if (!target) store.run('DELETE FROM runtime_meta WHERE key=?', KEY);
    else store.run('INSERT INTO runtime_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', KEY, JSON.stringify(target));
}

/** Who the person was right before anti-nuke acted. */
export interface ActorSnapshot { username: string | null; avatarUrl: string | null; bot: boolean | null; roles: string[] }

export function snapshotMember(member: GuildMember | null | undefined): ActorSnapshot {
    if (!member) return { username: null, avatarUrl: null, bot: null, roles: [] };
    const roles = [...(member.roles?.cache?.values() ?? [])]
        .filter(r => r.id !== member.guild?.id)
        .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
        .map(r => r.name);
    let avatarUrl: string | null = null;
    try { avatarUrl = member.displayAvatarURL?.() ?? member.user?.displayAvatarURL?.() ?? null; } catch { }
    return { username: member.user?.username ?? null, avatarUrl, bot: member.user?.bot ?? null, roles };
}

export interface GlobalAlertInfo {
    guild: { id: string; name: string };
    actor: string;
    snapshot: ActorSnapshot;
    rule: Rule;
    /** 'enforce' | 'warn' | 'observe' | 'exempt' (watched but never punished: owner, Developer, whitelisted) */
    mode: string;
    exemptReason?: string;
    incident: number;
    /** Strip/kick/ban could not be applied. */
    failed: boolean;
    reverted?: { completed: number; failed: number; skipped: number } | null;
    /** Whitelisted for other rules, but not this one. */
    whitelistNote?: string | null;
    jumpUrl: string;
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

export function globalAlertCard(info: GlobalAlertInfo) {
    const punishment = cap(info.rule.punishment ?? 'strip');
    const warn = info.mode === 'warn', exempt = info.mode === 'exempt', watch = info.mode !== 'enforce' && !warn && !exempt;
    const status = exempt ? 'Exempt · not punished'
        : warn ? 'Warning issued'
            : watch ? 'Observed only'
                : info.failed ? 'Response incomplete' : 'Enforcement applied';
    const response = exempt ? `No punishment or rollback (${info.exemptReason ?? 'exempt'}).`
        : warn ? `${info.rule.revert ? 'A safe revert was attempted; no roles removed.' : 'Warning only; no roles removed.'} A repeat of the same rule within an hour: **${punishment}**.`
            : watch ? `No action taken in observe mode. Enforcement would use **${punishment}**.`
                : info.failed ? `**${punishment}** failed or is incomplete. Check Vanguard's permissions and role position.`
                    : `**${punishment}** applied.`;
    const rollback = exempt ? 'Not run — this actor is explicitly exempt.'
        : watch ? 'Not run in observe mode.'
            : !info.rule.revert ? 'No automatic rollback is configured for this trigger.'
                : info.reverted ? [
                    `✅ ${info.reverted.completed} completed`,
                    `❌ ${info.reverted.failed} failed`,
                    `⏭️ ${info.reverted.skipped} skipped`,
                ].join(' · ') : 'No rollback details were recorded.';
    const roles = info.snapshot.roles.length ? info.snapshot.roles.join(', ') : 'None recorded';
    const actorName = info.snapshot.username ? clip(info.snapshot.username, 100) : 'Unknown user';
    const e = new EmbedBuilder()
        .setColor(exempt ? Colors.Blurple : warn ? Colors.Yellow : watch ? Colors.Orange : info.failed ? Colors.DarkOrange : Colors.Red)
        .setAuthor({ name: 'Ghost Vanguard • Anti-nuke' })
        .setTitle(warn ? 'Anti-nuke Warning' : exempt ? 'Anti-nuke Alert (not punished)' : 'Anti-nuke Triggered')
        .setDescription([
            `**Incident #${info.incident}** · ${status}`,
            `**${clip(info.guild.name, 200)}**`,
            `${actorName} triggered **${info.rule.title}**.`,
        ].join('\n'))
        .addFields(
            { name: 'Server', value: `**${clip(info.guild.name, 200)}**\n\`${info.guild.id}\``, inline: true },
            { name: 'Actor', value: `${actorName}\n\`${info.actor}\``, inline: true },
            { name: 'Account', value: info.snapshot.bot === null ? 'Unknown' : info.snapshot.bot ? 'Bot' : 'User', inline: true },
            { name: 'Trigger', value: info.rule.title, inline: true },
            { name: 'Threshold', value: `${info.rule.count} in ${info.rule.seconds}s`, inline: true },
            { name: 'Status', value: status, inline: true },
            { name: 'Response', value: clip(response, 1024), inline: false },
            { name: 'Role history', value: clip(`**Highest role:** ${info.snapshot.roles[0] ?? 'None recorded'}\n**Held before response:** ${roles}`, 1024), inline: false },
            { name: 'Rollback', value: clip(rollback, 1024), inline: false },
        );
    if (info.whitelistNote && !exempt) e.addFields({ name: 'Whitelist', value: clip(info.whitelistNote, 1024), inline: false });
    if (/^https:\/\//.test(info.snapshot.avatarUrl ?? '')) e.setThumbnail(info.snapshot.avatarUrl!);
    e.setFooter({ text: `Ghost Vanguard security network • Incident #${info.incident}` }).setTimestamp();
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open server log').setURL(info.jumpUrl));
    return { embed: e, row };
}

/** Queue the card for the global channel (durable: it survives restarts and retries). Warnings only when switched on. */
export function sendGlobalAlert(store: Store, logs: LogQueue, info: GlobalAlertInfo, client?: Pick<Client, 'channels'>): boolean {
    const target = globalAlertTarget(store, client);
    if (!target) return false;
    if (info.mode === 'warn' && !target.warnings) return false;
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
export interface DmSetting { on: boolean; warnings: boolean }
export function dmSetting(store: Store): DmSetting {
    const raw = store.get('SELECT value FROM runtime_meta WHERE key=?', DM_KEY)?.value;
    try { const v = raw ? JSON.parse(String(raw)) : null; return { on: v?.on ?? true, warnings: v?.warnings ?? false }; } catch { return { on: true, warnings: false }; }
}
export function setDmSetting(store: Store, value: DmSetting) {
    store.run('INSERT INTO runtime_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', DM_KEY, JSON.stringify(value));
}

const recentDms = new Map<string, number>();
let windowStart = 0, windowCount = 0;
export const DM_PER_ACTOR_MS = 5 * 60000, DM_WINDOW_MS = 10 * 60000, DM_WINDOW_MAX = 15;
/** Test hook: forget the rate limits. */
export const resetDmLimits = () => { recentDms.clear(); windowStart = 0; windowCount = 0; };

export async function dmGlobalAlert(client: Client | undefined, store: Store, info: GlobalAlertInfo, now = Date.now()): Promise<number> {
    const setting = dmSetting(store);
    if (!setting.on || (info.mode === 'warn' && !setting.warnings)) return 0;
    const key = `${info.guild.id}:${info.actor}`;
    if ((recentDms.get(key) ?? 0) > now) return 0;
    if (now - windowStart > DM_WINDOW_MS) { windowStart = now; windowCount = 0; }
    if (windowCount >= DM_WINDOW_MAX) return 0;
    recentDms.set(key, now + DM_PER_ACTOR_MS); windowCount++;
    if (recentDms.size > 2000) for (const [k, until] of recentDms) if (until <= now) recentDms.delete(k);
    const { embed, row } = globalAlertCard(info);
    return dmSecurityAlert(client, { embeds: [embed], components: [row] });
}
