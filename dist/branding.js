/**
 * One place for the product's name.
 * Screens, footers, panels and default channel names read it from here so nothing hardcodes a name
 * the bot no longer uses (older releases called it Midtown Vanguard).
 */
export const PRODUCT_NAME = 'Ghost Vanguard';
export const PRODUCT_NAME_UPPER = 'GHOST VANGUARD';
/** Default names for the channels Vanguard creates in a new server. */
export const DEFAULT_CHANNELS = {
    /** One record per ban, with the Unban / Reban buttons. */
    bans: 'bans',
    /** Server events and bot actions. */
    logging: 'ghost-vanguard-logging',
    /** Private security log (anti-nuke, scam protection, raid response) and the topic that marks it as Vanguard's. */
    security: 'vanguard-security',
};
/** Topic Vanguard sets on the security log it manages, so a restart finds the same channel instead of a second one. */
export const SECURITY_LOG_TOPIC = `${PRODUCT_NAME} • managed security log`;
/** Log channel names from older releases; kept so existing servers reuse them instead of getting a second channel. */
export const DEFAULT_CATEGORIES = {
    logs: 'Ghost Vanguard Logs',
};
/** Legacy category names are renamed to an archive during log setup; their channels and history are preserved. */
export const LEGACY_CATEGORIES = {
    logs: ['veil logs', 'veil-logs', 'veil_logs'],
    archivedLogs: 'Archive - Veil Logs',
};
export const LEGACY_CHANNELS = {
    logging: ['midtown-vanguard-logging'],
};
