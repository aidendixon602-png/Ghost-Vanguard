import { Colors, EmbedBuilder } from 'discord.js';
import type { Rule } from '../core.js';

export type IncidentInfo = {
    incident: number;
    actor: string;
    rule: Rule;
    mode: string;
    count: number;
    result: string;
    progress: { completed: number; failed: number; skipped: number };
    deleted: { channels: number; roles: number };
    targetId: string | null;
    /** mode 'exempt': why they were not punished. */
    exemptReason?: string;
    /** Whitelisted for other rules, but not this one. */
    whitelistNote?: string | null;
};

const PAST: Record<string, string> = { strip: 'stripped', ban: 'banned', kick: 'kicked' };
const FAILED = /cannot|unavailable|failed|Protected|no longer a member|not contained|incomplete/i;

/** Short anti-nuke alert: who was punished, for what, and what was undone. Full detail sits underneath. */
export function incidentCard(info: IncidentInfo): EmbedBuilder {
    const punishment = info.rule.punishment ?? 'strip';
    const verb = PAST[punishment] ?? punishment;
    const name = punishment[0]!.toUpperCase() + punishment.slice(1);
    let headline: string;
    let color: number = Colors.Red;
    if (info.mode === 'exempt') {
        headline = `<@${info.actor}> triggered anti-nuke. They were **not punished** because they are ${info.exemptReason ?? 'exempt'}, and nothing was undone. Check this was intended.`;
        color = Colors.Blurple;
    } else if (info.mode === 'warn') {
        headline = `<@${info.actor}> got a **warning** from anti-nuke. ${info.rule.revert ? 'What they did was undone. ' : ''}If they do it again within an hour they will be **${verb}**.`;
        color = Colors.Yellow;
    } else if (info.mode !== 'enforce') {
        headline = `<@${info.actor}> triggered anti-nuke. They would have been **${verb}**, but anti-nuke is in watch-only mode.`;
        color = Colors.Orange;
    } else if (FAILED.test(info.result.split(' [')[0]!)) {
        headline = `<@${info.actor}> triggered anti-nuke but could **not** be ${verb}.`;
        color = Colors.DarkOrange;
    } else headline = `<@${info.actor}> was **${verb}** for triggering anti-nuke.`;

    const fields = [
        { name: 'Action', value: info.rule.title, inline: true },
        { name: 'Punishment', value: info.mode === 'exempt' ? `None (${info.exemptReason ?? 'exempt'})` : info.mode === 'warn' ? `Warning (next time: ${name})` : name, inline: true },
        { name: 'Limit', value: `${info.count} in ${info.rule.seconds}s`, inline: true },
    ];
    if (info.rule.revert && info.mode !== 'exempt') {
        const { completed, failed, skipped } = info.progress;
        const parts = [`${completed} undone`, failed && `${failed} failed`, skipped && `${skipped} skipped`].filter(Boolean);
        fields.push({ name: 'Changes reverted', value: parts.join(' · '), inline: true });
    }
    if (info.targetId) fields.push({ name: 'Target', value: `\`${info.targetId}\``, inline: true });
    if (info.deleted.channels || info.deleted.roles)
        fields.push({ name: 'Deleted in the last 10 min', value: `${info.deleted.channels} channel(s), ${info.deleted.roles} role(s). Press **Review restore** to preview putting them back.`, inline: false });
    const detail = info.result.replace(/ Reverts: \d+ completed, \d+ failed, \d+ skipped\.$/, '').replace(/ \[(completed|failed|skipped)\] /g, '\n• ');
    if (info.whitelistNote && info.mode !== 'exempt') fields.push({ name: 'Whitelist', value: info.whitelistNote.slice(0, 1000), inline: false });
    fields.push({ name: 'Details', value: detail.slice(0, 1000) || '—', inline: false });

    return new EmbedBuilder().setColor(color).setTitle(info.mode === 'warn' ? 'Anti-nuke Warning' : info.mode === 'exempt' ? 'Anti-nuke Alert (not punished)' : 'Anti-nuke Triggered').setDescription(headline)
        .addFields(fields).setFooter({ text: `Incident #${info.incident} · User ID: ${info.actor}` }).setTimestamp();
}
