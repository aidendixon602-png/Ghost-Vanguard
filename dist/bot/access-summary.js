import { config } from '../config.js';
import { style } from '../console-ui.js';
import { supremeLeaders } from './ranks.js';
import { trustedRecipients } from './trusted-dm.js';
import { blacklistSize, protectedRoleAssigners, protectedRoles } from './env-rules.js';
/**
 * Printed at every start: exactly who holds bot-wide power, and where it comes from. Nothing is
 * built in: Developers (the top rank) are BOT_OWNER_ID and DEVELOPER_IDS; Supreme Leaders come from
 * SUPREME_LEADER_IDS and `/setup staff global`. Comma-prefix access is stricter and lists only DEVELOPER_IDS.
 * An unexpected ID here is the first sign of trouble.
 */
export function accessSummary(store) {
    const fromEnv = supremeLeaders();
    const granted = store.all('SELECT user_id, level FROM bot_staff ORDER BY level').map(r => ({ id: String(r.user_id), level: String(r.level) }));
    const developers = [...new Set([config.ownerId, ...config.developers].filter(Boolean))];
    const supreme = [...new Set([...fromEnv, ...granted.filter(g => g.level === 'supreme').map(g => g.id)])].filter(id => !developers.includes(id));
    const others = granted.filter(g => g.level !== 'supreme');
    const row = (label, value) => `  ${style.cyan('•')} ${label.padEnd(13)} ${value}`;
    const ids = (list) => list.length ? list.join(', ') : style.dim('none');
    return [
        `  ${style.bold('Access')} ${style.dim('(check these are all people you trust)')}`,
        row('Owner', config.ownerId || style.yellow('not set: set BOT_OWNER_ID')),
        row('Developers', ids(developers)),
        row('Comma IDs', ids([...config.developers])),
        row('Supreme', ids(supreme)),
        row('Bot-wide', others.length ? others.map(o => `${o.id} (${o.level})`).join(', ') : style.dim('none')),
        row('Bot DMs to', ids(trustedRecipients())),
        row('Blacklisted', blacklistSize() ? `${blacklistSize()} user(s) (COMMAND_BLACKLIST)` : style.dim('none')),
        row('Protected', protectedRoles().size ? `${protectedRoles().size} role(s); assigners: ${ids([...protectedRoleAssigners()])} + Developers` : style.dim('none')),
    ];
}
