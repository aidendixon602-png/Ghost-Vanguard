/** Bot-wide access. Developer IDs also authorize managing all bot permission assignments. */
export const BOT_STAFF_IDS = {};
/** Server-only access: { 'SERVER_ID': { 'USER_ID': 'moderator' } }. */
export const SERVER_STAFF_IDS = {};
/**
 * Automatic reactions, source only: no slash command, no database. Rebuild and restart after editing.
 *
 *   AUTOREACT_IDS      → every server the bot is in, by user ID.
 *   SERVER_AUTOREACT_IDS → one server only: { 'SERVER_ID': { 'USER_ID': '🎯' } }.
 *
 * The value is the emoji to react with: a unicode emoji (🐐) or a custom one (<:name:id>). Leave it
 * out for the default 🐐. A server entry wins over a global entry for the same person.
 * These are public Discord IDs, never tokens.
 */
export const AUTOREACT_IDS = {};
export const SERVER_AUTOREACT_IDS = {};
