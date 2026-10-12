import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors } from 'discord.js';
import { addConfirmation } from './layout-ui.js';
import { embed } from './ui.js';
/** One page of this server's recovery points, newest first, numbered per server. */
export function snapshotPage(ctx, guildId, user, requested = 1, onlyBackups = false) {
    const result = ctx.snapshots.page(guildId, requested, 8, onlyBackups);
    const noun = onlyBackups ? 'backups' : 'recovery points';
    const text = result.rows.map((r, n) => `**#${r.number} · ${r.label}**${result.page === 1 && n === 0 ? ' · newest' : ''}\nSaved <t:${Math.floor(r.at / 1000)}:f> (<t:${Math.floor(r.at / 1000)}:R>) by ${/^\d{17,20}$/.test(r.actor) ? `<@${r.actor}>` : r.actor === 'system' ? 'Vanguard' : r.actor}\n${r.roles === null ? 'Legacy/unreadable layout data' : `${r.roles} roles · ${r.categories} categories · ${r.channels} channels`}${r.source ? ` · copied from ${r.source}` : ''}`).join('\n\n') || `No ${noun} saved.`;
    const cmd = onlyBackups ? '/recovery backup' : '/recovery snapshot';
    const footer = result.total ? `\n\nRestore: \`${cmd} restore number:<#>\` · Delete: \`${cmd} delete numbers:3\` (also \`3,5\`, \`2-6\` or \`all\`).` : '';
    const suffix = onlyBackups ? ':b' : '';
    return { embeds: [embed(`${onlyBackups ? 'Backups' : 'Snapshots & backups'} · page ${result.page}/${result.pages}`, `${result.total} saved ${noun} in this server.\n\n${text}${footer}`)],
        components: result.pages > 1 ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`snapshotpage:${user}:${result.page - 1}${suffix}`).setLabel('Newer').setStyle(ButtonStyle.Secondary).setDisabled(result.page === 1), new ButtonBuilder().setCustomId(`snapshotpage:${user}:${result.page + 1}${suffix}`).setLabel('Older').setStyle(ButtonStyle.Secondary).setDisabled(result.page === result.pages))] : [],
        allowedMentions: { parse: [] } };
}
/** Review deleting one or more recovery points (internal IDs) and arm a two-minute confirmation. */
export async function deletionReview(ctx, i, ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    const preview = ctx.snapshots.deletionPreview(i.guildId, list);
    const key = addConfirmation(ctx, { guild: i.guildId, user: i.user.id, snapshot: list[0], snapshots: list, prune: false, fingerprint: preview.digest, action: 'delete' });
    const lines = preview.items.slice(0, 15).map(item => `• **#${item.number}** · ${item.label} · <t:${Math.floor(item.at / 1000)}:d>`);
    if (preview.items.length > 15)
        lines.push(`• …and ${preview.items.length - 15} more`);
    const title = preview.items.length === 1 ? `Delete recovery point #${preview.number}?` : `Delete ${preview.items.length} recovery points?`;
    await i.editReply({ embeds: [embed(title, `${lines.join('\n')}\n\nThis permanently removes ${preview.items.length === 1 ? 'this saved recovery point' : 'these saved recovery points'}. Current server roles, categories, channels, restore mappings and audit history are not affected.\n\nConfirmation expires in two minutes.`, Colors.Orange)],
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`snapshotdelete:${key}`).setLabel(preview.items.length === 1 ? `Delete #${preview.number}` : `Delete ${preview.items.length}`).setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`snapshotcancel:${key}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))],
        allowedMentions: { parse: [] } });
}
