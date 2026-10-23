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
