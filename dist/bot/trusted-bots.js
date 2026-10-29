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
