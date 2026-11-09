import { Colors } from 'discord.js';
import { setTimeout as wait } from 'node:timers/promises';
import { AppError, failure, logEvent } from '../errors.js';
import { plusConfig } from '../features/plus-settings.js';
import { clip } from '../core.js';
import { embed } from '../ui/ui.js';
import { incidentRestorePlan } from './incident-plan.js';
import { backupsDisabled, BUSY_MESSAGE } from './recovery.js';
/**
 * After anti-nuke stops someone who deleted channels or roles, put exactly those back from the newest
 * backup that was taken before the first deletion.
 *
 * Only what the attacker deleted is re-created. Everything that still exists is left as it is, so a
 * change someone made on purpose since the backup is never undone. This is why the backups are kept
 * up to date by the layout sync (sync.ts): the newer the backup, the less is missing from it.
 */
/** The attacker has to stay quiet this long before anything is put back, so the restore does not race the deletions. */
export const SETTLE_MS = 10_000;
/** A nuke that keeps going is restored anyway after this long. */
export const MAX_SETTLE_MS = 2 * 60_000;
/** A restore that finds another recovery running, or the server changed under it, is tried again. */
export const TRIES = 3;
export const RETRY_MS = 5_000;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "3 channels and 1 role"; a part that is zero is left out. */
const things = (channels, roles) => [channels && plural(channels, 'channel'), roles && plural(roles, 'role')].filter(Boolean).join(' and ') || 'nothing';
export class AutoRestore {
    d;
    jobs = new Map();
    sleep;
    now;
    constructor(d) {
        this.d = d;
        this.sleep = d.sleep ?? (ms => wait(ms));
        this.now = d.now ?? Date.now;
    }
    /** True while a restore for this person's deletions is waiting or running. */
    busy(guildId, actor) {
        return this.jobs.has(`${guildId}:${actor}`);
    }
    /**
     * Anti-nuke has contained `actor`, who deleted channels or roles. Waits for the deletions to stop, then puts
     * them back. Returns at once when the layer is off; a second call for the same person while one is running
     * makes it look again when it finishes, so deletions that arrive late are not missed.
     */
    schedule(guild, actor, incident) {
        const key = `${guild.id}:${actor}`, running = this.jobs.get(key);
        if (running) {
            running.again = true;
            return Promise.resolve(undefined);
        }
        if (plusConfig(this.d.store, guild.id).autoRestore === false || backupsDisabled(this.d.store, guild.id))
            return Promise.resolve('off');
        const job = { again: false };
        this.jobs.set(key, job);
        return (async () => {
            let outcome;
            do {
                job.again = false;
                outcome = await this.restoreNow(guild, actor, incident, true);
            } while (job.again);
            return outcome;
        })().catch(error => {
            logEvent('auto_restore_failure', { guildId: guild.id, actor, ...failure(error) });
            return 'failed';
        }).finally(() => { this.jobs.delete(key); });
    }
    async settle(guildId, actor) {
        const started = this.now();
        for (;;) {
            await this.d.settled?.(guildId);
            const last = Number(this.d.store.get("SELECT MAX(at) AS at FROM observations WHERE guild_id=? AND actor_id=? AND rule IN ('channel_delete','role_delete')", guildId, actor)?.at ?? 0);
            if (this.now() - last >= SETTLE_MS || this.now() - started >= MAX_SETTLE_MS)
                return;
            await this.sleep(1000);
        }
    }
    /** One restore. `settle` waits for the deletions to stop first; tests and callers that already know pass false. */
    async restoreNow(guild, actor, incident, settle = false) {
        const scope = this.d.scope ?? ((id, fn) => this.d.store.withAuthorized(id, fn));
        return scope(guild.id, async () => {
            const { store, snapshots } = this.d;
            if (plusConfig(store, guild.id).autoRestore === false || backupsDisabled(store, guild.id))
                return 'off';
            if (store.settings(guild.id).mode !== 'enforce')
                return 'not-enforcing';
            if (settle)
                await this.settle(guild.id, actor);
            // Worked out after the wait: the list of what was deleted has grown since the incident was raised.
            let plan;
            try {
                plan = incidentRestorePlan(store, guild.id, incident);
            }
            catch {
                return 'nothing';
            }
            const deletedText = things(plan.deleted.channels.length, plan.deleted.roles.length);
            let chosen = null;
            for (const candidate of plan.candidates) {
                try {
                    const loaded = snapshots.load(guild.id, candidate);
                    chosen = { id: loaded.id, data: loaded.data };
                    break;
                }
                catch { /* try the next one */ }
            }
            if (!chosen) {
                this.d.post(guild.id, embed('Could not put back what was deleted', `<@${actor}> deleted ${deletedText}, and no backup was saved before that, so there is nothing to restore from.\nBackup sync keeps one ready: turn it on with \`/antinuke settings\`, or schedule backups with \`/setup config backups\`.`, Colors.Red));
                logEvent('auto_restore', { guildId: guild.id, actor, outcome: 'no-backup' });
                return 'no-backup';
            }
            const { id: backup, data } = chosen, number = snapshots.numberOf(guild.id, backup);
            const takenAt = Number(store.get('SELECT at FROM snapshots WHERE guild_id=? AND id=?', guild.id, backup)?.at ?? 0);
            const recreate = {
                roles: plan.deleted.roles.filter(id => data.roles.some(r => r.id === id && !r.managed)),
                channels: plan.deleted.channels.filter(id => data.channels.some(c => c.id === id)),
            };
            if (!recreate.roles.length && !recreate.channels.length) {
                this.d.post(guild.id, embed('Nothing to put back from the backup', `<@${actor}> deleted ${deletedText}. None of them are in backup #${number}, which is older than they are, so none could be put back.`, Colors.Orange));
                logEvent('auto_restore', { guildId: guild.id, actor, outcome: 'not-in-backup', backup: number });
                return 'not-in-backup';
            }
            const botId = guild.client.user?.id ?? 'vanguard';
            let before = { roleCreate: 0, channelCreate: 0 }, report = '', failedWith = null;
            for (let attempt = 1; attempt <= TRIES; attempt++) {
                failedWith = null;
                try {
                    const preview = await snapshots.plan(guild, data, false, plan.components, recreate);
                    before = { roleCreate: preview.roleCreate, channelCreate: preview.channelCreate };
                    if (!preview.roleCreate && !preview.channelCreate && !preview.skipped.length) {
                        logEvent('auto_restore', { guildId: guild.id, actor, outcome: 'already-back', backup: number });
                        return 'already-back';
                    }
                    report = await snapshots.restore(guild, backup, false, preview.fingerprint, { components: plan.components, actor: botId, recreate, quiet: true });
                    break;
                }
                catch (error) {
                    failedWith = error;
                    const retry = error instanceof AppError && error.category === 'VALIDATION_ERROR' && (error.message === BUSY_MESSAGE || /server changed after the preview/.test(error.message));
                    if (!retry || attempt === TRIES)
                        break;
                    await this.sleep(RETRY_MS);
                }
            }
            if (failedWith) {
                const why = failedWith instanceof Error ? failedWith.message : 'Unknown error';
                this.d.post(guild.id, embed('Could not put back what was deleted', `<@${actor}> deleted ${deletedText}. Restoring them from backup #${number} failed:\n${clip(why, 700)}\nUse **Review restore** on the incident card to try again by hand.`, Colors.Red));
                logEvent('auto_restore_failure', { guildId: guild.id, actor, backup: number, message: why });
                return 'failed';
            }
            // Ask again what is still missing, so the card says what is true now rather than what the report hoped for.
            const after = await snapshots.plan(guild, data, false, plan.components, recreate).catch(() => null);
            const missing = { roleCreate: after?.roleCreate ?? 0, channelCreate: after?.channelCreate ?? 0 };
            const back = { channels: before.channelCreate - missing.channelCreate, roles: before.roleCreate - missing.roleCreate };
            // What was deleted but is not in the backup (made after it was saved, or a type Vanguard cannot create).
            const absent = things(plan.deleted.channels.length - recreate.channels.length, plan.deleted.roles.length - recreate.roles.length);
            // The report ends with one line per skipped or failed object, after the counts.
            const rows = report.split('\n'), tail = rows.findIndex(l => l.startsWith('**Remaining structural differences:**'));
            const notes = tail < 0 ? [] : rows.slice(tail + 1).filter(l => l && l !== 'No reported failures or skipped objects.');
            const counted = (name) => Number(new RegExp(`^\\*\\*${name}:\\*\\* (\\d+)$`, 'm').exec(report)?.[1] ?? 0);
            const complete = !!after && !missing.channelCreate && !missing.roleCreate && !counted('Skipped') && !counted('Failed') && absent === 'nothing';
            const lines = [
                `<@${actor}> deleted ${deletedText}. Vanguard put back ${things(back.channels, back.roles)} from backup #${number}${takenAt ? `, saved <t:${Math.floor(takenAt / 1000)}:R>` : ''}.`,
                absent === 'nothing' ? '' : `**Not in the backup:** ${absent}. They were made after it was saved, or are a kind Vanguard cannot create.`,
                !after ? 'Vanguard could not check afterwards what is still missing.' : missing.channelCreate || missing.roleCreate ? `**Still missing:** ${things(missing.channelCreate, missing.roleCreate)}.` : '',
                ...notes.slice(0, 6).map(l => `• ${clip(l, 200)}`),
                notes.length > 6 ? `• and ${notes.length - 6} more in the restore report` : '',
                '-# Only what was deleted was re-created; nothing else was changed. Messages in a deleted channel cannot be brought back.',
            ].filter(Boolean);
            this.d.post(guild.id, embed(complete ? `Put back from backup #${number}` : `Partly put back from backup #${number}`, lines.join('\n'), complete ? Colors.Green : Colors.Orange));
            logEvent('auto_restore', { guildId: guild.id, actor, outcome: complete ? 'restored' : 'incomplete', backup: number, channels: back.channels, roles: back.roles });
            return complete ? 'restored' : 'incomplete';
        });
    }
}
