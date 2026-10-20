import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { readableSize, style } from './console-ui.js';
export class AppError extends Error {
    category;
    constructor(category, message, options) {
        super(message, options);
        this.category = category;
    }
}
export function redact(value) {
    for (const secret of [config.token, config.roverKey, config.bloxlinkKey, config.openaiKey, process.env.DATABASE_URL].filter(Boolean))
        value = value.split(secret).join('[REDACTED]');
    return value.replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/g, '[PRIVATE KEY REDACTED]').replace(/(authorization)\s*[=:]\s*(?:(?:Bearer|Bot)\s+)?[^\r\n,;]+/gi, '$1=[REDACTED]').replace(/(authorization|token|api[_-]?key|password|secret)\s*[=:]\s*[^\s,;]+/gi, '$1=[REDACTED]')
        .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/https?:\/\/[^\s)]+/gi, '[URL REDACTED]')
        .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[DATABASE URL REDACTED]');
}
export function failure(error) {
    const reference = `MV-CMD-${randomBytes(6).toString('hex').toUpperCase()}`;
    const category = error instanceof AppError ? error.category : error instanceof Error && (/sqlite/i.test(error.name + error.message) || 'code' in error && /^ERR_SQLITE/.test(String(error.code))) ? 'DATABASE_ERROR' : typeof error === 'object' && error && 'code' in error ? 'DISCORD_API_ERROR' : 'INTERNAL_ERROR';
    return { reference, category, message: error instanceof AppError ? error.message : 'Ghost Vanguard could not complete this action.',
        details: redact(error instanceof Error ? [error.stack || error.message, error.cause instanceof Error ? error.cause.stack : ''].filter(Boolean).join('\nCaused by: ') : String(error)) };
}
function sanitize(value) {
    if (typeof value === 'string')
        return redact(value);
    if (Array.isArray(value))
        return value.map(sanitize);
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(authorization|token|api[_-]?key|password|secret|headers)$/i.test(key) ? '[REDACTED]' : sanitize(item)]));
    return value;
}
// Routine startup lines that the startup summary already shows (pretty format only).
const STARTUP_SUMMARY_EVENTS = new Set(['server_initialized', 'command_sync', 'ready', 'integrations', 'health_listening']);
let summarizingStartup = true;
/** Called once the startup summary has been printed; later events are logged normally. */
export function endStartupSummary() {
    summarizingStartup = false;
}
const LEVEL_STYLE = { ERROR: style.red, WARN: style.yellow, INFO: style.cyan, DEBUG: style.dim };
/** One symbol per level, so a scan of the console shows problems at a glance. */
const LEVEL_MARK = { ERROR: '✖ ERROR', WARN: '⚠ WARN ', INFO: '• INFO ', DEBUG: '· DEBUG' };
const sentence = (event) => { const text = event.replaceAll('_', ' '); return text[0].toUpperCase() + text.slice(1); };
/**
 * Events with their own short, readable layout. Roles above the bot are grouped under one heading
 * with the fix written once, instead of a wall of key=value warnings.
 */
let attentionHeader = false;
const SPECIAL_LINES = {
    protection_warning: e => {
        const lines = [];
        if (!attentionHeader) {
            attentionHeader = true;
            lines.push('', `  ${style.yellow('⚠ Roles above the bot')}  ${style.dim('unprotected roles are out of reach; bypassed roles are exempt · check /antinuke check')}`);
        }
        const above = Array.isArray(e.rolesAboveBot) && e.rolesAboveBot.length ? e.rolesAboveBot.join(', ') : '';
        const bypassed = Array.isArray(e.bypassedRolesAboveBot) && e.bypassedRolesAboveBot.length ? style.dim(`bypassed/exempt: ${e.bypassedRolesAboveBot.join(', ')}`) : '';
        const missing = Array.isArray(e.missingPermissions) && e.missingPermissions.length ? style.yellow(`bot is missing ${e.missingPermissions.join(', ')}`) : '';
        lines.push(`    ${style.yellow('•')} ${style.bold(String(e.server ?? '?'))} ${style.dim('—')} ${[above, bypassed, missing].filter(Boolean).join(' · ')}`);
        return lines;
    },
    database_backup_verified: e => [`  ${style.green('✔')} Database backup saved ${style.dim(`· ${e.kind ?? 'backup'} · ${typeof e.size === 'number' ? readableSize(e.size) : '?'}`)}`],
};
export function logEvent(event, fields = {}) {
    const sanitized = sanitize({ timestamp: new Date().toISOString(), event, ...fields });
    const level = /fail|error|exception/.test(event) ? 'ERROR' : /unavailable|unverified|retry|pending|warning/.test(event) ? 'WARN' : event === 'command_activity' ? 'DEBUG' : 'INFO';
    const ranks = { debug: 0, info: 1, warn: 2, error: 3 };
    if ((ranks[level.toLowerCase()] ?? 1) < (ranks[config.logLevel] ?? 1))
        return;
    if (config.logFormat === 'json') {
        console.log(JSON.stringify(sanitized));
        return;
    }
    if (summarizingStartup && level === 'INFO' && STARTUP_SUMMARY_EVENTS.has(event))
        return;
    const special = SPECIAL_LINES[event]?.(sanitized);
    if (special) {
        for (const line of special)
            console.log(line);
        return;
    }
    // Under launch.js the host panel already stamps every line, so a second (differently zoned) clock only confuses.
    const time = typeof process.send === 'function' ? '' : `${style.dim(new Date().toLocaleTimeString('en-US', { hour12: false }))}  `;
    const { timestamp, details, error, ...values } = sanitized;
    const shown = (key, value) => key === 'size' && typeof value === 'number' ? readableSize(value)
        : typeof value === 'object' ? JSON.stringify(value) : String(value);
    const body = Object.entries(values).filter(([k]) => k !== 'event').map(([k, v]) => `${style.dim(`${k}=`)}${shown(k, v)}`).join(style.dim(' · '));
    console.log(`${time}${(LEVEL_STYLE[level] ?? String)(LEVEL_MARK[level] ?? level)}  ${style.bold(sentence(event))}${body ? style.dim(' · ') + body : ''}`);
    const fullDetails = config.logLevel === 'debug' || event === 'command_load_failure';
    if ((details || error) && !(fullDetails && details))
        console.log(`       ${String(details ?? error).split('\n')[0]}`);
    if (fullDetails && details)
        console.log(String(details));
}
