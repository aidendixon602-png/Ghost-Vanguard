import '../config.js';
/**
 * Bots Vanguard always trusts, in every server: the other bots in this network, run by the same people.
 *
 * Vanguard leaves their actions alone exactly as it leaves its own: anti-nuke never counts, alerts on or punishes
 * them, the settings lock and protected-role guards don't undo what they do, and they are not held for approval
 * when they join. Only list bots you run yourself: a trusted bot whose token leaks could act in any server without
 * anti-nuke stepping in.
 *
 * Nothing is built in. Set them in .env and restart:
 *   TRUSTED_BOTS=1563480035493417021:Veil Utilities;1563480035493417022:Other Bot
 * An entry without a name is reported as "unnamed bot" at startup.
 */
export function parseTrustedBots(raw = '') {
    const out = new Map();
    for (const part of raw.split(/[;,]/)) {
        const match = /^\s*(\d{17,20})(?:\s*[:=]\s*(.+?))?\s*$/.exec(part);
        if (!match)
            continue;
        out.set(match[1], (match[2] ?? 'unnamed bot').slice(0, 80));
    }
    return out;
}
let cached = null;
/** Read from the environment on every call, so a changed .env (or a test) is never served a stale list. */
export function trustedBots() {
    const raw = process.env.TRUSTED_BOTS ?? '';
    if (cached?.raw !== raw)
        cached = { raw, map: parseTrustedBots(raw) };
    return cached.map;
}
export const isTrustedBot = (id) => !!id && trustedBots().has(id);
/** The name given to a trusted bot in .env, for alerts that name who was left alone. */
export const trustedBotName = (id) => id ? trustedBots().get(id) : undefined;
/**
 * Confirm at startup that each trusted ID really is the bot it is named as, and say the account name out
 * loud. These IDs are exempt from anti-nuke in every server, so a stale or mistyped ID must be visible
 * in the startup summary.
 */
export async function trustedBotReport(client) {
    const lines = [];
    for (const [id, name] of trustedBots()) {
        const user = await client.users.fetch(id).catch(() => null);
        if (!user)
            lines.push(`⚠ Trusted bot **${name}** (${id}) could not be fetched. If that ID is wrong, fix or remove it in TRUSTED_BOTS; the entry is exempt from anti-nuke.`);
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
