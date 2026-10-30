/**
 * Bots Vanguard always trusts, in every server: the other bots in this network, run by the same people.
 *
 * Vanguard leaves their actions alone exactly as it leaves its own: anti-nuke never counts, alerts on or punishes
 * them, the settings lock and protected-role guards don't undo what they do, and they are not held for approval
 * when they join. Only list bots you run yourself: a trusted bot whose token leaks could act in any server without
 * anti-nuke stepping in.
 */
export const TRUSTED_BOTS = new Map([
    ['1563480035493417021', 'Veil Utilities'],
]);
export const isTrustedBot = (id) => !!id && TRUSTED_BOTS.has(id);
/**
 * Confirm at startup that each trusted ID really is the bot it is named as, and say the account name out
 * loud. These IDs are exempt from anti-nuke in every server and are the only accounts whose reaction can
 * hand a `,gv` command over, so a stale or mistyped ID otherwise fails silently: the hand-off just never
 * happens, and the bot cannot see why. The returned lines are for the startup summary.
 */
export async function trustedBotReport(client) {
    const lines = [];
    for (const [id, name] of TRUSTED_BOTS) {
        const user = await client.users.fetch(id).catch(() => null);
        if (!user)
            lines.push(`⚠ Trusted bot **${name}** (${id}) could not be fetched. If that ID is wrong, \`,gv\` commands never work: it must be Veil Utilities' application ID.`);
        else if (!user.bot)
            lines.push(`⚠ TRUSTED_BOTS lists ${id} as **${name}**, but that account is a user, not a bot. Remove it: it is exempt from anti-nuke in every server.`);
        else
            lines.push(`Trusted bot ${name}: @${user.username} (${id})`);
    }
    return lines;
}
/**
 * People no part of Vanguard ever acts against, in any server: no moderation command can target them (not even a
 * Developer's), anti-nuke never counts, contains or punishes them, and automod, scam protection, raid mode and
 * network bans leave them alone. Kept in the code on purpose, like the trusted bots above.
 */
export const WHITELISTED_PEOPLE = new Map([
    ['843909457616044092', 'thesimisear'],
]);
export const isWhitelistedPerson = (id) => !!id && WHITELISTED_PEOPLE.has(id);
/** The refusal shown when someone tries to moderate a whitelisted person. */
export const whitelistedMessage = (id) => `<@${id}> is whitelisted on Ghost Vanguard, so it won't take any action against them.`;
