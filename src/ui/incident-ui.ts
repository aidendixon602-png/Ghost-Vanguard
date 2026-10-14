import { ActionRowBuilder, ButtonBuilder, Colors, PermissionFlagsBits } from 'discord.js';
import { developers } from '../bot/developers.js';
import { confirmDanger } from './danger-ui.js';
import { embed } from './ui.js';
import { AppError } from '../errors.js';
import type { Store } from '../database/db.js';
import { COMPONENTS, type Component } from '../recovery/recovery.js';
import { addConfirmation, showLayoutReview } from './layout-ui.js';
import { defaults, type Registry } from '../bot/registry.js';

/** Matches the window the incident alert reports deletions for. */
const DELETION_LOOKBACK_MS = 10 * 60 * 1000;

/**
 * Work out how to restore what an incident's actor deleted: which components to
 * select, and which snapshots (newest first) were taken before the first deletion.
 * Layout-copy templates hold another server's layout, so they are never candidates.
 */
export function incidentRestorePlan(store: Store, guildId: string, incidentId: number) {
    const incident = store.get('SELECT * FROM incidents WHERE guild_id=? AND id=?', guildId, incidentId);
    if (!incident)
        throw new AppError('VALIDATION_ERROR', 'That incident no longer exists.');
    const deletions = store.all("SELECT rule, MIN(at) AS first, COUNT(*) AS n FROM observations WHERE guild_id=? AND actor_id=? AND rule IN ('channel_delete','role_delete') AND at>=? GROUP BY rule", guildId, incident.actor_id, Number(incident.at) - DELETION_LOOKBACK_MS);
    if (!deletions.length)
        throw new AppError('VALIDATION_ERROR', 'No channel or role deletions are recorded for this incident.');
    const first = Math.min(...deletions.map(d => Number(d.first)));
    const count = (rule: string) => Number(deletions.find(d => d.rule === rule)?.n ?? 0);
    const wanted = new Set<Component>(['permissions']);
    if (count('role_delete'))
        wanted.add('roles');
    if (count('channel_delete')) {
        wanted.add('categories');
        wanted.add('channels');
    }
    const candidates = store.all("SELECT s.id FROM snapshots s LEFT JOIN snapshot_metadata m ON m.snapshot_id=s.id WHERE s.guild_id=? AND s.at<? AND COALESCE(m.kind,'snapshot')<>'copy' ORDER BY s.at DESC, s.id DESC LIMIT 10", guildId, first).map(r => Number(r.id));
    return { channels: count('channel_delete'), roles: count('role_delete'), components: COMPONENTS.filter(c => wanted.has(c)), candidates };
}

export function registerIncidentControls(registry: Registry) {
    registry.component({ prefix: 'incident:restore:', kinds: ['button'], metadata: { ...defaults, category: 'security', access: 'security', botPermissions: [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels] },
        execute: async (ctx, i) => {
            const id = Number(/^incident:restore:(\d{1,12})$/.exec(i.customId)?.[1]);
            if (!id)
                throw new AppError('VALIDATION_ERROR', 'Invalid incident control.');
            const plan = incidentRestorePlan(ctx.store, i.guildId, id);
            // Use the newest snapshot from before the deletions that still loads cleanly.
            const snapshot = plan.candidates.find(candidate => {
                try {
                    ctx.snapshots.load(i.guildId, candidate);
                    return true;
                } catch {
                    return false;
                }
            });
            if (!snapshot)
                throw new AppError('VALIDATION_ERROR', 'No usable snapshot was taken before these deletions, so there is nothing to restore from. Keep a recent baseline with /recovery snapshot create or scheduled backups.');
            const key = addConfirmation(ctx, { guild: i.guildId, user: i.user.id, snapshot, prune: false, fingerprint: '', components: plan.components });
            await showLayoutReview(ctx, i, key, ctx.confirmations.get(key)!);
        } });
    registry.component({ prefix: 'incident:undo:', kinds: ['button'], metadata: { ...defaults, category: 'security', access: 'security', botPermissions: [PermissionFlagsBits.ManageRoles] },
        execute: async (ctx, i) => {
            const id = Number(/^incident:undo:(\d{1,12})$/.exec(i.customId)?.[1]);
            if (!id) throw new AppError('VALIDATION_ERROR', 'Invalid incident control.');
            const plan = undoPlan(ctx.store, i.guildId, id, i.user.id, i.guild?.ownerId);
            const alert = i.message;
            await confirmDanger(ctx, i, {
                title: `Undo strip · Incident #${id}`,
                summary: `Give <@${plan.actor}> back the ${plan.roles} role(s) anti-nuke removed for **${plan.rule}**.`,
                consequences: [
                    'Only do this if it was a false alarm: they get every removed role back, including staff and admin roles.',
                    'Their quarantine ends, so anti-nuke stops re-removing staff roles from them.',
                    'Anti-nuke still watches them: doing the same thing again strips them again. Whitelist them with `/antinuke whitelist add` if this is normal for them.',
                ],
                label: 'Give roles back',
                reversal: 'Use `/security quarantine` on them to strip them again.',
                run: async () => {
                    const again = undoPlan(ctx.store, i.guildId, id, i.user.id, i.guild?.ownerId);
                    const result = await ctx.security.release(i.guild, again.actor, true);
                    ctx.store.run('UPDATE incidents SET result=result || ? WHERE guild_id=? AND id=?', ` Undone by ${i.user.id}.`, i.guildId, id);
                    ctx.logs.push(i.guildId, embed('Strip undone', `<@${i.user.id}> undid **Incident #${id}** for <@${again.actor}> (false alarm). ${result}`, Colors.Green));
                    if (alert?.components?.length) await alert.edit({ components: alert.components.map((row: any) => new ActionRowBuilder<ButtonBuilder>().addComponents(
                        ...row.components.map((c: any) => { const b = ButtonBuilder.from(c); return c.customId === i.customId ? b.setDisabled(true).setLabel('Strip undone') : b; }))) }).catch(() => null);
                    return `↩️ **Done.** ${result}`;
                },
            });
        } });
}

/** Checks for undoing an incident's strip: owner or developer, a strip that removed roles, not already undone, backup present. */
export function undoPlan(store: Store, guildId: string, incidentId: number, userId: string, ownerId: string | undefined) {
    if (userId !== ownerId && !developers.has(userId))
        throw new AppError('PERMISSION_ERROR', 'Only the server owner or a developer can undo an anti-nuke strip.');
    const incident = store.get('SELECT * FROM incidents WHERE guild_id=? AND id=?', guildId, incidentId);
    if (!incident) throw new AppError('VALIDATION_ERROR', 'That incident no longer exists.');
    const result = String(incident.result ?? '');
    if (/ Undone by \d+\./.test(result)) throw new AppError('VALIDATION_ERROR', 'This strip was already undone.');
    const removed = /^Removed (\d+) dangerous role/.exec(result);
    if (!removed || removed[1] === '0') throw new AppError('VALIDATION_ERROR', 'This incident did not remove any roles, so there is nothing to undo.');
    if (!store.get('SELECT 1 FROM backups WHERE guild_id=? AND user_id=?', guildId, incident.actor_id))
        throw new AppError('VALIDATION_ERROR', 'Their saved roles are gone (already restored with `/security release`, or they left). Nothing to undo.');
    return { actor: String(incident.actor_id), rule: String(incident.rule), roles: Number(removed[1]) };
}
