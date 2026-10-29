import { noticeEmbed } from '../ui/notice.js';
import { Colors } from 'discord.js';
import { RULES } from '../core.js';
import { logEvent } from '../errors.js';
import { readiness } from './readiness.js';
import { antinukeLocked } from '../bot/env-rules.js';
/**
 * The anti-nuke preset is fixed: the rules in RULES, their limits, punishments and reverts.
 * New servers start in observe mode. Enforcement requires the readiness check and an explicit
 * `/antinuke enable`; a staff "off" choice is stored separately and survives restarts.
 */
export function antinukeOptedOut(store, guild) {
    return store.antinukeStaffDisabled(guild);
}
export function setAntinukeChoice(store, guild, enabled) {
    store.setAntinukeStaffDisabled(guild, !enabled);
}
/** Remove any legacy custom limits/toggles and set the requested mode. */
export function applyLockedPreset(s, mode = 'enforce') {
    s.rules = {};
    s.ruleDefaults = undefined;
    s.enabled = true;
    s.mode = mode;
}
export function presetIsApplied(s) {
    return s.enabled && !Object.keys(s.rules).length && !s.ruleDefaults;
}
/** Called for every authorized server at startup and after authorization. */
export async function applyDefaultAntinuke(store, guild, logs) {
    if (!store.isAuthorized(guild.id))
        return 'unchanged';
    const s = store.settings(guild.id);
    // ANTINUKE_LOCK (.env): nobody may leave a server unprotected, so a staff "off" choice is undone at every start.
    if (antinukeLocked() && antinukeOptedOut(store, guild.id)) {
        setAntinukeChoice(store, guild.id, true);
        logEvent('antinuke_lock_reenabled', { guildId: guild.id });
        logs.push(guild.id, noticeEmbed('🔒 Anti-nuke switched back on', [
            'Anti-nuke had been turned off here, but it is locked in the bot settings (`ANTINUKE_LOCK`), so it is on again.',
            'Only a Developer can turn it off while the lock is set.',
        ], Colors.Orange));
    }
    if (antinukeOptedOut(store, guild.id)) {
        if (s.enabled) {
            s.enabled = false;
            store.save(s, 'system');
        }
        return 'opted-out';
    }
    // Refresh the bot member and configured log channel so startup readiness is based on live
    // permissions rather than a possibly stale partial cache.
    await Promise.resolve(guild.members?.fetchMe?.()).catch(() => null);
    if (s.logChannelId)
        await Promise.resolve(guild.channels?.fetch?.(s.logChannelId)).catch(() => null);
    const ready = readiness(guild, s.logChannelId, store);
    const wasEnforcing = s.enabled && s.mode === 'enforce';
    // Keep an established enforce configuration only while it is operationally ready. If a
    // required permission or the security-log destination disappears, fail safe into observe.
    if (presetIsApplied(s)) {
        if (wasEnforcing && ready.missing.length) {
            s.mode = 'observe';
            store.save(s, 'system');
            store.setKickBots(guild.id, false);
            const detail = ready.missing.join(', ');
            logEvent('antinuke_readiness_warning', { guildId: guild.id, missing: ready.missing, action: 'downgraded_to_observe' });
            logs.push(guild.id, noticeEmbed('⚠️ Anti-nuke switched to observe mode', [
                'Enforcement was paused because a required permission or the security-log channel is unavailable.',
                `**Readiness blockers:** ${detail}`,
                'Fix the blockers, run `/antinuke check`, then `/antinuke enable` and confirm to resume enforcement.',
            ], Colors.Orange));
            return 'observing';
        }
        if (store.kickBots(guild.id))
            store.setKickBots(guild.id, false);
        return 'unchanged';
    }
    // Do not make a first-time or previously observing server enforce automatically. Existing
    // enforced servers retain enforcement only if readiness passes; otherwise they fail safe.
    const mode = wasEnforcing && ready.missing.length === 0 ? 'enforce' : 'observe';
    applyLockedPreset(s, mode);
    store.save(s, 'system');
    store.setKickBots(guild.id, false);
    if (mode === 'observe') {
        const reason = ready.missing.length
            ? `**Readiness blockers:** ${ready.missing.join(', ')}\nRun /antinuke check, set up logs, then /antinuke enable after the check passes.`
            : 'Readiness is available, but enforcement still needs a deliberate `/antinuke enable` and confirmation.';
        logEvent('antinuke_started_in_observe_mode', { guildId: guild.id, missing: ready.missing });
        logs.push(guild.id, noticeEmbed('🟠 Anti-nuke observe mode', [
            `The ${RULES.length}-rule preset is recording incidents but will not strip members or revert changes.`,
            reason,
            '**Turn on enforcement:** `/antinuke enable` (requires readiness and confirmation).',
            '**Exceptions:** `/antinuke whitelist add`',
        ], Colors.Orange));
        return 'observing';
    }
    logEvent('antinuke_default_applied', { guildId: guild.id, preservedExistingEnforcement: wasEnforcing });
    logs.push(guild.id, noticeEmbed('🛡️ Anti-nuke protection on', [`The standard anti-nuke preset is running.`, `**Rules:** ${RULES.length}`, '**Mode:** enforce', '**Exceptions:** `/antinuke whitelist add`', '**Turn off:** `/antinuke disable`'], Colors.Green));
    return 'enabled';
}
