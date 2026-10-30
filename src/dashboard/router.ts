import type { Store } from '../database/db.js';
import { VERSION } from '../config.js';
import { logoBytes } from './logo.js';
import { dashboardPage } from './page.js';
import { guildSummary, guilds, incidents, overview, tickets, threats } from './data.js';

/**
 * The dashboard's HTTP surface, as a pure function of (store, method, url, token). The bot mounts this
 * on its health server and `npm run dashboard` serves exactly the same routes on its own, so what you
 * see in a browser is what the bot has: no second copy of anything.
 */

export interface DashboardResponse {
    status: number;
    type: string;
    /** For text and JSON, the document itself; for images, the base64 of the bytes. */
    body: string;
    cache: string;
    /** Set on binary responses so the servers decode `body` before writing it. */
    encoding?: 'base64';
}

export interface DashboardOptions {
    /** Set false to disable the page and API while leaving the liveness probe available. */
    enabled?: boolean;
    /** When set, every route (page and API) needs this token, as ?token= or a bearer header. */
    token?: string;
    now?: () => number;
}

const json = (value: unknown, status = 200): DashboardResponse =>
    ({ status, type: 'application/json; charset=utf-8', body: JSON.stringify(value), cache: 'no-store' });
const text = (body: string, status = 200, type = 'text/plain; charset=utf-8'): DashboardResponse =>
    ({ status, type, body, cache: 'no-store' });

export const normaliseToken = (value?: string | null) => (value ?? '').trim() || undefined;

/**
 * Sent with every dashboard response. The page is read-only and can carry its token in `?token=`, so:
 * never framed (it reaches every server's data), never MIME-sniffed, and never sent as a Referer to
 * anything else the page might reach.
 */
export const DASHBOARD_HEADERS = {
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
} as const;

/** Does this request carry the token? Accepts ?token=, a bearer header, or a cookie set by the page. */
export function tokenAccepted(request: { url: string; headers?: Record<string, string | string[] | undefined> }, token?: string) {
    if (!token)
        return true;
    const url = new URL(request.url, 'http://localhost');
    if (url.searchParams.get('token') === token)
        return true;
    const header = request.headers?.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    if (value && value.replace(/^Bearer\s+/i, '') === token)
        return true;
    const cookie = request.headers?.cookie;
    return (Array.isArray(cookie) ? cookie.join(';') : cookie ?? '').split(';').some(part => part.trim() === `gv_dash=${token}`);
}

export function answer(store: Store, request: { method?: string; url?: string; headers?: Record<string, string | string[] | undefined> }, options: DashboardOptions = {}): DashboardResponse {
    const method = (request.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD')
        return text('Only GET is supported. The dashboard is read-only by design.\n', 405);
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    // /healthz stays open: it is a liveness probe, and it exposes nothing about members.
    if (path === '/healthz')
        return json({ service: 'Ghost Vanguard', version: VERSION, ready: true, dashboard: options.enabled !== false });
    if (options.enabled === false)
        return json({ error: 'Dashboard is disabled.' }, 404);
    // The tab icon and the header badge are the same bytes, inlined into the page and served here
    // for anything that asks for the file directly. Open, like the page: it is art, not data.
    if (path === '/favicon.ico' || path === '/logo.png')
        return { status: 200, type: 'image/png', body: logoBytes().toString('base64'), cache: 'public, max-age=86400', encoding: 'base64' };
    if (!tokenAccepted(request as any, options.token))
        return text('Dashboard token required. Add ?token=… to the URL, or set DASHBOARD_TOKEN.\n', 401);
    const now = options.now?.() ?? Date.now();

    try {
        if (path === '/' || path === '/dashboard')
            return { status: 200, type: 'text/html; charset=utf-8', body: dashboardPage(!!options.token), cache: 'no-store' };
        if (path === '/api/guilds')
            return json(guilds(store));
        if (path === '/api/overview')
            return json(overview(store, now));
        const guildId = url.searchParams.get('id');
        if (path === '/api/guild') {
            if (!guildId || !/^\d{17,20}$/.test(guildId))
                return json({ error: 'Pass ?id=<server id>.' }, 400);
            return json({ ...guildSummary(store, guildId, now), board: threats(store, guildId, now) });
        }
        if (path === '/api/threats') {
            if (!guildId || !/^\d{17,20}$/.test(guildId))
                return json({ error: 'Pass ?id=<server id>.' }, 400);
            return json(threats(store, guildId, now));
        }
        if (path === '/api/tickets') {
            if (!guildId || !/^\d{17,20}$/.test(guildId))
                return json({ error: 'Pass ?id=<server id>.' }, 400);
            return json(tickets(store, guildId, now));
        }
        if (path === '/api/incidents') {
            if (!guildId || !/^\d{17,20}$/.test(guildId))
                return json({ error: 'Pass ?id=<server id>.' }, 400);
            return json(incidents(store, guildId, Number(url.searchParams.get('limit') ?? 25)));
        }
        return json({ error: 'Not found', paths: ['/', '/api/guilds', '/api/overview', '/api/guild?id=', '/api/threats?id=', '/api/tickets?id=', '/api/incidents?id=', '/healthz'] }, 404);
    } catch (error) {
        return json({ error: 'Dashboard read failed', detail: error instanceof Error ? error.message : String(error) }, 500);
    }
}
