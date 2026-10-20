import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Colors } from 'discord.js';
import { randomUUID } from 'node:crypto';
import { defaults } from '../bot/registry.js';
import { Guard } from '../bot/guard.js';
import { AppError } from '../errors.js';
import { embed } from './ui.js';
import { RENDERED, showWorking } from './progress.js';
/**
 * A second step for commands that cannot be undone with another command.
 *
 * The pending action is held in memory only and expires in two minutes, so a restart
 * or a forgotten prompt leaves nothing armed. The confirming click must come from the
 * same user, in the same server, and the work runs only after that click.
 */
const TTL_MS = 120_000;
const pending = new Map();
function sweep() {
    const now = Date.now();
    for (const [token, entry] of pending)
        if (entry.expires <= now)
            pending.delete(token);
}
/** Replies with the warning and arms the action. The caller returns immediately after. */
export async function confirmDanger(ctx, i, spec) {
    sweep();
    const token = randomUUID().replace(/-/g, '').slice(0, 20);
    pending.set(token, { user: i.user.id, guild: i.guildId ?? null, expires: Date.now() + TTL_MS, label: spec.label, policy: ctx.policy ?? { ...defaults, developerOnly: true, requiresAuthorization: false }, commandKey: ctx.actionKey ?? i.commandName ?? 'developer', working: spec.working, run: spec.run });
    await i.editReply({
        embeds: [embed(`⚠ ${spec.title}`, [
                spec.summary,
                '',
                ...spec.consequences.map(line => `• ${line}`),
                '',
                `**Reversal:** ${spec.reversal}`,
                '',
                '_Nothing has happened yet. This prompt expires in two minutes._',
            ].join('\n'), Colors.Red)],
        components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`dangerconfirm:${token}`).setLabel(spec.label).setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`dangercancel:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary))],
        allowedMentions: { parse: [] },
    });
}
function claim(token, i) {
    sweep();
    const entry = pending.get(token);
    if (!entry)
        throw new AppError('VALIDATION_ERROR', 'This confirmation expired or was already used. Run the command again.');
    if (entry.user !== i.user.id)
        throw new AppError('PERMISSION_ERROR', 'This confirmation belongs to another user.');
    if (entry.guild !== (i.guildId ?? null))
        throw new AppError('PERMISSION_ERROR', 'This confirmation was issued in a different server.');
    // Single use: claimed before the work runs, so a double click cannot run it twice.
    pending.delete(token);
    return entry;
}
export function registerDangerConfirm(registry) {
    const metadata = { ...defaults, category: 'utility', requiresAuthorization: false, cooldown: 0 };
    registry.component({
        prefix: 'dangerconfirm:', kinds: ['button'], metadata,
        execute: async (ctx, i) => {
            const entry = claim(i.customId.slice('dangerconfirm:'.length), i);
            const run = async () => {
                ctx.actor = await new Guard(ctx.store, id => ctx.lifecycle?.isReady(id) ?? true).check(i, entry.policy, entry.commandKey, false, true);
                return entry.policy.requiresAuthorization ? ctx.store.withAuthorized(i.guildId, () => entry.run(ctx, i)) : entry.run(ctx, i);
            };
            if (entry.working)
                await showWorking(i, entry.working.title, entry.working.detail);
            const result = entry.policy.requiresAuthorization && ctx.serialize ? await ctx.serialize(run) : await run();
            if (result === RENDERED)
                return;
            await i.editReply({ embeds: [embed('Done', String(result ?? `${entry.label} completed.`), Colors.Green)], components: [], allowedMentions: { parse: [] } });
        },
    });
    registry.component({
        prefix: 'dangercancel:', kinds: ['button'], metadata,
        execute: async (ctx, i) => {
            claim(i.customId.slice('dangercancel:'.length), i);
            await i.editReply({ embeds: [embed('Cancelled', 'Nothing was changed.', Colors.Grey)], components: [], allowedMentions: { parse: [] } });
        },
    });
}
/** Test seam: how many confirmations are currently armed. */
export function armedCount() {
    sweep();
    return pending.size;
}
