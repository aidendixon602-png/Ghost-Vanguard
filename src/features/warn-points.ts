import { Colors, type Guild } from 'discord.js';
import type { Store } from '../database/db.js';
import type { LogQueue } from '../logging.js';
import { embed } from '../ui/ui.js';
import { staffReason } from '../security/raidmode.js';
import { getFeature } from './settings.js';
import { sendBanNotice } from './appeals.js';

/**
 * Warning points. Each warning counts for `days` days. When someone reaches a level, Vanguard acts
 * by itself: time out, then kick, then ban (any level can be switched off with 0). A "pardon" case
 * (from /mod warnings pardon) wipes the slate: only warnings after it count.
 */
export interface WarnConfig { enabled: boolean; days: number; timeoutAt: number; timeoutMinutes: number; kickAt: number; banAt: number }
export const WARN_DEFAULTS: WarnConfig = { enabled: true, days: 30, timeoutAt: 3, timeoutMinutes: 60, kickAt: 5, banAt: 0 };
export const warnConfig = (store: Store, guild: string) => getFeature(store, guild, 'warnpoints', WARN_DEFAULTS);

export function activeWarnings(store: Store, guild: string, user: string, now = Date.now()) {
    const c = warnConfig(store, guild);
    const pardon = Number(store.get("SELECT MAX(at) AS at FROM cases WHERE guild_id=? AND user_id=? AND action='pardon'", guild, user)?.at ?? 0);
    return Number(store.get("SELECT COUNT(*) AS n FROM cases WHERE guild_id=? AND user_id=? AND action='warn' AND at>? AND at>?", guild, user, now - c.days * 86400000, pardon)?.n ?? 0);
}

/** The step a count of warnings triggers (null = nothing). Pure, for tests. */
export function warnStep(c: WarnConfig, count: number): 'ban' | 'kick' | 'timeout' | null {
    if (!c.enabled) return null;
    if (c.banAt && count >= c.banAt) return 'ban';
    if (c.kickAt && count >= c.kickAt) return 'kick';
    if (c.timeoutAt && count >= c.timeoutAt) return 'timeout';
    return null;
}

/** Call after a warning is recorded. Returns a sentence for the moderator, or ''. */
export async function escalateWarnings(store: Store, logs: LogQueue, guild: Guild, userId: string, actorId: string, canBan = true): Promise<string> {
    const c = warnConfig(store, guild.id), count = activeWarnings(store, guild.id, userId), step = warnStep(c, count);
    if (!step) return c.enabled ? `They now have **${count}** active warning${count === 1 ? '' : 's'}.` : '';
    // Warnings from a Helper can time out or kick, but a ban needs someone allowed to ban.
    if (step === 'ban' && !canBan) return `⚠ They reached **${count}** warnings (ban level). Ask a Moderator to review and ban them.`;
    const reason = staffReason(actorId, `reached ${count} warnings (automatic ${step})`);
    const member = await guild.members.fetch(userId).catch(() => null);
    let done = '';
    try {
        if (step === 'ban') {
            const user = await guild.client.users.fetch(userId).catch(() => null);
            if (user) await sendBanNotice(store, guild, user, `Reached ${count} warnings in ${c.days} days`);
            await guild.members.ban(userId, { reason }); done = 'banned';
        }
        else if (!member) return `They have **${count}** warnings but are no longer in the server.`;
        else if (step === 'kick') { if (!member.kickable) throw 0; await member.kick(reason); done = 'kicked'; }
        else { if (!member.moderatable) throw 0; await member.timeout(c.timeoutMinutes * 60000, reason); done = `timed out for ${c.timeoutMinutes} minutes`; }
    } catch { return `⚠ They reached **${count}** warnings (automatic ${step}), but Vanguard could not do it. Check its permissions and role position.`; }
    store.recordCase(guild.id, userId, guild.client.user!.id, `auto ${step}`, `Reached ${count} warnings in ${c.days} days`);
    logs.push(guild.id, embed(`Warning points · automatic ${step}`, `<@${userId}> reached **${count}** warnings in ${c.days} days and was **${done}**.\nLast warning by <@${actorId}>.`, Colors.Red));
    return `They reached **${count}** warnings and were automatically **${done}**.`;
}
