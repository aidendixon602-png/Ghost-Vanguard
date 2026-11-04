/**
 * The new-account guard's idea of "new". A role with Administrator, Manage Roles and the like goes back off
 * anyone whose Discord account is younger than FRESH_ACCOUNT_DAYS, or who joined this server less than
 * FRESH_MEMBER_HOURS ago. An account's age is built into its ID and cannot be faked; the time in the server
 * cannot be shortened either, so a takeover that hands a powerful role to a throwaway account fails at once.
 */
export const FRESH_ACCOUNT_DAYS = 7;
export const FRESH_MEMBER_HOURS = 24;

const HOUR = 3600000;
const DAY = 24 * HOUR;

export interface Freshness {
    /** Which window the person is inside; both when the account is young and they only just joined. */
    kind: 'account' | 'member' | 'both';
    /** Fits after "since": "their Discord account is 2 days old". */
    text: string;
    /** What staff can wait for instead of overriding the guard. Names every window that still applies. */
    wait: string;
}

/** "under a minute", "12 minutes", "5 hours", "3 days". */
export function age(ms: number): string {
    const minutes = Math.max(0, Math.floor(ms / 60000));
    if (minutes < 1) return 'under a minute';
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * Why this person counts as new, or null. A bot is never new here: adding one is the Bot Add rule's business,
 * and a bot's account is often days old when it is invited.
 */
export function freshness(member: { user: { bot?: boolean; createdTimestamp: number }; joinedTimestamp: number | null }, now = Date.now()): Freshness | null {
    if (member.user.bot) return null;
    const account = now - member.user.createdTimestamp;
    const here = member.joinedTimestamp ? now - member.joinedTimestamp : Infinity;
    const youngAccount = account < FRESH_ACCOUNT_DAYS * DAY, justJoined = here < FRESH_MEMBER_HOURS * HOUR;
    const accountText = `their Discord account is ${age(account)} old`, joinedText = `they joined the server ${age(here)} ago`;
    const accountWait = `the account is ${FRESH_ACCOUNT_DAYS} days old`, joinedWait = `they have been in the server for ${FRESH_MEMBER_HOURS} hours`;
    // Both can apply at once, and then waiting out only one of them would leave the guard in place.
    if (youngAccount && justJoined)
        return { kind: 'both', text: `${accountText} and ${joinedText}`, wait: `until ${accountWait} and ${joinedWait}` };
    if (youngAccount)
        return { kind: 'account', text: accountText, wait: `until ${accountWait}` };
    if (justJoined)
        return { kind: 'member', text: joinedText, wait: `until ${joinedWait}` };
    return null;
}
