import { EmbedBuilder } from 'discord.js';
import { PRODUCT_NAME } from '../branding.js';
/**
 * System notices (startup, protection, recovery) as tidy embeds: "**Name:** value" lines become
 * fields, everything else is the description. Same text as before, easier to read.
 */
export function noticeEmbed(title, lines, color, footer = PRODUCT_NAME) {
    const e = new EmbedBuilder().setColor(color).setTitle(title).setTimestamp().setFooter({ text: footer });
    const text = [];
    const fields = [];
    for (const line of lines.filter(Boolean)) {
        const m = /^\*\*(.+?):\*\*\s*([\s\S]+)$/.exec(line);
        if (m && fields.length < 24)
            fields.push({ name: m[1], value: m[2].slice(0, 1024), inline: m[2].length <= 40 });
        else
            text.push(line);
    }
    if (text.length)
        e.setDescription(text.join('\n').slice(0, 3900));
    if (fields.length)
        e.addFields(fields);
    return e;
}
const RECOVERY_TITLE = {
    'snapshot created': '💾 Snapshot saved', 'snapshot deleted': '🗑️ Snapshot deleted', 'snapshot restored': '♻️ Snapshot restored',
    'restore started': '♻️ Restore started', 'restore finished': '✅ Restore finished', 'backup created': '💾 Backup saved', 'backup deleted': '🗑️ Backup deleted',
};
/** Recovery audit lines arrive as "Actor: <id>\n<detail>"; show who did it by name, not a raw ID. */
export function recoveryEmbed(event, detail, botId, color) {
    const [first, ...rest] = detail.split('\n');
    const actor = /^Actor:\s*(\S+)/.exec(first ?? '')?.[1];
    const by = !actor ? null : actor === botId ? 'Ghost Vanguard (automatic)' : /^\d{17,20}$/.test(actor) ? `<@${actor}>` : actor;
    const title = RECOVERY_TITLE[event.toLowerCase()] ?? `💾 ${event.charAt(0).toUpperCase()}${event.slice(1)}`;
    return noticeEmbed(title, [...(actor ? rest : [first ?? '', ...rest]), ...(by ? [`**By:** ${by}`] : [])], color, 'Ghost Vanguard · recovery');
}
