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

const row = (ok: boolean, label: string, value: string) => `  ${ok ? style.green('✔') : style.yellow('!')} ${label.padEnd(13)} ${value}`;

export interface StartupInfo {
    version: string;
    tag: string;
    servers: number;
    commands: number;
    commandsUpdated: boolean;
    integrations: Record<string, boolean>;
    health: string;
}

/** The block printed once the bot is connected and ready. */
export function startupSummary(info: StartupInfo): string[] {
    const integrations = Object.entries(info.integrations)
        .map(([name, on]) => on ? `${name} ${style.green('✔')}` : style.dim(`${name} off`)).join('   ');
    return [
        '',
        style.cyan(RULE),
        `  ${style.bold('MIDTOWN VANGUARD')}  ${style.dim(`v${info.version}`)}`,
        style.cyan(RULE),
        row(true, 'Online', `as ${style.bold(info.tag)}`),
        row(info.servers > 0, 'Servers', info.servers > 0 ? `${info.servers} connected` : 'not in any servers yet'),
        row(true, 'Commands', `${info.commands} registered · ${info.commandsUpdated ? 'updated on Discord' : 'up to date'}`),
        row(true, 'Integrations', integrations),
        row(true, 'Health', info.health),
        '',
    ];
}

export const closingRule = () => style.cyan(RULE);
