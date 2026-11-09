import type { Store } from '../database/db.js';
import { getFeature } from './settings.js';

/**
 * The on/off switches for the extra anti-nuke layers (`/antinuke settings`). They sit in their own file
 * because anti-nuke, backup sync and auto-restore all read them, and none of those may import the command.
 *
 * `backupSync`, `autoRestore` and `freshGuard` are optional so servers saved before they existed read as
 * "on": getFeature fills any missing field from these defaults.
 */
export interface PlusConfig {
    raidAuto: boolean; raidAutoHours: number; settingsLock: boolean; botQuarantine: boolean; joinGate?: boolean; messageWaves?: boolean;
    /** Keep a recent backup in step with the server's channels and roles. */
    backupSync?: boolean;
    /** After anti-nuke stops someone who deleted channels or roles, put those back from the newest earlier backup. */
    autoRestore?: boolean;
    /** Take powerful roles back from accounts and members that are brand new, whoever gave them. */
    freshGuard?: boolean;
}

export const PLUS_DEFAULTS: PlusConfig = { raidAuto: true, raidAutoHours: 1, settingsLock: true, botQuarantine: true, joinGate: true, messageWaves: true, backupSync: true, autoRestore: true, freshGuard: true };
export const plusConfig = (store: Store, guild: string) => getFeature(store, guild, 'antinukeplus', PLUS_DEFAULTS);
