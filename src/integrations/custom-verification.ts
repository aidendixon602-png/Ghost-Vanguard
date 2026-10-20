import { randomBytes } from 'node:crypto';
import type { Store } from '../database/db.js';
import { AppError } from '../errors.js';
import { robloxUser, robloxUserByName } from './roblox-api.js';

/**
 * Custom Roblox verification via profile description code.
 * No Bloxlink/RoVer — fully self-hosted.
 *
 * Flow:
 *  1. User runs /verify username: <name>
 *  2. Bot generates code like VG-AB12CD, stores pending row
 *  3. User adds code to Roblox profile blurb (https://www.roblox.com/users/<id>/profile)
 *  4. User clicks Confirm button or runs /verify again → bot fetches profile description, checks code present
 *  5. On success, link is written to `links` and verified role + group sync happen in Roblox.sync
 */

export const PENDING_TTL_MS = 15 * 60 * 1000; // 15 min
export const CODE_PREFIX = 'VG-';

function makeCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 to avoid confusion
    let out = CODE_PREFIX;
    const bytes = randomBytes(6);
    for (let i = 0; i < 6; i++) out += chars[bytes[i]! % chars.length]!;
    return out;
}

export interface Pending {
    guild_id: string;
    user_id: string;
    roblox_id: string;
    roblox_name: string;
    code: string;
    created_at: number;
}

export function getPending(store: Store, guildId: string, discordId: string): Pending | undefined {
    return store.get('SELECT * FROM verification_pending WHERE guild_id=? AND user_id=?', guildId, discordId) as Pending | undefined;
}

export function clearPending(store: Store, guildId: string, discordId: string): void {
    store.run('DELETE FROM verification_pending WHERE guild_id=? AND user_id=?', guildId, discordId);
}

export function pruneExpired(store: Store): void {
    store.run('DELETE FROM verification_pending WHERE created_at < ?', Date.now() - PENDING_TTL_MS);
}

export async function createPending(store: Store, guildId: string, discordId: string, username: string): Promise<Pending> {
    pruneExpired(store);
    // Rate limit: 3 attempts per 15 min per user
    const recent = store.get('SELECT COUNT(*) as c FROM verification_pending WHERE user_id=? AND created_at > ?', discordId, Date.now() - PENDING_TTL_MS) as any;
    // Actually pending is per guild+user, so just check if they spammed creation — we allow overwrite but throttle
    const existing = getPending(store, guildId, discordId);
    if (existing && Date.now() - existing.created_at < 30_000) {
        throw new AppError('VALIDATION_ERROR', `You're doing that too fast. Wait 30s and try again. Your current code is \`${existing.code}\` — add it to your Roblox bio first.`);
    }
    const roblox = await robloxUserByName(username);
    if (!roblox) throw new AppError('VALIDATION_ERROR', `No Roblox account found for **${username}**. Check the spelling — usernames are exact, not display names.`);
    const code = makeCode();
    store.run('INSERT OR REPLACE INTO verification_pending(guild_id,user_id,roblox_id,roblox_name,code,created_at) VALUES(?,?,?,?,?,?)',
        guildId, discordId, roblox.id, roblox.name, code, Date.now());
    return { guild_id: guildId, user_id: discordId, roblox_id: roblox.id, roblox_name: roblox.name, code, created_at: Date.now() };
}

export async function confirmPending(store: Store, guildId: string, discordId: string): Promise<Pending & { verified: boolean; description: string }> {
    const pending = getPending(store, guildId, discordId);
    if (!pending) throw new AppError('VALIDATION_ERROR', 'You have no pending verification. Run `/verify username: YourRobloxName` first to get a code.');
    if (Date.now() - pending.created_at > PENDING_TTL_MS) {
        clearPending(store, guildId, discordId);
        throw new AppError('VALIDATION_ERROR', 'Your verification code expired (15 min). Run `/verify` again to get a new code.');
    }
    const profile = await robloxUser(pending.roblox_id);
    if (!profile) throw new AppError('INTEGRATION_ERROR', 'Could not fetch your Roblox profile. Try again in a moment.');
    const desc = String(profile.description ?? '');
    const hasCode = desc.includes(pending.code);
    if (!hasCode) {
        throw new AppError('VALIDATION_ERROR',
            `Code \`${pending.code}\` not found in your Roblox profile description.\n\n` +
            `**Fix:**\n` +
            `1. Open https://www.roblox.com/users/${pending.roblox_id}/profile\n` +
            `2. Click Edit (pencil) → add \`${pending.code}\` anywhere in your About / blurb\n` +
            `3. Save → wait 5-10s → click **Verify** again.\n\n` +
            `-# You can remove the code after verifying.`);
    }
    return { ...pending, verified: true, description: desc };
}

export function linkAccount(store: Store, guildId: string, discordId: string, robloxId: string, robloxName: string): void {
    store.run('INSERT INTO links(guild_id,user_id,roblox_id,username,synced) VALUES(?,?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET roblox_id=excluded.roblox_id, username=excluded.username, synced=excluded.synced',
        guildId, discordId, robloxId, robloxName, Date.now());
    clearPending(store, guildId, discordId);
}

export function unlinkAccount(store: Store, guildId: string, discordId: string): boolean {
    const row = store.get('SELECT 1 FROM links WHERE guild_id=? AND user_id=?', guildId, discordId);
    store.run('DELETE FROM links WHERE guild_id=? AND user_id=?', guildId, discordId);
    clearPending(store, guildId, discordId);
    return !!row;
}

export function getLink(store: Store, guildId: string, discordId: string): { roblox_id: string; username: string } | null {
    const row = store.get('SELECT roblox_id, username FROM links WHERE guild_id=? AND user_id=?', guildId, discordId) as any;
    return row ? { roblox_id: String(row.roblox_id), username: String(row.username ?? '') } : null;
}
