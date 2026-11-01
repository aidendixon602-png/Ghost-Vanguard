/** Source-controlled user-ID assignments. Rebuild and restart after editing. Never put tokens here. */
export type ServerStaffLevel = 'helper' | 'moderator' | 'admin' | 'headadmin';
export type BotStaffLevel = 'developer' | 'supreme' | 'overseer' | 'botmanager';

/** Bot-wide access. Developer IDs also authorize managing all bot permission assignments. */
export const BOT_STAFF_IDS: Partial<Record<BotStaffLevel, readonly string[]>> = {};

/** Server-only access: { 'SERVER_ID': { 'USER_ID': 'moderator' } }. */
export const SERVER_STAFF_IDS: Record<string, Record<string, ServerStaffLevel>> = {};
