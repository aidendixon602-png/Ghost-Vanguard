// Human-friendly console output for the default "pretty" log format.
// JSON logging (LOG_FORMAT=json) never goes through here.
// Colors only in a real terminal; NO_COLOR turns them off, FORCE_COLOR turns them on.
const useColor = !process.env.NO_COLOR && (!!process.env.FORCE_COLOR || !!process.stdout.isTTY);
const paint = (code: string) => (text: string) => useColor ? `\x1b[${code}m${text}\x1b[0m` : text;

export const style = {
    bold: paint('1'),
    dim: paint('2'),
    red: paint('31'),
    green: paint('32'),
    yellow: paint('33'),
    cyan: paint('36'),
};

const RULE = '━'.repeat(60);
const PANEL_WIDTH = 72;
const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, '');
const visibleLength = (value: string) => Array.from(stripAnsi(value)).length;
const frame = (top: string, fill: string, end: string) => style.cyan(`  ${top}${fill.repeat(PANEL_WIDTH + 2)}${end}`);
const panelRow = (content: string) => `  │ ${content}${' '.repeat(Math.max(0, PANEL_WIDTH - visibleLength(content)))} │`;
const detail = (label: string, value: string) => panelRow(`${style.cyan(label.padEnd(10))} ${value}`);

/** 393216 -> "384 KB". */
export function readableSize(bytes: number): string {
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

export interface StartupInfo {
    version: string;
    tag: string;
    servers: number;
    commands: number;
    commandsUpdated: boolean;
    integrations: Record<string, boolean>;
    health: string;
}

/** A compact, framed status panel printed once the bot is connected and ready. */
export function startupSummary(info: StartupInfo): string[] {
    const integrations = Object.entries(info.integrations)
        .map(([name, on]) => on ? `${name} ${style.green('ON')}` : `${name} ${style.dim('off')}`).join('  ·  ');
    const network = info.servers > 0 ? `${info.servers} connected` : style.yellow('not in any servers yet');
    const commandState = info.commandsUpdated ? style.yellow('updated on Discord') : style.green('up to date');
    return [
        '',
        frame('╭', '─', '╮'),
        panelRow(`${style.bold('MIDTOWN VANGUARD')}  ${style.dim(`v${info.version}`)}  ${style.cyan('SECURITY OPERATIONS')}`),
        panelRow(`${style.green('● SYSTEM ONLINE')}  ${style.dim('as')} ${style.bold(info.tag)}`),
        frame('├', '─', '┤'),
        detail('NETWORK', network),
        detail('COMMANDS', `${info.commands} registered  ·  ${commandState}`),
        detail('MODULES', integrations),
        detail('HEALTH', info.health),
        frame('╰', '─', '╯'),
        '',
    ];
}

export const closingRule = () => style.cyan(RULE);
