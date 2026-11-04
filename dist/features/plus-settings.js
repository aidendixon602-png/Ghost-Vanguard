import { getFeature } from './settings.js';
export const PLUS_DEFAULTS = { raidAuto: true, raidAutoHours: 1, settingsLock: true, botQuarantine: true, joinGate: true, messageWaves: true, backupSync: true, autoRestore: true, freshGuard: true };
export const plusConfig = (store, guild) => getFeature(store, guild, 'antinukeplus', PLUS_DEFAULTS);
