import { type Registry } from '../bot/registry.js';
import { displayPath, RETIRED, treeJson } from '../bot/command-tree.js';
import { describe } from '../bot/command-descriptions.js';
import { requiredRank } from '../bot/ranks.js';
import { accessLabel } from './help-ui.js';

/**
 * docs/commands.md and docs/ranks.md, generated from the live command definitions so they can never
 * drift from what the bot really does. `npm run docs` rewrites them; a test fails if they are stale.
 */
interface Leaf { path: string; top: string; description: string; who: string; level: number }

const LEVELS: [number, string, string][] = [
    [8, '🧰 Developer', 'The top rank: the bot owner (`BOT_OWNER_ID`) and anyone in `DEVELOPER_IDS`. Everything, including the tools that can take the bot down or reach every server at once: restarts, installing updates, restoring database settings, removing or banning servers, giving bot-wide ranks and managing network bans. Watched by anti-nuke, but never punished. Set only in `.env`.'],
    [7.5, '🏠 Server Owner', 'Whoever owns a Discord server, in that server only. Above Supreme Leader there: everything server-side, including security admins and undoing setting changes. No bot-wide tools (network bans, /dev, the database). Watched by anti-nuke, but never punished.'],
    [7, '👑 Supreme Leader', 'Bot-wide, every server: diagnostics, update status, database health and backups. Cannot issue, lift or except network bans; those are Developer-only. Punished by anti-nuke like anyone else. Given with `/setup staff global` or `SUPREME_LEADER_IDS`.'],
    [6, '🔭 Overseer', 'Bot-wide, every server: Bot Manager plus inspecting and authorizing servers. Network-ban exceptions are Developer-only. Given with `/setup staff global`.'],
    [5, '🛠️ Bot Manager', 'Bot-wide, every server: Head Admin everywhere plus bot status, diagnostics and announcements. Given with `/setup staff global`.'],
    [4, '🛡️ Head Admin', 'Server rank: anti-nuke, whitelist, control panel, backups and staff ranks. Given by linking a role with `/setup staff role`, or `/setup security-admins` (owner). Discord\'s Administrator permission counts as Head Admin, except for actions that weaken protection.'],
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
            leaves.push({ path, top: path.split(' ')[0]!.slice(1), description: describe(path, sub.description), who: accessLabel(policy, key), level });
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
    '/mod unban': 'Admins may lift ordinary bans here; ban-log Unban/Reban buttons are limited to the server owner or a Developer; network-ban lifts and exceptions are Developer only',
    '/antinuke threats list': 'Admin and above; scores and levels are informational and never trigger automatic enforcement',
    '/antinuke threats view': 'Admin and above; shows every scored incident and staff action',
    '/antinuke threats clear': 'Head Admin and above; clears the board entry only, cases and bans stay',
    '/antinuke threats release': 'Head Admin and above; unbans if they were struck',
    '/antinuke threats strike': 'Head Admin and above; manually strips, records and bans',
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
    const out = ['# Commands', '', 'Generated from the bot itself (`npm run docs`). Type `/` in Discord and pick **Ghost Vanguard**; `/help` shows only slash commands you can use. Sensitive and admin slash replies are private; ordinary public utility replies stay public. Developer actions are available as `/dev`, `/genreban`, `/ungenreban`, `/hardban`, `/unhardban`, `/netexception` and `/restart` slash commands. For the same list grouped by rank, see [ranks.md](ranks.md).', ''];
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
        '- **Developer** has full control of the bot. **Supreme Leader, Overseer and Bot Manager** are bot ranks that work in every server.',
        '- **Server Owner** (whoever owns the Discord server) and the server ranks (Head Admin, Admin, Moderator, Helper) work only in that server. A Server Owner outranks Supreme Leaders there, but bot-wide tools always need a bot rank.',
        '- **Developer is the top rank** (the bot owner and `DEVELOPER_IDS`). Restarts, installing updates, restoring data, removing servers, bot-wide ranks and every network-ban action are Developer only, so giving someone Supreme Leader or lower cannot affect the whole network.',
        '- **Unbans:** ordinary bans are lifted by Admins and server owners; genrebans and hardbans, including one-server genreban exceptions, are Developer only.',
        '- **Anti-nuke watches everyone.** Developers, server owners and whitelisted people are never punished (recorded quietly; `ALERT_EXEMPT=true` alerts on them too); every other rank, Supreme Leaders included, is punished.',
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
