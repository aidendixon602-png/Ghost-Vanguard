import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../src/database/db.js';
import { authorize } from './helpers.js';
import { OAUTH_TTL_MS, completeOAuthRequest, createOAuthRequest, linkOAuthResult, oauthConfig } from '../src/integrations/roblox-oauth.js';

const G = '123456789012345678', U = '234567890123456789';
const config = { clientId: 'client-1', clientSecret: 'secret-1', redirectUri: 'https://vanguard.example/oauth/roblox/callback' };

function fixture() {
    const store = new Store(':memory:'); authorize(store, G);
    return store;
}
const stateOf = (url: string) => new URL(url).searchParams.get('state')!;
const verifierOf = (store: Store, state: string) => (store.get('SELECT code_verifier FROM verification_oauth WHERE state=?', state) as any).code_verifier as string;

/** A fake Roblox: token exchange and userinfo. Records what was sent. */
function fakeRoblox(opts: { tokenOk?: boolean; sub?: unknown; username?: string } = {}) {
    const calls: { url: string; init: any }[] = [];
    const fetchImpl = (async (url: string, init: any) => {
        calls.push({ url, init });
        if (String(url).endsWith('/token'))
            return opts.tokenOk === false ? new Response('nope', { status: 400 }) : new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
        return new Response(JSON.stringify({ sub: opts.sub ?? '1516563360', preferred_username: opts.username ?? 'exampleuser' }), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
}

test('website sign-in is only offered when the Roblox OAuth settings are complete and HTTPS', () => {
    assert.equal(oauthConfig({} as any), null);
    assert.equal(oauthConfig({ ROBLOX_OAUTH_CLIENT_ID: 'a', ROBLOX_OAUTH_CLIENT_SECRET: 'b', PUBLIC_BASE_URL: 'http://insecure.example' } as any), null);
    const cfg = oauthConfig({ ROBLOX_OAUTH_CLIENT_ID: ' a ', ROBLOX_OAUTH_CLIENT_SECRET: 'b', PUBLIC_BASE_URL: 'https://vanguard.example/' } as any);
    assert.deepEqual(cfg, { clientId: 'a', clientSecret: 'b', redirectUri: 'https://vanguard.example/oauth/roblox/callback' });
});

test('the sign-in link carries the client, scopes, a one-time state and a matching PKCE challenge', () => {
    const store = fixture();
    try {
        const url = new URL(createOAuthRequest(store, config, G, U));
        assert.equal(url.origin + url.pathname, 'https://apis.roblox.com/oauth/v1/authorize');
        assert.equal(url.searchParams.get('client_id'), 'client-1');
        assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
        assert.equal(url.searchParams.get('scope'), 'openid profile');
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
        const state = stateOf(url.toString());
        const expected = createHash('sha256').update(verifierOf(store, state)).digest('base64url');
        assert.equal(url.searchParams.get('code_challenge'), expected);
    } finally { store.close(); }
});

test('a new sign-in replaces the member\'s earlier one, so only the latest state works', async () => {
    const store = fixture();
    try {
        const first = stateOf(createOAuthRequest(store, config, G, U));
        const second = stateOf(createOAuthRequest(store, config, G, U));
        const { fetchImpl } = fakeRoblox();
        await assert.rejects(completeOAuthRequest(store, config, new URLSearchParams({ state: first, code: 'c' }), fetchImpl), /expired or was already used/);
        const ok = await completeOAuthRequest(store, config, new URLSearchParams({ state: second, code: 'c' }), fetchImpl);
        assert.equal(ok.userId, U);
    } finally { store.close(); }
});

test('a successful return exchanges the code with PKCE, reads the Roblox account and links it', async () => {
    const store = fixture();
    try {
        const state = stateOf(createOAuthRequest(store, config, G, U));
        const verifier = verifierOf(store, state);
        const { fetchImpl, calls } = fakeRoblox();
        const result = await completeOAuthRequest(store, config, new URLSearchParams({ state, code: 'abc' }), fetchImpl);
        assert.deepEqual(result, { guildId: G, userId: U, robloxId: '1516563360', username: 'exampleuser' });
        const token = calls[0]!;
        assert.equal(token.url, 'https://apis.roblox.com/oauth/v1/token');
        assert.equal(token.init.headers.Authorization, `Basic ${Buffer.from('client-1:secret-1').toString('base64')}`);
        const body = new URLSearchParams(token.init.body);
        assert.equal(body.get('code'), 'abc');
        assert.equal(body.get('code_verifier'), verifier);
        assert.equal(body.get('redirect_uri'), config.redirectUri);
        assert.equal(calls[1]!.url, 'https://apis.roblox.com/oauth/v1/userinfo');
        assert.equal(calls[1]!.init.headers.Authorization, 'Bearer tok');

        linkOAuthResult(store, result);
        const link = store.get('SELECT roblox_id, username FROM links WHERE guild_id=? AND user_id=?', G, U) as any;
        assert.deepEqual({ ...link }, { roblox_id: '1516563360', username: 'exampleuser' });
    } finally { store.close(); }
});

test('a return can be used only once, and an expired one is refused', async () => {
    const store = fixture();
    try {
        const state = stateOf(createOAuthRequest(store, config, G, U));
        const { fetchImpl } = fakeRoblox();
        await completeOAuthRequest(store, config, new URLSearchParams({ state, code: 'c' }), fetchImpl);
        await assert.rejects(completeOAuthRequest(store, config, new URLSearchParams({ state, code: 'c' }), fetchImpl), /expired or was already used/);

        const later = stateOf(createOAuthRequest(store, config, G, U, 1_000));
        await assert.rejects(completeOAuthRequest(store, config, new URLSearchParams({ state: later, code: 'c' }), fetchImpl, 1_000 + OAUTH_TTL_MS + 1), /expired or was already used/);
    } finally { store.close(); }
});

test('cancelled sign-ins, missing codes, failed token exchanges and malformed accounts are refused without linking', async () => {
    const store = fixture();
    try {
        const cancelled = stateOf(createOAuthRequest(store, config, G, U));
        await assert.rejects(completeOAuthRequest(store, config, new URLSearchParams({ state: cancelled, error: 'access_denied' }), fakeRoblox().fetchImpl), /cancelled/);
        assert.equal(store.get('SELECT 1 FROM verification_oauth WHERE state=?', cancelled), undefined, 'the state is spent even when cancelled');

        const noCode = stateOf(createOAuthRequest(store, config, G, U));
        await assert.rejects(completeOAuthRequest(store, config, new URLSearchParams({ state: noCode }), fakeRoblox().fetchImpl), /did not return a sign-in code/);

        const badToken = stateOf(createOAuthRequest(store, config, G, U));
        await assert.rejects(completeOAuthRequest(store, config, new URLSearchParams({ state: badToken, code: 'c' }), fakeRoblox({ tokenOk: false }).fetchImpl), /would not confirm/);

        const badSub = stateOf(createOAuthRequest(store, config, G, U));
        await assert.rejects(completeOAuthRequest(store, config, new URLSearchParams({ state: badSub, code: 'c' }), fakeRoblox({ sub: 'abc' }).fetchImpl), /did not return an account/);

        assert.equal(store.get('SELECT 1 FROM links WHERE guild_id=? AND user_id=?', G, U), undefined);
    } finally { store.close(); }
});
