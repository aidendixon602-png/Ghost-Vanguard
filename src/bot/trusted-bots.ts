/**
 * Bots Vanguard always trusts, in every server: the other bots in this network, run by the same people.
 *
 * Vanguard leaves their actions alone exactly as it leaves its own: anti-nuke never counts, alerts on or punishes
 * them, the settings lock and protected-role guards don't undo what they do, and they are not held for approval
 * when they join. Only list bots you run yourself: a trusted bot whose token leaks could act in any server without
 * anti-nuke stepping in.
 */
export const TRUSTED_BOTS: ReadonlyMap<string, string> = new Map([
    ['1563480035493417021', 'Veil Utilities'],
]);

export const isTrustedBot = (id: string | null | undefined): boolean => !!id && TRUSTED_BOTS.has(id);

/**
 * People no part of Vanguard ever acts against, in any server: no moderation command can target them (not even a
 * Developer's), anti-nuke never counts, contains or punishes them, and automod, scam protection, raid mode and
 * network bans leave them alone. Kept in the code on purpose, like the trusted bots above.
 */
export const WHITELISTED_PEOPLE: ReadonlyMap<string, string> = new Map([
    ['843909457616044092', 'thesimisear'],
]);

export const isWhitelistedPerson = (id: string | null | undefined): boolean => !!id && WHITELISTED_PEOPLE.has(id);

/** The refusal shown when someone tries to moderate a whitelisted person. */
export const whitelistedMessage = (id: string) => `<@${id}> is whitelisted on Ghost Vanguard, so it won't take any action against them.`;
