import { createServer } from 'node:http';
import { config } from '../config.js';
import { Store } from '../database/db.js';
import { answer, DASHBOARD_HEADERS } from './router.js';

/**
 * Standalone dashboard: `npm run dashboard` (or `node dist/dashboard/server.js`).
 *
 * It reads the same SQLite file the bot writes, so it shows exactly what the bot has without starting
 * Discord. Handy for a host panel, a second machine, or a quick look when the bot is offline.
 *
 *   --db <path>    database file (default: DATABASE_PATH or ./data/vanguard.db)
 *   --port <n>     port (default: DASHBOARD_PORT or HEALTH_PORT or 7475)
 *   --host <addr>  address to bind (default: DASHBOARD_HOST or 127.0.0.1)
 *
 * Access control: set DASHBOARD_TOKEN (or --token) to require ?token=… / a bearer header. Without a
 * token the dashboard is open to whoever can reach the port, so keep it on localhost unless the host
 * puts it behind its own login.
 */

export interface ServerOptions { dbPath: string; port: number; host: string; token?: string }

export function parseOptions(args: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): ServerOptions {
    const value = (flag: string) => {
        const index = args.indexOf(flag);
        return index >= 0 && args[index + 1] && !args[index + 1]!.startsWith('--') ? args[index + 1] : undefined;
    };
    return {
        dbPath: value('--db') ?? env.DATABASE_PATH ?? './data/vanguard.db',
        port: Number(value('--port') ?? env.DASHBOARD_PORT ?? env.HEALTH_PORT ?? 7475),
        host: value('--host') ?? env.DASHBOARD_HOST ?? '127.0.0.1',
        token: (value('--token') ?? env.DASHBOARD_TOKEN ?? '').trim() || undefined,
    };
}

export function startDashboard(options: ServerOptions, database = new Store(options.dbPath)) {
    const server = createServer((request, response) => {
        const result = answer(database, request, { token: options.token });
        response.writeHead(result.status, { 'Content-Type': result.type, 'Cache-Control': result.cache, 'X-Robots-Tag': 'noindex', ...DASHBOARD_HEADERS });
        const payload = result.encoding === 'base64' ? Buffer.from(result.body, 'base64') : result.body;
        response.end(request.method === 'HEAD' ? undefined : payload);
    });
    return { server, database };
}

/** Run it when this file is the entry point, not when a test imports it. */
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    const options = parseOptions();
    const { server, database } = startDashboard(options);
    server.listen(options.port, options.host, () => {
        console.log(`Ghost Vanguard dashboard: http://${options.host === '0.0.0.0' ? 'localhost' : options.host}:${options.port}/${options.token ? '?token=…' : ''}`);
        console.log(`Reading ${options.dbPath}${options.token ? ' · DASHBOARD_TOKEN required' : ' · no token set (keep it on localhost or set DASHBOARD_TOKEN)'}`);
    });
    const close = () => { server.close(); database.close(); process.exit(0); };
    process.on('SIGINT', close);
    process.on('SIGTERM', close);
    void config;
}
