import { Colors } from 'discord.js';
import { overrideRule, RULES } from '../core.js';
import type { Store } from '../database/db.js';
import { embed } from './ui.js';

export function antinukeStatus(store: Store, guildId: string) {
    const settings = store.settings(guildId);
    const rules = RULES.map(rule => overrideRule(rule, settings.rules, settings.ruleDefaults)).map(rule => {
        const permissions = rule.key === 'dangerous_grant'
            ? ' (administrator, ban_members, kick_members, manage_channels, manage_guild, manage_webhooks)' : '';
        const flags = rule.revert ? ` \`[revert${rule.recipient ? ', user' : ''}]\`` : '';
        return `\`${rule.title}\`${permissions} – **${rule.count} in ${rule.seconds}s → ${rule.key === 'join_flood' ? 'alert' : rule.punishment ?? 'strip'}**${flags}`;
    }).join('\n');
    const grants = store.all("SELECT user_id,kind FROM grants WHERE guild_id=? AND (kind IN ('trust','trust_role') OR kind LIKE 'trust:%' OR kind LIKE 'trust_role:%') AND (expires IS NULL OR expires>?) ORDER BY user_id", guildId, Date.now());
    const full = grants.filter(g => !String(g.kind).includes(':'));
    const partial = new Map<string, string[]>();
    for (const g of grants.filter(g => String(g.kind).includes(':'))) {
        const key = `<@${String(g.kind).startsWith('trust_role') ? '&' : ''}${g.user_id}>`, title = RULES.find(r => r.key === String(g.kind).split(':')[1])?.title ?? '?';
        partial.set(key, [...(partial.get(key) ?? []), title]);
    }
    const fullText = full.slice(0, 25).map(row => `<@${row.kind==='trust_role'?'&':''}${row.user_id}>`).join(' ') + (full.length > 25 ? `\n+${full.length - 25} more · /antinuke whitelist list` : '');
    const partialText = [...partial].slice(0, 15).map(([who, rules]) => `${who} · ${rules.join(', ')} only`).join('\n');
    const whitelist = [fullText && `**All rules:** ${fullText}`, partialText && `**Some rules only:**\n${partialText}`].filter(Boolean).join('\n') || 'No explicit anti-nuke bypasses.';
    const state = !settings.enabled ? 'disabled' : settings.mode === 'observe' ? 'enabled in observe mode' : 'enabled';
    const color = !settings.enabled ? Colors.Red : settings.mode === 'observe' ? Colors.Orange : Colors.Green;
    return embed('Antinuke Status', `Antinuke is currently **${state}**.\n\n**Rules**\n${rules}\n\n**Whitelisted**\n${whitelist}\n\n-# This preset is fixed and applies to every server; only /antinuke enable and /antinuke disable change it. The server owner, developers and Vanguard are automatically protected. Verification-bot exemptions only bypass member-role updates.`, color);
}
