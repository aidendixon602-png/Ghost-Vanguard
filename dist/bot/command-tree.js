import { CommandInteractionOptionResolver } from 'discord.js';
export const UMBRELLAS = [
    { name: 'antinuke', description: 'Anti-nuke readiness, observe/enforce controls, rules and exceptions', entries: [
            { child: 'antinuke', mode: 'flat' }, { child: 'antinuke-plus', mode: 'flat' }, { child: 'trust', mode: 'group', as: 'whitelist' }
        ] },
    { name: 'mod', description: 'Moderation: ban, kick, timeout, bans, cases, notes, appeals', entries: [
            { child: 'moderation', mode: 'flat' }, { child: 'tempban', mode: 'single' }, { child: 'softban', mode: 'single' }, { child: 'massban', mode: 'single' },
            { child: 'bans', mode: 'group' }, { child: 'case', mode: 'group' }, { child: 'note', mode: 'group', as: 'notes' }, { child: 'warnings', mode: 'group' }, { child: 'appeals', mode: 'group' }, { child: 'nick', mode: 'group' }
        ] },
    { name: 'security', description: 'Raids, lockdowns, automod, scam links and ping protection', entries: [
            { child: 'security', mode: 'flat' }, { child: 'lockdown', mode: 'single' }, { child: 'unlock', mode: 'single' }, { child: 'slowmode', mode: 'single' }, { child: 'webhooks', mode: 'single' }, { child: 'health', mode: 'single' },
            { child: 'emergency', mode: 'group' }, { child: 'raidmode', mode: 'group' }, { child: 'newaccounts', mode: 'group' }, { child: 'automod', mode: 'group' }, { child: 'scam', mode: 'group' },
            { child: 'antiping', mode: 'group' }, { child: 'threats', mode: 'group' }
        ] },
    { name: 'setup', description: 'Server setup: logs, staff ranks, welcome, config, permissions', entries: [
            { child: 'logs', mode: 'group' }, { child: 'staff', mode: 'group' }, { child: 'welcome', mode: 'group' }, { child: 'guild-config', mode: 'group', as: 'config' },
            { child: 'perm', mode: 'group', as: 'permissions' }, { child: 'config-history', mode: 'group', as: 'history' }, { child: 'panel', mode: 'single' }
        ] },
    // Setup and configuration first, then the staff tools, so the list reads in the order people need it.
    { name: 'ticket', description: 'Support tickets: the panel, types, settings, stats and staff tools', entries: [
            { child: 'ticket-setup', mode: 'single', as: 'setup' }, { child: 'ticket-panel', mode: 'single', as: 'panel' },
            { child: 'ticket-type', mode: 'group', as: 'types' },
            { child: 'ticket-settings', mode: 'single', as: 'settings' }, { child: 'ticket-stats', mode: 'single', as: 'stats' },
            { child: 'ticket', mode: 'flat' }
        ] },
    { name: 'recovery', description: 'Server backups and snapshots: save, restore, copy layout', entries: [
            { child: 'snapshot', mode: 'group' }, { child: 'backup', mode: 'group' }, { child: 'copylayout', mode: 'single' }
        ] },
    { name: 'info', description: 'Look things up: users, roles, the server and the bot', entries: [
            { child: 'userinfo', mode: 'single', as: 'user' }, { child: 'roleinfo', mode: 'single', as: 'role' }, { child: 'server-info', mode: 'single', as: 'server' },
            { child: 'bot-info', mode: 'single', as: 'bot' }, { child: 'ping', mode: 'single' }
        ] },
    { name: 'network', description: 'Developers: genrebans and hardbans across every Midtown server', entries: [
            { child: 'genreban', mode: 'single' }, { child: 'ungenreban', mode: 'single' }, { child: 'hardban', mode: 'single' }, { child: 'unhardban', mode: 'single' }, { child: 'netexception', mode: 'group', as: 'exceptions' }
        ] },
    { name: 'dev', description: 'Bot developers: diagnostics, updates, servers and the database', entries: [
            { child: 'dev', mode: 'flat' },
            { child: 'authserver', mode: 'single', in: 'server', as: 'authorize' }, { child: 'deauthserver', mode: 'single', in: 'server', as: 'deauthorize' },
            { child: 'serverauth', mode: 'single', in: 'server', as: 'info' }, { child: 'authorizedservers', mode: 'single', in: 'server', as: 'list' },
            { child: 'banserver', mode: 'single', in: 'server', as: 'ban' }, { child: 'unbanserver', mode: 'single', in: 'server', as: 'unban' },
            { child: 'database', mode: 'group' }, { child: 'autoreact', mode: 'group' }
        ] },
];
/** Shown on their own: used often or by everyone. */
export const STANDALONE = ['help', 'verify', 'roblox', 'ask', 'role'];
/** Old shortcuts that the grouped tree already covers (/antinuke enable, /antinuke disable). */
export const RETIRED = ['enable', 'disable'];
const GROUP_DESCRIPTIONS = { server: 'Authorize, inspect, list, ban or unban servers' };
const json = (def) => def.data.toJSON ? def.data.toJSON() : def.data;
const isSub = (o) => o.type === 1 || o.type === 2;
const leafName = (e) => e.as ?? e.child;
/** The command list sent to Discord. */
export function treeJson(registry) {
    const out = [];
    for (const u of UMBRELLAS) {
        const options = [];
        for (const e of u.entries) {
            const def = registry.commands.get(`1:${e.child}`);
            if (!def)
                continue;
            const j = json(def);
            if (e.mode === 'single' && e.in) {
                // Singles that share a subcommand group, e.g. /dev server authorize.
                let group = options.find(o => o.type === 2 && o.name === e.in);
                if (!group) {
                    group = { type: 2, name: e.in, description: GROUP_DESCRIPTIONS[e.in] ?? e.in, options: [] };
                    options.push(group);
                }
                group.options.push({ type: 1, name: leafName(e), description: j.description, options: j.options ?? [] });
            }
            else if (e.mode === 'flat')
                options.push(...(j.options ?? []).filter(isSub));
            else if (e.mode === 'group')
                options.push({ type: 2, name: leafName(e), description: j.description, options: (j.options ?? []).filter(isSub) });
            else
                options.push({ type: 1, name: leafName(e), description: j.description, options: j.options ?? [] });
        }
        out.push({ type: 1, name: u.name, description: u.description, contexts: [0], integration_types: [0], options });
    }
    for (const name of STANDALONE) {
        const def = registry.commands.get(`1:${name}`);
        if (def)
            out.push(json(def));
    }
    // Anything not placed in the tree (a newly added command) still shows up on its own.
    const placed = new Set([...UMBRELLAS.flatMap(u => u.entries.map(e => e.child)), ...STANDALONE, ...RETIRED]);
    for (const def of registry.commands.values())
        if (!placed.has(json(def).name))
            out.push(json(def));
    return out;
}
/** Where a module and subcommand live in the grouped tree, e.g. ("automod","links") → "/security automod links". */
export function displayPath(child, sub = '') {
    for (const u of UMBRELLAS)
        for (const e of u.entries)
            if (e.child === child)
                return `/${[u.name, e.in ?? null, e.mode === 'flat' ? null : leafName(e), e.mode === 'single' ? null : sub || null].filter(Boolean).join(' ')}`;
    return `/${[child, sub || null].filter(Boolean).join(' ')}`;
}
/**
 * Turn an interaction on the grouped tree into the shape its original module expects.
 * Returns the interaction unchanged when it is not a grouped command.
 */
export function routeInteraction(i) {
    if (!(i.isChatInputCommand() || i.isAutocomplete()))
        return i;
    const u = UMBRELLAS.find(x => x.name === i.commandName);
    if (!u)
        return i;
    const top = i.options.data?.[0];
    if (!top)
        return i;
    let entry, data = [];
    if (top.type === 2) {
        entry = u.entries.find(e => e.mode === 'group' && leafName(e) === top.name);
        data = top.options ?? [];
        if (!entry) {
            const inner = (top.options ?? [])[0];
            entry = u.entries.find(e => e.mode === 'single' && e.in === top.name && leafName(e) === inner?.name);
            data = inner?.options ?? [];
        }
    }
    else {
        entry = u.entries.find(e => e.mode === 'single' && !e.in && leafName(e) === top.name);
        if (entry)
            data = top.options ?? [];
        else {
            entry = u.entries.find(e => e.mode === 'flat' && subNames(e.child).has(top.name));
            data = [top];
        }
    }
    if (!entry)
        return i;
    const child = entry.child;
    // A fresh resolver built from the module's own option shape: discord.js works out the subcommand
    // (none for single-mode) and hoists the options. (Proxying the original resolver is not possible:
    // its `data` property is read-only.)
    const options = new CommandInteractionOptionResolver(i.client, data, i.options.resolved);
    return new Proxy(i, { get: (target, key) => {
            if (key === 'commandName')
                return child;
            if (key === 'options')
                return options;
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
        } });
}
let flatSubs = new Map();
const subNames = (child) => flatSubs.get(child) ?? new Set();
/** Remember each flat module's subcommand names (needed to route /mod ban → moderation). */
export function indexTree(registry) {
    flatSubs = new Map();
    for (const u of UMBRELLAS)
        for (const e of u.entries)
            if (e.mode === 'flat') {
                const def = registry.commands.get(`1:${e.child}`);
                if (def)
                    flatSubs.set(e.child, new Set((json(def).options ?? []).filter(isSub).map((o) => o.name)));
            }
}
