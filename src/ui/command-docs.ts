import type { Registry } from '../bot/registry.js';
import { displayPath, RETIRED, treeJson } from '../bot/command-tree.js';
import { requiredRank } from '../bot/ranks.js';
import { accessLabel } from './help-ui.js';

/**
 * docs/commands.md and docs/ranks.md, generated from the live command definitions so they can never
 * drift from what the bot really does. `npm run docs` rewrites them; a test fails if they are stale.
 */
interface Leaf { path: string; top: string; description: string; who: string; level: number }

const LEVELS: [number, string, string][] = [
    [8, '👑 Supreme Leader', 'Full control of the bot in every server. Given with `/setup staff global`.'],
    [7, '🧰 Developer', 'Everything, in every server, without needing Discord permissions. Ignored by anti-nuke. Added only by listing the user ID in `DEVELOPER_IDS` in `.env`.'],
    [6, '🔭 Overseer', 'Bot-wide rank, every server. Given with `/setup staff global`.'],
    [5, '🛠️ Bot Manager', 'Bot-wide rank, every server: Head Admin everywhere plus bot status tools. Given with `/setup staff global`.'],
    [4.5, '🏠 Server Owner', 'The owner of a server, in that server. Ignored by anti-nuke.'],
    [4, '🛡️ Head Admin', 'Server rank. Given by linking a role with `/setup staff role`, or `/security admin` (owner). Discord\'s Administrator permission counts as Head Admin, except for actions that weaken protection.'],
    [3, '🔧 Admin', 'Server rank. Given with `/setup staff role`.'],
    [2, '🔨 Moderator', 'Server rank, or Discord\'s matching permission (Ban/Kick/Timeout Members, Manage Messages).'],
    [1, '🤝 Helper', 'Server rank. Given with `/setup staff role`.'],
    [0, '👤 Everyone', 'Any member. Some of these check more inside the command (noted next to them).'],
];

export function commandLeaves(registry: Registry): Leaf[] {
    const leaves: Leaf[] = [];
    for (const def of registry.commands.values()) {
        const json: any = typeof (def.data as any).toJSON === 'function' ? (def.data as any).toJSON() : def.data;
        if ((json.type ?? 1) !== 1 || RETIRED.includes(json.name)) continue;
        const subs: { path: string; description: string }[] = [];
        const walk = (options: any[] = [], prefix = '') => {
            for (const o of options) {
                if (o.type === 1) subs.push({ path: prefix + o.name, description: o.description });
                else if (o.type === 2) walk(o.options, `${prefix}${o.name}/`);
            }
        };
        walk(json.options);
        for (const sub of subs.length ? subs : [{ path: '', description: json.description }]) {
            const policy: any = { ...def.metadata, ...((def as any).subcommands?.[sub.path] ?? {}) };
            const key = sub.path ? `${json.name}/${sub.path}` : json.name;
            const need = requiredRank(key);
            const level = need !== undefined ? need : policy.developerOnly ? 7 : policy.access === 'owner' ? 4.5 : policy.access === 'security' ? 4 : policy.requiredPermissions?.length ? 2 : 0;
            const path = displayPath(json.name, sub.path.replaceAll('/', ' '));
            leaves.push({ path, top: path.split(' ')[0]!.slice(1), description: sub.description, who: accessLabel(policy, key), level });
        }
    }
    return leaves;
}

const NOTES: Record<string, string> = {
    '/role add': 'checked role by role: Manage Roles or a Moderator rank, and staff roles need `/role who-can-give`',
    '/role remove': 'checked role by role, like `/role add`',
    '/role restore': 'gives back only roles the person could give with `/role add`',
    '/role who-can-give': 'staff roles: owner only',
    '/mod massban': 'must also be on the anti-nuke whitelist',
    '/mod timeout': 'Helpers up to 60 minutes; Moderators longer',
};

export function commandsDoc(registry: Registry): string {
    const leaves = commandLeaves(registry);
    const out = ['# Commands', '', 'Generated from the bot itself (`npm run docs`). Type `/` in Discord and pick **Midtown Vanguard**; `/help` shows only what you can use. For the same list grouped by rank, see [ranks.md](ranks.md).', ''];
    for (const top of treeJson(registry) as any[]) {
        const rows = leaves.filter(l => l.top === top.name);
        if (!rows.length) continue;
        out.push(`## /${top.name}`, '', top.description, '', '| Command | What it does | Who |', '|---|---|---|');
        for (const l of rows) out.push(`| \`${l.path}\` | ${l.description} | ${l.who}${NOTES[l.path] ? ` (${NOTES[l.path]})` : ''} |`);
        out.push('');
    }
    return out.join('\n');
}

export function ranksDoc(registry: Registry): string {
    const leaves = commandLeaves(registry).sort((a, b) => a.path.localeCompare(b.path));
    const out = ['# Ranks', '', 'Generated from the bot itself (`npm run docs`). Every rank can also use everything listed under the ranks below it.', '',
        '- **Bot-wide ranks** (Supreme Leader, Developer, Overseer, Bot Manager) work in every server.',
        '- **Server ranks** (Owner, Head Admin, Admin, Moderator, Helper) work only in the server they were given in.',
        '- **Anti-nuke** ignores only Developers, Supreme Leaders, the server owner and whitelisted people. Every other rank is still watched.',
        '- Check anyone with `/setup staff check user:@them`; see all ranks with `/setup staff list`.', ''];
    for (const [level, title, about] of LEVELS) {
        const rows = leaves.filter(l => l.level === level);
        out.push(`## ${title}`, '', about, '');
        if (!rows.length) { out.push(level === 8 ? '_Everything below._' : '_No extra commands; see the ranks below._', ''); continue; }
        for (const l of rows) out.push(`- \`${l.path}\`: ${l.description}${NOTES[l.path] ? ` _(${NOTES[l.path]})_` : ''}`);
        out.push('');
    }
    return out.join('\n');
}
