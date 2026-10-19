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
};
/** Log channel names from older releases; kept so existing servers reuse them instead of getting a second channel. */
export const LEGACY_CHANNELS = {
    logging: ['midtown-vanguard-logging'],
};
