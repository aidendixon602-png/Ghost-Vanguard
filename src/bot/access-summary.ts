import type { Store } from '../database/db.js';
import { config } from '../config.js';
import { style } from '../console-ui.js';
import { supremeLeaders } from './ranks.js';
import { trustedRecipients } from './trusted-dm.js';

/**
 * Printed at every start: exactly who holds bot-wide power, and where it comes from. Nothing is
 * built in: Supreme Leaders come from BOT_OWNER_ID / SUPREME_LEADER_IDS and `/setup staff global`,
 * developers from DEVELOPER_IDS. An unexpected ID here is the first sign of trouble.
 */
export function accessSummary(store: Store): string[] {
    const fromEnv = supremeLeaders();
    const granted = store.all('SELECT user_id, level FROM bot_staff ORDER BY level').map(r => ({ id: String(r.user_id), level: String(r.level) }));
    const supreme = [...new Set([...fromEnv, ...granted.filter(g => g.level === 'supreme').map(g => g.id)])];
    const developers = [...config.developers];
    const others = granted.filter(g => g.level !== 'supreme');
    const row = (label: string, value: string) => `  ${style.cyan('•')} ${label.padEnd(13)} ${value}`;
    const ids = (list: string[]) => list.length ? list.join(', ') : style.dim('none');
    return [
        `  ${style.bold('Access')} ${style.dim('(check these are all people you trust)')}`,
        row('Owner', config.ownerId || style.yellow('not set: set BOT_OWNER_ID')),
        row('Supreme', ids(supreme)),
        row('Developers', ids(developers)),
        row('Bot-wide', others.length ? others.map(o => `${o.id} (${o.level})`).join(', ') : style.dim('none')),
        row('Bot DMs to', ids(trustedRecipients())),
    ];
}
