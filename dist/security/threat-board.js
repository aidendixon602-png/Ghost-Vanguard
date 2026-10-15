import { Colors } from 'discord.js';
import { embed } from '../ui/ui.js';
import { clip } from '../core.js';
import { config } from '../config.js';
/**
 * The threat board — Ghost Vanguard's intelligence side, and the half that answers back.
 *
 * Defence (yin): every anti-nuke incident, scam post, ping-abuse case and raid join is scored for the
 * person responsible, and the score decides what the bot does about them.
 * Offence (yang): once a score crosses a threshold the bot stops waiting — it contains the attacker,
 * puts back what they broke and, at the top level, strikes (bans them) on its own.
 *
 * The two halves are deliberately balanced, so this can never run away with itself:
 *   - it only ever reacts to a score built from real, recorded incidents;
 *   - trusted people, the bot itself and the server owner are never targeted;
 *   - nothing happens while protection is in observe mode, in an unauthorized server, or when the
 *     server has switched anti-nuke off — then the board only records and shows;
 *   - every automatic action is written down (incident, case, log channel and the board itself),
 *     needs its own cooldown, and is reversible by staff afterwards;
 *   - a quiet attacker cools off: scores halve every day and expire completely after a week.
 */
export const THREAT_POINTS = {
    mass_ban: { points: 40, label: 'Mass ban' },
    bot_add: { points: 35, label: 'Added a bot' },
    dangerous_grant: { points: 35, label: 'Granted dangerous permissions' },
    mass_kick: { points: 30, label: 'Mass kick' },
    channel_delete: { points: 25, label: 'Deleted channels' },
    role_delete: { points: 25, label: 'Deleted roles' },
    automod_tamper: { points: 25, label: 'Tampered with AutoMod' },
    member_prune: { points: 20, label: 'Pruned members' },
    webhook_change: { points: 20, label: 'Changed webhooks' },
    guild_update: { points: 15, label: 'Changed server settings' },
    role_create: { points: 15, label: 'Created roles' },
    scam_post: { points: 15, label: 'Posted a scam' },
    antiping: { points: 10, label: 'Mention-spammed staff' },
    join_flood: { points: 10, label: 'Join flood' },
    channel_create: { points: 10, label: 'Created channels' },
    role_grant: { points: 10, label: 'Gave out roles' },
    timeout: { points: 10, label: 'Mass timeouts' },
    channel_update: { points: 5, label: 'Changed channels' },
    role_update: { points: 5, label: 'Changed roles' },
};
export const THREAT_LEVELS = [
    { key: 'quiet', label: '🟢 Quiet', from: 0 },
    { key: 'watch', label: '🟡 Watch', from: 25 },
    { key: 'high', label: '🟠 High', from: 55 },
    { key: 'critical', label: '🔴 Critical', from: 85 },
];
/** Score for one incident; a rule the board does not know is worth a small amount, never nothing. */
export const pointsFor = (rule) => THREAT_POINTS[rule]?.points ?? 5;
export function levelFor(score) {
    // A row we cannot read as a number is treated as no score rather than blowing up a caller mid-incident.
    const value = Number.isFinite(score) ? score : 0;
    return [...THREAT_LEVELS].reverse().find(level => value >= level.from).key;
}
export const levelLabel = (level) => THREAT_LEVELS.find(l => l.key === level).label;
/** How long one attacker must wait between automatic actions. */
export const ACTION_COOLDOWN_MS = 10 * 60 * 1000;
/** Scores halve after this long without an incident. */
export const DECAY_AFTER_MS = 24 * 3600 * 1000;
/** A threat disappears from the board after this long. */
export const THREAT_TTL_MS = 7 * 24 * 3600 * 1000;
/** Add points for something a person did. Returns their new row, or null for something we do not score. */
export function recordThreat(store, guildId, userId, rule, detail, at = Date.now()) {
    if (!THREAT_POINTS[rule] && rule !== 'manual')
        return null;
    const points = pointsFor(rule);
    const found = store.get('SELECT * FROM threat_scores WHERE guild_id=? AND user_id=?', guildId, userId);
    // Only a row we can actually read counts: a caller with a stub store must not turn into a crash
    // in the middle of handling an incident on a live server.
    const existing = found && Number.isFinite(Number(found.score)) && Number.isFinite(Number(found.last_at)) ? found : undefined;
    // A cleared threat starts again from this incident, so staff clearing a false alarm is respected.
    const base = existing && !existing.cleared_at ? decayedScore(existing, at) : 0;
    const score = base + points;
    const level = levelFor(score);
    store.run(`INSERT INTO threat_scores(guild_id,user_id,score,level,first_at,last_at,last_rule,strikes,cleared_at)
            VALUES(?,?,?,?,?,?,?,?,NULL) ON CONFLICT(guild_id,user_id) DO UPDATE SET
            score=excluded.score, level=excluded.level, first_at=excluded.first_at, last_at=excluded.last_at,
            last_rule=excluded.last_rule, cleared_at=NULL`, guildId, userId, score, level, existing?.first_at ?? at, at, rule, existing?.strikes ?? 0);
    store.run('INSERT INTO threat_events(guild_id,user_id,rule,points,detail,at) VALUES(?,?,?,?,?,?)', guildId, userId, rule, points, clip(detail, 500), at);
    return store.get('SELECT * FROM threat_scores WHERE guild_id=? AND user_id=?', guildId, userId);
}
/**
 * The version every protection path calls: recording is bookkeeping, so a database hiccup must never
 * stop a raid from being contained or a scam message from being removed. Failures are logged and the
 * caller carries on.
 */
export function noteThreat(store, guildId, userId, rule, detail, at = Date.now()) {
    try {
        return recordThreat(store, guildId, userId, rule, detail, at);
    }
    catch (error) {
        console.warn(`[threats] could not record ${rule} for ${userId}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}
/** Scores halve once per quiet day, so one bad hour does not mark someone forever. */
export function decayedScore(row, now = Date.now()) {
    const score = Number(row.score);
    if (!Number.isFinite(score) || score <= 0)
        return 0;
    const days = Math.floor((now - Number(row.last_at)) / DECAY_AFTER_MS);
    if (!Number.isFinite(days) || days <= 0)
        return score;
    return Math.floor(score / 2 ** Math.min(days, 8));
}
/** Refresh every stored score for a guild: decay the quiet ones and drop the expired ones. */
export function decayThreats(store, guildId, now = Date.now()) {
    let changed = 0, expired = 0;
    for (const row of store.all('SELECT * FROM threat_scores WHERE guild_id=? AND cleared_at IS NULL', guildId)) {
        if (now - row.last_at > THREAT_TTL_MS) {
            store.run('DELETE FROM threat_scores WHERE guild_id=? AND user_id=?', guildId, row.user_id).changes && expired++;
            continue;
        }
        const score = decayedScore(row, now);
        if (score === row.score)
            continue;
        store.run('UPDATE threat_scores SET score=?, level=? WHERE guild_id=? AND user_id=?', score, levelFor(score), guildId, row.user_id);
        changed++;
    }
    return { changed, expired };
}
export const board = (store, guildId, limit = 25) => store.all('SELECT * FROM threat_scores WHERE guild_id=? AND cleared_at IS NULL ORDER BY score DESC, last_at DESC LIMIT ?', guildId, limit);
export const threatFor = (store, guildId, userId) => store.get('SELECT * FROM threat_scores WHERE guild_id=? AND user_id=?', guildId, userId);
export const threatEvents = (store, guildId, userId, limit = 10) => store.all('SELECT * FROM threat_events WHERE guild_id=? AND user_id=? ORDER BY at DESC LIMIT ?', guildId, userId, limit);
export const threatActions = (store, guildId, limit = 15) => store.all('SELECT * FROM threat_actions WHERE guild_id=? ORDER BY id DESC LIMIT ?', guildId, limit);
export function clearThreat(store, guildId, userId, byId) {
    const changed = store.run('UPDATE threat_scores SET cleared_at=?, cleared_by=?, score=0, level=? WHERE guild_id=? AND user_id=? AND cleared_at IS NULL', Date.now(), byId, 'quiet', guildId, userId);
    return !!changed.changes;
}
export function recordThreatAction(store, guildId, userId, action, detail, byId) {
    const at = Date.now();
    store.run('INSERT INTO threat_actions(guild_id,user_id,action,detail,by_id,at) VALUES(?,?,?,?,?,?)', guildId, userId, action, clip(detail, 500), byId, at);
    store.run('UPDATE threat_scores SET last_action=?, last_action_at=? WHERE guild_id=? AND user_id=?', action, at, guildId, userId);
    if (action === 'strike')
        store.run('UPDATE threat_scores SET strikes=strikes+1 WHERE guild_id=? AND user_id=?', guildId, userId);
    return at;
}
/**
 * What the bot should do about one attacker, and why. Pure, so the balance is easy to read and test:
 * watch = record only · contain = strip + put their damage back · strike = contain, then ban.
 */
export function planResponse(input) {
    const now = input.now ?? Date.now();
    if (!input.protectionOn || input.mode !== 'enforce')
        return { action: 'none', why: 'Protection is off or in observe mode, so the board only records.' };
    if (input.trusted)
        return { action: 'none', why: 'They are on the anti-nuke whitelist, so nothing is automatic.' };
    if (input.isBot || input.isOwner)
        return { action: 'none', why: 'The bot never acts against itself or the server owner.' };
    if (input.lastActionAt && now - input.lastActionAt < ACTION_COOLDOWN_MS)
        return { action: 'none', why: 'An automatic action was taken against them in the last 10 minutes.' };
    const level = levelFor(input.score);
    if (level === 'critical')
        return input.alreadyBanned
            ? { action: 'contain', why: 'Critical score; they are already banned, so their access is stripped and their damage put back.' }
            : { action: 'strike', why: 'Critical score: contain, put their damage back, then ban them.' };
    if (level === 'high')
        return { action: 'contain', why: 'High score: strip their dangerous roles and put their damage back.' };
    if (level === 'watch')
        return { action: 'watch', why: 'Watch level: shown on the board, no action taken yet.' };
    return { action: 'none', why: 'Below the action threshold.' };
}
/**
 * Walk the board for every ready server and carry out whatever planResponse decided.
 * Called on the bot's minute timer; safe to run at any time (everything is idempotent and logged).
 */
export async function sweepThreats(deps, limit = 15) {
    const now = (deps.now ?? Date.now)();
    const result = { reviewed: 0, watch: 0, contained: 0, struck: 0, skipped: 0 };
    for (const guild of deps.client.guilds.cache.values()) {
        if (!deps.ready(guild.id))
            continue;
        const outcomes = await deps.store.withAuthorized(guild.id, async () => {
            decayThreats(deps.store, guild.id, now);
            const settings = deps.store.settings(guild.id);
            const rows = board(deps.store, guild.id, limit);
            const local = { reviewed: rows.length, watch: 0, contained: 0, struck: 0, skipped: 0 };
            for (const row of rows) {
                const level = levelFor(decayedScore(row, now));
                if (level === 'quiet')
                    continue;
                const member = await guild.members.fetch({ user: row.user_id, force: false }).catch(() => null);
                const plan = planResponse({
                    score: decayedScore(row, now), mode: settings.mode, protectionOn: !!settings.enabled && settings.authorized,
                    trusted: deps.trusted(guild, row.user_id), isBot: !!member?.user.bot, isOwner: row.user_id === guild.ownerId,
                    lastActionAt: row.last_action_at, alreadyBanned: await deps.isBanned(guild, row.user_id).catch(() => false), now,
                });
                if (plan.action === 'none') {
                    local.skipped++;
                    continue;
                }
                if (plan.action === 'watch') {
                    // Nothing is done to them; the board already shows them, so staff can step in first.
                    local.watch++;
                    continue;
                }
                const line = await deps.contain(guild, row.user_id, `Ghost Vanguard threat board: ${levelLabel(level)} (${decayedScore(row, now)} points)`);
                recordThreatAction(deps.store, guild.id, row.user_id, plan.action, `${plan.why} ${line}`, deps.client.user?.id ?? 'system');
                let text = `**${levelLabel(level)} · ${decayedScore(row, now)} points**\n**What they were doing:** ${THREAT_POINTS[row.last_rule]?.label ?? row.last_rule}\n**Defence:** ${line}`;
                if (plan.action === 'strike') {
                    const banned = await deps.ban?.(guild, row.user_id, `Ghost Vanguard threat board: ${levelLabel(level)}`).catch(() => false) ?? false;
                    text += banned
                        ? '\n**Counter-attack:** banned. Lift it any time with `/mod unban`, or clear the board entry with `/security threats clear`.'
                        : '\n**Counter-attack failed** (check my Ban Members permission and role position). The strip and the restore above still stand.';
                    if (banned)
                        local.struck++;
                }
                else
                    local.contained++;
                deps.logs.push(guild.id, embed(`🛡️ Threat board acted: ${plan.action === 'strike' ? 'strike' : 'contain'}`, `**Member:** <@${row.user_id}> (\`${row.user_id}\`)\n${text}\n-# Every automatic action is recorded and reversible. Only Developers and staff above this can stop the board with \`/security threats\`.`, plan.action === 'strike' ? Colors.Red : Colors.Orange));
            }
            return local;
        });
        result.reviewed += outcomes.reviewed;
        result.watch += outcomes.watch;
        result.contained += outcomes.contained;
        result.struck += outcomes.struck;
        result.skipped += outcomes.skipped;
    }
    return result;
}
/** The numbers behind the dashboard and `/security threats list`. */
export function boardSummary(store, guildId, now = Date.now()) {
    const rows = board(store, guildId, 100).map(row => ({ ...row, score: decayedScore(row, now) }));
    return {
        total: rows.length,
        critical: rows.filter(r => levelFor(r.score) === 'critical').length,
        high: rows.filter(r => levelFor(r.score) === 'high').length,
        watch: rows.filter(r => levelFor(r.score) === 'watch').length,
        top: rows.sort((a, b) => b.score - a.score).slice(0, 5),
    };
}
/** The name the bot signs automatic counter-attacks with, kept in one place. */
export const STRIKE_REASON = `Ghost Vanguard: automatic counter-attack`;
export const boardOwner = () => config.ownerId;
