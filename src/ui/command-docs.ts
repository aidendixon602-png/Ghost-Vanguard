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
    [8, '🧰 Developer', 'The top rank: the bot owner (`BOT_OWNER_ID`) and anyone in `DEVELOPER_IDS`. Everything, including the tools that can take the bot down or reach every server at once: restarts, installing updates, restoring database settings, removing or banning servers, giving bot-wide ranks and lifting hardbans. Ignored by anti-nuke. Set only in `.env`.'],
    [7, '👑 Supreme Leader', 'Bot-wide, every server: everything except the Developer-only tools. Diagnostics, update status, database health and backups, genrebans and hardbans, lifting genrebans. Ignored by anti-nuke. Given with `/setup staff global` or `SUPREME_LEADER_IDS`.'],
    [6, '🔭 Overseer', 'Bot-wide, every server: Bot Manager plus inspecting and authorizing servers, and letting a genrebanned person back into one server. Given with `/setup staff global`.'],
    [5, '🛠️ Bot Manager', 'Bot-wide, every server: Head Admin everywhere plus bot status, diagnostics and announcements. Given with `/setup staff global`.'],
    [4.5, '🏠 Server Owner', 'The owner of a server, in that server: everything a Head Admin can do, plus security admins and undoing setting changes. Cannot lift genrebans or hardbans. Ignored by anti-nuke.'],
    [4, '🛡️ Head Admin', 'Server rank: anti-nuke, whitelist, control panel, backups and staff ranks. Given by linking a role with `/setup staff role`, or `/security admin` (owner). Discord\'s Administrator permission counts as Head Admin, except for actions that weaken protection.'],
    [3, '🔧 Admin', 'Server rank: lifting ordinary bans and accepting appeals, raid tools, automod, scam protection and logging. Given with `/setup staff role`; Discord\'s Administrator permission also works for unbans.'],
    [2, '🔨 Moderator', 'Server rank, or Discord\'s matching permission (Ban/Kick/Timeout Members, Manage Messages): bans, kicks, purges, denying appeals. Cannot lift bans.'],
    [1, '🤝 Helper', 'Server rank: warnings, short timeouts, cases and notes. Given with `/setup staff role`.'],
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
    '/mod unban': 'ordinary bans only; a genreban needs an Overseer+ for a one-server exception, or a Supreme Leader+ to lift it everywhere; a hardban needs a Developer',
    '/dev update': 'anyone with /dev sees the status; installing now needs a Developer',
    '/network exceptions revoke': 'exceptions are granted by Overseers and higher through `/mod unban`',
    '/security threats list': 'Admin and above; the bot acts by itself above 25 points, always reversibly',
    '/security threats view': 'Admin and above; shows every scored incident and automatic action',
    '/security threats clear': 'Head Admin and above; clears the board entry only, cases and bans stay',
    '/security threats release': 'Head Admin and above; unbans if they were struck',
    '/security threats strike': 'Head Admin and above; the manual version of the automatic counter-attack',
    '/ticket claim': 'ticket staff role, Manage Server or a Vanguard rank',
    '/ticket unclaim': 'the staff member who claimed it, or an admin',
    '/ticket transfer': 'ticket staff only',
    '/ticket priority': 'ticket staff only',
    '/ticket close': 'the member who opened the ticket, or ticket staff',
    '/ticket closerequest': 'ticket staff only',
    '/ticket add': 'ticket staff only',
    '/ticket remove': 'ticket staff only',
    '/ticket rename': 'ticket staff only',
    '/ticket history': 'ticket staff only',
    '/ticket block': 'ticket staff only; bots and staff cannot be blocked',
    '/ticket unblock': 'ticket staff only',
    '/ticket blocked': 'ticket staff only',
};

export function commandsDoc(registry: Registry): string {
    const leaves = commandLeaves(registry);
    const out = ['# Commands', '', 'Generated from the bot itself (`npm run docs`). Type `/` in Discord and pick **Ghost Vanguard**; `/help` shows only what you can use. For the same list grouped by rank, see [ranks.md](ranks.md).', ''];
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
        '- **Bot-wide ranks** (Developer, Supreme Leader, Overseer, Bot Manager) work in every server.',
        '- **Server ranks** (Owner, Head Admin, Admin, Moderator, Helper) work only in the server they were given in.',
        '- **Developer is the top rank** (the bot owner and `DEVELOPER_IDS`). Restarts, installing updates, restoring data, removing servers, bot-wide ranks and lifting hardbans are Developer only, so giving someone Supreme Leader or lower cannot break the bot.',
        '- **Unbans:** ordinary bans are lifted by Admins and server owners; genrebans by a Supreme Leader or Developer (or a one-server exception from an Overseer+); hardbans only by a Developer.',
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
