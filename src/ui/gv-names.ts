/**
 * Ghost Vanguard has no slash commands any more: its commands are typed with Veil Utilities' prefix, `,gv`.
 * Its messages were written for slash commands (`/raid mode on`), and the command names are also lookup keys in
 * the code, so the text is translated on the way out instead: every `/raid …` it posts reads `,gv raid …`.
 */
export const TOP_COMMANDS = ['antinuke', 'automod', 'raid', 'mod', 'setup', 'ticket', 'recovery', 'info', 'network', 'dev',
    'help', 'verify', 'roblox', 'ask', 'role', 'restart'] as const;

const SLASH = new RegExp(`(^|[\\s\`(*>\\[_"'|])/(${TOP_COMMANDS.join('|')})(?=$|[\\s\`*.,)!?:;'"\\]_|])`, 'g');
const TEXT_KEYS = new Set(['content', 'title', 'description', 'name', 'value', 'text', 'label', 'placeholder']);

export const gvLine = (text: string): string => text.replace(SLASH, '$1,gv $2');

/** A message payload (content, embeds, components) with slash command names written as `,gv` commands. */
export function gvText<T>(payload: T): T {
    const walk = (value: any, key?: string): any => {
        if (typeof value === 'string') return key && TEXT_KEYS.has(key) ? gvLine(value) : value;
        if (Array.isArray(value)) return value.map(v => walk(v, key));
        if (value && typeof value === 'object') {
            if (typeof value.toJSON === 'function' && value.constructor !== Object) {
                // discord.js builders (embeds, rows, buttons): translate their data in place and keep the builder,
                // since callers keep using it (the translation is safe to repeat).
                for (const k of Object.keys(value)) value[k] = walk(value[k], k);
                return value;
            }
            return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
        }
        return value;
    };
    return walk(payload);
}
