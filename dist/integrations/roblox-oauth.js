import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';
import { linkAccount } from './custom-verification.js';
/**
 * "Verify with Roblox" website sign-in (OAuth 2.0 + PKCE), the Bloxlink-style alternative to the code-in-bio flow.
 *
 * Setup (operator): create a Roblox OAuth app at https://create.roblox.com/dashboard/credentials with the
 * `openid` and `profile` scopes and the redirect URL `<PUBLIC_BASE_URL>/oauth/roblox/callback`, then set
 * ROBLOX_OAUTH_CLIENT_ID, ROBLOX_OAUTH_CLIENT_SECRET and PUBLIC_BASE_URL (https). Until all three are set the
 * button is not shown and /verify keeps the code-in-bio flow only.
 *
 * Flow: /verify creates a one-time state (plus a PKCE verifier) for the member and shows a link button to
 * Roblox. Roblox redirects back with a code; the callback checks the state, exchanges the code, reads the Roblox
 * user ID (`sub`) and username from userinfo, then links the account and syncs roles exactly as code verification does.
 */
export const OAUTH_TTL_MS = 10 * 60 * 1000;
export const AUTHORIZE_URL = 'https://apis.roblox.com/oauth/v1/authorize';
export const TOKEN_URL = 'https://apis.roblox.com/oauth/v1/token';
export const USERINFO_URL = 'https://apis.roblox.com/oauth/v1/userinfo';
export const CALLBACK_PATH = '/oauth/roblox/callback';
/** The OAuth settings from the environment, or null when website verification is not configured. */
export function oauthConfig(env = process.env) {
    const clientId = env.ROBLOX_OAUTH_CLIENT_ID?.trim();
    const clientSecret = env.ROBLOX_OAUTH_CLIENT_SECRET?.trim();
    const base = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '');
    if (!clientId || !clientSecret || !base || !/^https:\/\//i.test(base))
        return null;
    return { clientId, clientSecret, redirectUri: `${base}${CALLBACK_PATH}` };
}
const base64url = (buffer) => buffer.toString('base64url');
/** Create a one-time sign-in for this member (replacing any earlier one) and return the Roblox sign-in URL. */
export function createOAuthRequest(store, config, guildId, userId, now = Date.now()) {
    store.run('DELETE FROM verification_oauth WHERE created_at < ?', now - OAUTH_TTL_MS);
    store.run('DELETE FROM verification_oauth WHERE guild_id=? AND user_id=?', guildId, userId);
    const state = base64url(randomBytes(32));
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    store.run('INSERT INTO verification_oauth(guild_id,user_id,state,code_verifier,created_at) VALUES(?,?,?,?,?)', guildId, userId, state, verifier, now);
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: 'code',
        scope: 'openid profile',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
    }).toString();
    return url.toString();
}
const fail = (message) => new AppError('VALIDATION_ERROR', message);
/**
 * Finish a sign-in from the callback query string. The state is single-use: it is removed whether or not the
 * sign-in succeeds. `fetchImpl` is injectable for tests.
 */
export async function completeOAuthRequest(store, config, query, fetchImpl = fetch, now = Date.now()) {
    const state = query.get('state') ?? '';
    const row = state ? store.get('SELECT * FROM verification_oauth WHERE state=?', state) : undefined;
    if (state)
        store.run('DELETE FROM verification_oauth WHERE state=?', state);
    if (!row || row.created_at < now - OAUTH_TTL_MS)
        throw fail('This verification link has expired or was already used. Run `/verify` again to get a new one.');
    if (query.has('error'))
        throw fail('Roblox sign-in was cancelled. Run `/verify` again when you are ready.');
    const code = query.get('code');
    if (!code)
        throw fail('Roblox did not return a sign-in code. Run `/verify` again.');
    const token = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
        },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri, code_verifier: row.code_verifier }),
        signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    const tokenBody = token?.ok ? await token.json().catch(() => null) : null;
    if (!tokenBody?.access_token)
        throw fail('Roblox would not confirm the sign-in. Try `/verify` again in a moment.');
    const info = await fetchImpl(USERINFO_URL, {
        headers: { Authorization: `Bearer ${tokenBody.access_token}` },
        signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    const user = info?.ok ? await info.json().catch(() => null) : null;
    const robloxId = String(user?.sub ?? '');
    const username = typeof user?.preferred_username === 'string' ? user.preferred_username : '';
    if (!/^\d{1,20}$/.test(robloxId) || !username)
        throw fail('Roblox did not return an account. Try `/verify` again.');
    return { guildId: row.guild_id, userId: row.user_id, robloxId, username };
}
/** Save the verified account link (the caller then syncs roles and nickname). */
export function linkOAuthResult(store, result) {
    linkAccount(store, result.guildId, result.userId, result.robloxId, result.username);
}
export const page = (title, message) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><body style="font-family:system-ui,sans-serif;background:#0b1220;color:#e5e7eb;display:grid;place-items:center;min-height:100vh;margin:0"><main style="max-width:32rem;padding:2rem;text-align:center"><h1 style="color:#67e8f9;font-size:1.4rem">${title}</h1><p>${message}</p></main></body>`;
export const escapeHtml = (s) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
