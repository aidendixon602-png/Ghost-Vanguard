import { config } from '../config.js';

/**
 * Rules that live only in .env, so nobody can change them from Discord (a restart applies changes).
 *
 * COMMAND_BLACKLIST: who may not use which commands, in every server.
 *   COMMAND_BLACKLIST=111111111111111111:mod ban|network;222222222222222222:*
 *   - entries are separated by `;`, commands by `|`
 *   - a command is what you type in Discord without the slash: `mod ban`, `mod` (everything under /mod), `network genreban`
 *   - `*` blocks every command, button and menu for that person
 *   The bot owner (BOT_OWNER_ID) can never be blocked.
 */
export function parseCommandBlacklist(raw = ''): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const part of raw.split(';')) {
        const m = /^\s*(\d{17,20})\s*[:=]\s*(.+?)\s*$/.exec(part);
        if (!m) continue;
        const commands = m[2]!.split('|').map(c => c.trim().replace(/^\//, '').replace(/\s+/g, ' ').toLowerCase()).filter(Boolean);
        if (commands.length) out.set(m[1]!, [...(out.get(m[1]!) ?? []), ...commands]);
    }
    return out;
}

let cached: { raw: string; map: Map<string, string[]> } | null = null;
const blacklist = () => {
    const raw = process.env.COMMAND_BLACKLIST ?? '';
    if (cached?.raw !== raw) cached = { raw, map: parseCommandBlacklist(raw) };
    return cached.map;
};
export const blacklistSize = () => blacklist().size;

/**
 * The blacklist entry that blocks this person from this command, or null.
 * `shown` is the command as typed in Discord ("mod ban"); null for buttons and menus, which only `*` blocks.
 */
export function blockedBy(userId: string, shown: string | null): string | null {
    if (!userId || userId === config.ownerId) return null;
    const entries = blacklist().get(userId);
    if (!entries) return null;
    for (const entry of entries)
        if (entry === '*' || shown && (shown === entry || shown.startsWith(`${entry} `))) return entry;
    return null;
}

/**
 * PROTECTED_ROLES: role IDs that only PROTECTED_ROLE_ASSIGNERS (and Developers) may give, by any means: /role,
 * the control panel, rejoin restore, or by hand in Discord. Anyone else who gives one has it taken straight back
 * off the member, and you are alerted.
 *   PROTECTED_ROLES=333333333333333333,444444444444444444
 *   PROTECTED_ROLE_ASSIGNERS=111111111111111111,222222222222222222
 */
const ids = (raw = '') => new Set(raw.split(',').map(v => v.trim()).filter(v => /^\d{17,20}$/.test(v)));
export const protectedRoles = () => ids(process.env.PROTECTED_ROLES);
export const protectedRoleAssigners = () => ids(process.env.PROTECTED_ROLE_ASSIGNERS);
export const isProtectedRole = (roleId: string) => protectedRoles().has(roleId);

/**
 * PROTECTED_USERS: people staff can never ban, kick, time out or take roles from, through Vanguard or by hand.
 * Vanguard refuses those commands, and if someone does it by hand in Discord it is undone where Discord allows
 * (unban, timeout lifted, roles given back) and you are alerted. Only Developers can act on them.
 * Anti-nuke still contains a protected person who sets it off (a protected account can still be hacked).
 *   PROTECTED_USERS=111111111111111111,222222222222222222
 */
export const protectedUsers = () => ids(process.env.PROTECTED_USERS);
export const isProtectedUser = (userId: string) => protectedUsers().has(userId);

/**
 * ANTINUKE_LOCK=true: anti-nuke can't be weakened from Discord. Only Developers can turn it off or change the
 * extra protection layers, and servers someone switched off are switched back on at every start.
 */
export const antinukeLocked = () => /^(1|true|yes|on)$/i.test(process.env.ANTINUKE_LOCK?.trim() ?? '');
/** Commands that weaken anti-nuke; with ANTINUKE_LOCK only Developers may use them. */
export const ANTINUKE_LOCK_KEYS = new Set(['antinuke/disable', 'disable', 'antinuke-plus/settings']);

/** GLOBAL_ALERT_CHANNEL_ID: the global anti-nuke feed channel, fixed in .env (overrides `/dev alerts`). */
export const envGlobalAlertChannel = () => /^\d{17,20}$/.test(process.env.GLOBAL_ALERT_CHANNEL_ID?.trim() ?? '') ? process.env.GLOBAL_ALERT_CHANNEL_ID!.trim() : null;

/**
 * ALERT_EXEMPT=true: also post alerts and DMs when someone anti-nuke never punishes (the server owner,
 * Developers, whitelisted people) hits a limit. Off by default: those are recorded quietly in
 * `/antinuke incidents`, so whitelisted staff doing their job don't flood the logs.
 */
export const alertExempt = () => /^(1|true|yes|on)$/i.test(process.env.ALERT_EXEMPT?.trim() ?? '');
