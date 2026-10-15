import { developers } from './developers.js';
import { AppError } from '../errors.js';
import type { Policy } from './registry.js';

export const ANTINUKE_OWNER_MESSAGE = 'Only the current server owner or a configured Vanguard developer can manage anti-nuke.';

const commands = new Set(['antinuke', 'antinuke-plus', 'enable', 'disable', 'trust']);
const controls = new Set(['anpanel', 'ruleui', 'trustlist', 'tp', 'botq', 'incident']);
const related = new Set(['security/config', 'security/setup', 'security/quarantine', 'security/release', 'logs/setup']);

/** Identity check: Discord permissions, staff ranks and whitelist grants cannot delegate this access. */
export function canManageAntinuke(user: string, ownerId?: string | null): boolean {
    return developers.has(user) || !!ownerId && user === ownerId;
}

export function requireAntinukeManager(user: string, ownerId?: string | null): void {
    if (!canManageAntinuke(user, ownerId)) throw new AppError('PERMISSION_ERROR', ANTINUKE_OWNER_MESSAGE);
}

export function isAntinukeCommand(name: string): boolean {
    return commands.has(name);
}

/** Original module keys are used after grouped Discord command routing. */
export function isAntinukeAction(policy: Pick<Policy, 'category'>, key = ''): boolean {
    const normalized = key.replace(/\/$/, ''), root = normalized.split('/')[0]!;
    return policy.category === 'antinuke' || commands.has(root) || controls.has(root) || related.has(normalized);
}

export function isAntinukeHistory(component: string, previous: any, current: any): boolean {
    if (component === 'settings' || component === 'feature/antinukeplus' || component === 'feature:antinukeplus') return true;
    if (component.split(':')[0] === 'grant')
        return [previous?.kind, current?.kind].some(kind => typeof kind === 'string' && /^(trust(?:_role)?(?::.*)?|bot|bot_denied)$/.test(kind));
    if (component.split(':')[0] === 'command')
        return [previous?.command, current?.command, component.slice('command:'.length)].some(name => typeof name === 'string' && isAntinukeCommand(name));
    return false;
}
