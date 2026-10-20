import { createServer } from 'node:http';
import { config } from '../config.js';
import { Store } from '../database/db.js';
import { answer } from './router.js';
export function parseOptions(args = process.argv.slice(2), env = process.env) {
    const value = (flag) => {
        const index = args.indexOf(flag);
        return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : undefined;
    };
    return {
        dbPath: value('--db') ?? env.DATABASE_PATH ?? './data/vanguard.db',
        port: Number(value('--port') ?? env.DASHBOARD_PORT ?? env.HEALTH_PORT ?? 7475),
        host: value('--host') ?? env.DASHBOARD_HOST ?? '127.0.0.1',
        token: (value('--token') ?? env.DASHBOARD_TOKEN ?? '').trim() || undefined,
    };
}
export function startDashboard(options, database = new Store(options.dbPath)) {
    const server = createServer((request, response) => {
        const result = answer(database, request, { token: options.token });
        response.writeHead(result.status, { 'Content-Type': result.type, 'Cache-Control': result.cache, 'X-Robots-Tag': 'noindex' });
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
