import { PRODUCT_NAME_UPPER } from './branding.js';
// Human-friendly console output for the default "pretty" log format.
// JSON logging (LOG_FORMAT=json) never goes through here.
// Colors only in a real terminal; NO_COLOR turns them off, FORCE_COLOR turns them on.
const useColor = !process.env.NO_COLOR && (!!process.env.FORCE_COLOR || !!process.stdout.isTTY);
const paint = (code) => (text) => useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
export const style = {
    bold: paint('1'),
    dim: paint('2'),
    red: paint('31'),
    green: paint('32'),
    yellow: paint('33'),
    cyan: paint('36'),
};
const RULE = '─'.repeat(48);
const detail = (label, value) => `  ${style.dim(label.padEnd(13))} ${value}`;
/** 393216 -> "384 KB". */
export function readableSize(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024, unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
/** 4200 -> "4.2 s", 350 -> "350 ms". */
export function readableDuration(ms) {
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
/** A compact status summary printed once the bot is connected and ready. */
export function startupSummary(info) {
    const integrations = Object.entries(info.integrations)
        .map(([name, on]) => on ? `${name} ${style.green('ON')}` : `${name} ${style.dim('off')}`).join('  ·  ');
    const servers = info.servers > 0 ? `${info.servers} connected` : style.yellow('not in any servers yet');
    const authorized = info.authorized === undefined ? '' : info.authorized === info.servers
        ? `  ·  ${info.authorized} authorized`
        : `  ·  ${info.authorized} authorized  ·  ${style.yellow(`${info.servers - info.authorized} not authorized yet`)}`;
    const commandState = info.commandsUpdated ? style.yellow('updated on Discord') : style.green('up to date');
    const readyIn = info.startedInMs === undefined ? '' : `  ${style.dim('·')}  ready in ${readableDuration(info.startedInMs)}`;
    return [
        '',
        `  ${style.bold(PRODUCT_NAME_UPPER)}  ${style.dim(`v${info.version}`)}`,
        `  ${style.green('SYSTEM ONLINE')}  ${style.dim('·')}  ${info.tag}${readyIn}`,
        `  ${style.dim(RULE)}`,
        detail('Servers', servers + authorized),
        ...(info.members ? [detail('Members', `${info.members.toLocaleString('en-US')} across authorized servers`)] : []),
        detail('Commands', `${info.commands} registered  ·  ${commandState}`),
        detail('Verification', info.verification),
        detail('Integrations', integrations),
        ...(info.database ? [detail('Database', info.database)] : []),
        ...(info.backups ? [detail('Backups', info.backups)] : []),
        ...(info.dashboard ? [detail('Dashboard', info.dashboard)] : []),
        detail('Health', info.health),
        ...(info.runtime ? [detail('Runtime', info.runtime)] : []),
        '',
    ];
}
export const closingRule = () => `  ${style.dim(RULE)}`;
