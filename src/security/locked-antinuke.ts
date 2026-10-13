import { noticeEmbed } from '../ui/notice.js';
import { Colors, type Guild } from 'discord.js';
import { RULES } from '../core.js';
import type { Settings, Store } from '../database/db.js';
import type { LogQueue } from '../logging.js';
import { logEvent } from '../errors.js';
import { embed } from '../ui/ui.js';

/**
 * The anti-nuke preset is fixed: the 17 rules in RULES, their limits, punishments and reverts.
 * Servers can only switch protection on or off; the whitelist is managed with /antinuke whitelist.
 * A staff "off" choice is stored in antinuke_options.staff_disabled and survives restarts.
 */
export function antinukeOptedOut(store: Store, guild: string): boolean {
    return store.antinukeStaffDisabled(guild);
}
export function setAntinukeChoice(store: Store, guild: string, enabled: boolean) {
    store.setAntinukeStaffDisabled(guild, !enabled);
}
/** Remove any legacy custom limits/toggles and set enforcement on. */
export function applyLockedPreset(s: Settings) {
    s.rules = {};
    s.ruleDefaults = undefined;
    s.enabled = true;
    s.mode = 'enforce';
}
export function presetIsApplied(s: Settings): boolean {
    return s.enabled && s.mode === 'enforce' && !Object.keys(s.rules).length && !s.ruleDefaults;
}

/** Called for every authorized server at startup and after authorization. */
export async function applyDefaultAntinuke(store: Store, guild: Guild, logs: LogQueue, baseline?: (guild: Guild) => Promise<number>): Promise<'opted-out' | 'unchanged' | 'enabled'> {
    if (!store.isAuthorized(guild.id)) return 'unchanged';
    const s = store.settings(guild.id);
    if (antinukeOptedOut(store, guild.id)) {
        if (s.enabled) { s.enabled = false; store.save(s, 'system'); }
        return 'opted-out';
    }
    if (presetIsApplied(s)) {
        if (store.kickBots(guild.id)) store.setKickBots(guild.id, false);
        return 'unchanged';
    }
    const wasEnabled = s.enabled;
    applyLockedPreset(s);
    store.save(s, 'system');
    store.setKickBots(guild.id, false);
    let snapshot: number | null = null;
    if (!wasEnabled && baseline) snapshot = await baseline(guild).catch(() => null);
    logEvent('antinuke_default_applied', { guildId: guild.id, wasEnabled, snapshot });
    logs.push(guild.id, noticeEmbed('🛡️ Anti-nuke protection on', [`The standard anti-nuke preset is running. Nothing needs to be switched on.`, `**Rules:** ${RULES.length}`, '**Mode:** enforce', ...(snapshot ? [`**Baseline:** snapshot #${snapshot}`] : []), '**Exceptions:** `/antinuke whitelist add`', '**Turn off:** `/antinuke disable`'], Colors.Green));
    return 'enabled';
}
