import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors, EmbedBuilder, type GuildMember } from 'discord.js';
import type { Store } from '../database/db.js';
import type { LogQueue } from '../logging.js';
import type { Rule } from '../core.js';
import { clip } from '../core.js';

/**
 * Global anti-nuke feed: every anti-nuke trigger in any Midtown server is also posted to one channel
 * chosen by a Developer (`/dev alerts`), so the whole network can be watched from one place.
 * Each card shows the server, the person, what they did, the limit, the punishment and the roles
 * they held at that moment (captured before any strip), with a Jump to Server button.
 */
const KEY = 'global_antinuke_alert';

export interface GlobalAlertTarget { guildId: string; channelId: string; warnings: boolean; by: string; at: number }

export function globalAlertTarget(store: Store): GlobalAlertTarget | null {
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
    /** 'enforce' | 'warn' | 'observe' */
    mode: string;
    incident: number;
    /** Strip/kick/ban could not be applied. */
    failed: boolean;
    reverted?: { completed: number; failed: number; skipped: number } | null;
    jumpUrl: string;
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

export function globalAlertCard(info: GlobalAlertInfo) {
    const punishment = cap(info.rule.punishment ?? 'strip');
    const warn = info.mode === 'warn', watch = info.mode !== 'enforce' && !warn;
    const e = new EmbedBuilder()
        .setColor(warn ? Colors.Yellow : watch ? Colors.Orange : info.failed ? Colors.DarkOrange : Colors.Red)
        .setTitle(warn ? 'Anti-nuke Warning' : 'Anti-nuke Triggered')
        .addFields(
            { name: 'Guild', value: `**${clip(info.guild.name, 200)}**\n\`${info.guild.id}\``, inline: true },
            { name: 'User', value: `${info.snapshot.username ? clip(info.snapshot.username, 100) : 'Unknown'}\n(\`${info.actor}\`)`, inline: true },
            { name: 'Bot', value: info.snapshot.bot === null ? 'Unknown' : info.snapshot.bot ? 'Yes' : 'No', inline: true },
            { name: 'Triggered Action', value: info.rule.title, inline: true },
            { name: 'Threshold', value: `${info.rule.count} in ${info.rule.seconds}s`, inline: true },
            { name: 'Punishment', value: warn ? `Warning (next time: ${punishment})` : watch ? `None (watch-only mode; would be ${punishment})` : info.failed ? `${punishment} (failed: check role order)` : punishment, inline: true },
            { name: 'Highest Role', value: clip(info.snapshot.roles[0] ?? 'None', 200), inline: false },
            { name: 'Roles Held', value: clip(info.snapshot.roles.join(', ') || 'None', 1024), inline: false },
        );
    if (info.reverted && info.mode === 'enforce') {
        const { completed, failed, skipped } = info.reverted;
        e.addFields({ name: 'Changes Reverted', value: [`${completed} undone`, failed && `${failed} failed`, skipped && `${skipped} skipped`].filter(Boolean).join(' · '), inline: false });
    }
    if (info.snapshot.username) e.setAuthor({ name: clip(info.snapshot.username, 200), iconURL: /^https:\/\//.test(info.snapshot.avatarUrl ?? '') ? info.snapshot.avatarUrl! : undefined });
    e.setFooter({ text: `Global anti-nuke alert · Incident #${info.incident}` }).setTimestamp();
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Jump to Server').setURL(info.jumpUrl));
    return { embed: e, row };
}

/** Queue the card for the global channel (durable: it survives restarts and retries). Warnings only when switched on. */
export function sendGlobalAlert(store: Store, logs: LogQueue, info: GlobalAlertInfo): boolean {
    const target = globalAlertTarget(store);
    if (!target) return false;
    if (info.mode === 'warn' && !target.warnings) return false;
    const { embed, row } = globalAlertCard(info);
    logs.push(target.guildId, embed, [row], target.channelId);
    return true;
}
