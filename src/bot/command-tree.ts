import { CommandInteractionOptionResolver, type Interaction } from 'discord.js';
import { isDeveloperPrefixOnly, type Definition, type Policy, type Registry } from './registry.js';
import { describe } from './command-descriptions.js';
import { RANK_LABEL, RANKS, rankName, requiredRank } from './ranks.js';

/**
 * How commands appear in Discord's "/" menu. Discord lists a bot's commands A→Z and that order
 * cannot be changed, so related commands are grouped under a few top-level commands, one per job:
 *
 *   /antinuke   anti-nuke, whitelist, incidents, quarantine, threat board
 *   /automod    message filters, scam links, staff-ping protection
 *   /raid       lockdown, raid mode, emergency, new accounts, webhooks
 *   /mod        bans, kicks, timeouts, warnings, cases, notes, appeals
 *   /setup      logs, staff ranks, welcome, config, permissions, control panel
 *   /ticket  /recovery  /info  /roblox  /role  /dev  /network  (+ /help /verify /ask /restart)
 *
 * Developer actions (/dev and /network) are now slash commands requiring DEVELOPER_IDS / developer rank.
 * Comma-prefix aliases (`,help`, `,restart`, etc.) remain for backward compatibility but slash is primary.
 * Grouped entries are re-shaped (commandName, subcommand, options) so their original modules run
 * as if they had been called directly. Permissions, ranks, cooldowns and on/off switches keep using the
 * original names.
 *
 * Entry kinds:
 *   flat:   the module's subcommands become direct subcommands   (/mod ban, /mod kick)
 *   group:  the module becomes a subcommand group                (/mod case view)
 *   single: a module without subcommands becomes one subcommand (/mod tempban, /info ping)
 * A flat entry can take only some of a module's subcommands (`pick`) and show them under another name
 * (`rename`, original → shown), so one module can be split across two top-level commands.
 */
type Entry = { child: string; mode: 'flat' | 'group' | 'single'; as?: string; /** single only: put it inside this subcommand group */ in?: string;
    /** flat only: just these subcommands */ pick?: string[]; /** flat only: original name → name shown in Discord */ rename?: Record<string, string> };
export interface Umbrella { name: string; description: string; entries: Entry[] }

export const UMBRELLAS: Umbrella[] = [
    { name: 'antinuke', description: 'Anti-nuke: status, on/off, whitelist, incidents, quarantine and the threat board', entries: [
        { child: 'antinuke', mode: 'flat' }, { child: 'antinuke-plus', mode: 'flat' }, { child: 'trust', mode: 'group', as: 'whitelist' },
        { child: 'security', mode: 'flat', pick: ['incidents', 'quarantine', 'release'] }, { child: 'threats', mode: 'group' }] },
    { name: 'automod', description: 'Message protection: spam, links, invites, AI, scam links and staff pings', entries: [
        { child: 'automod', mode: 'flat' }, { child: 'scam', mode: 'group' }, { child: 'antiping', mode: 'group' }] },
    { name: 'raid', description: 'Raid response: lockdown, raid mode, emergency mode, new accounts, webhooks', entries: [
        { child: 'lockdown', mode: 'single' }, { child: 'unlock', mode: 'single' }, { child: 'health', mode: 'single' }, { child: 'webhooks', mode: 'single' },
        { child: 'raidmode', mode: 'group', as: 'mode' }, { child: 'emergency', mode: 'group' }, { child: 'newaccounts', mode: 'group' }] },
    { name: 'mod', description: 'Moderation: ban, kick, timeout, warn, purge, cases, notes and appeals', entries: [
        { child: 'moderation', mode: 'flat' }, { child: 'tempban', mode: 'single' }, { child: 'softban', mode: 'single' }, { child: 'massban', mode: 'single' }, { child: 'slowmode', mode: 'single' },
        { child: 'bans', mode: 'group' }, { child: 'case', mode: 'group', as: 'cases' }, { child: 'note', mode: 'group', as: 'notes' }, { child: 'warnings', mode: 'group' }, { child: 'appeals', mode: 'group' }, { child: 'nick', mode: 'group' }] },
    { name: 'setup', description: 'Server setup: logs, staff ranks, security settings, welcome, panel and config', entries: [
        { child: 'panel', mode: 'single' }, { child: 'security', mode: 'flat', pick: ['status', 'config', 'admin'], rename: { config: 'security', admin: 'security-admins' } },
        { child: 'logs', mode: 'group' }, { child: 'staff', mode: 'group' }, { child: 'welcome', mode: 'group' }, { child: 'guild-config', mode: 'group', as: 'config' },
        { child: 'perm', mode: 'group', as: 'permissions' }, { child: 'config-history', mode: 'group', as: 'history' }] },
    // Setup and configuration first, then the staff tools, so the list reads in the order people need it.
    { name: 'ticket', description: 'Support tickets: the panel, types, settings, stats and staff tools', entries: [
        { child: 'ticket-setup', mode: 'single', as: 'setup' }, { child: 'ticket-panel', mode: 'single', as: 'panel' },
        { child: 'ticket-type', mode: 'group', as: 'types' },
        { child: 'ticket-settings', mode: 'single', as: 'settings' }, { child: 'ticket-stats', mode: 'single', as: 'stats' },
        { child: 'ticket', mode: 'flat' }] },
    { name: 'recovery', description: 'Server backups and snapshots: save, restore, copy layout', entries: [
        { child: 'snapshot', mode: 'group' }, { child: 'backup', mode: 'group' }, { child: 'copylayout', mode: 'single' }] },
    { name: 'info', description: 'Look things up: users, roles, the server and the bot', entries: [
        { child: 'userinfo', mode: 'single', as: 'user' }, { child: 'roleinfo', mode: 'single', as: 'role' }, { child: 'server-info', mode: 'single', as: 'server' },
        { child: 'bot-info', mode: 'single', as: 'bot' }, { child: 'ping', mode: 'single' }] },
    { name: 'network', description: 'Bot staff: genrebans and hardbans across every Midtown server', entries: [
        { child: 'genreban', mode: 'single' }, { child: 'ungenreban', mode: 'single' }, { child: 'hardban', mode: 'single' }, { child: 'unhardban', mode: 'single' }, { child: 'netexception', mode: 'group', as: 'exceptions' }] },
    { name: 'dev', description: 'Bot developers: diagnostics, updates, alerts, servers and the database', entries: [
        { child: 'dev', mode: 'flat' },
        { child: 'authserver', mode: 'single', in: 'server', as: 'authorize' }, { child: 'deauthserver', mode: 'single', in: 'server', as: 'deauthorize' },
        { child: 'serverauth', mode: 'single', in: 'server', as: 'info' }, { child: 'authorizedservers', mode: 'single', in: 'server', as: 'list' },
        { child: 'banserver', mode: 'single', in: 'server', as: 'ban' }, { child: 'unbanserver', mode: 'single', in: 'server', as: 'unban' },
        { child: 'database', mode: 'group' }, { child: 'autoreact', mode: 'group' }] },
];

/** Shown on their own: used often or by everyone. */
export const STANDALONE = ['help', 'verify', 'roblox', 'ask', 'role', 'restart'];
/** Old shortcuts that the grouped tree already covers (/antinuke enable, /antinuke disable). */
export const RETIRED = ['enable', 'disable'];

const GROUP_DESCRIPTIONS: Record<string, string> = { server: 'Authorize, inspect, list, ban or unban servers' };

const json = (def: any) => def.data.toJSON ? def.data.toJSON() : def.data;
const isSub = (o: any) => o.type === 1 || o.type === 2;
const leafName = (e: Entry) => e.as ?? e.child;

function slashOptions(def: Definition, options: any[], prefix = ''): any[] {
    const out: any[] = [];
    for (const option of options) {
        if (option.type === 1) {
            out.push({ ...option, options: option.options ?? [] });
            continue;
        }
        if (option.type === 2) {
            const children = slashOptions(def, option.options ?? [], prefix ? `${prefix}/${option.name}` : option.name);
            if (children.length)
                out.push({ ...option, options: children });
            continue;
        }
        out.push(option);
    }
    return out;
}

/** Who can use a command, short enough for Discord's menu ("Admin+", "Developer"); null for everyone. */
/** Commands that check access inside themselves, so the policy alone says "everyone". */
const CHECKED_INSIDE: [RegExp, string][] = [[/^ticket\//, 'Ticket staff'], [/^role\/(add|remove|restore)$/, 'Staff']];

export function menuAccess(policy: Policy, key: string): string | null {
    const inside = CHECKED_INSIDE.find(([pattern]) => pattern.test(key));
    const need = requiredRank(key);
    if (policy.developerOnly) return need === undefined || need >= RANKS.developer ? 'Developer' : `${RANK_LABEL[rankName(need)!]}+`;
    if (policy.access === 'owner' || need === RANKS.owner) return 'Server Owner';
    if (need !== undefined && need > 0) return `${RANK_LABEL[rankName(need)!]}+`;
    if (policy.access === 'security') return 'Head Admin+';
    if (policy.requiredPermissions?.length) return 'Staff';
    return inside?.[1] ?? null;
}

/** Every command as shown in Discord ("/mod ban") → its module, permission key and policy. */
function shownIndex(registry: Registry): Map<string, { key: string; policy: Policy }> {
    const index = new Map<string, { key: string; policy: Policy }>();
    for (const def of registry.commands.values()) {
        const j = json(def);
        if ((j.type ?? 1) !== 1) continue;
        const walk = (options: any[] = [], prefix = '') => {
            for (const o of options) {
                if (o.type === 2) walk(o.options, `${prefix}${o.name}/`);
                else if (o.type === 1) {
                    const path = `${prefix}${o.name}`;
                    index.set(displayPath(j.name, path.replaceAll('/', ' ')), { key: `${j.name}/${path}`, policy: { ...def.metadata, ...(def as any).subcommands?.[path] } as Policy });
                }
            }
        };
        if ((j.options ?? []).some(isSub)) walk(j.options);
        else index.set(displayPath(j.name), { key: j.name, policy: def.metadata as Policy });
    }
    return index;
}

/** Description for the menu: the shared wording plus who can use it, within Discord's 100-character limit. */
function menuDescription(shown: string, fallback: string, index: Map<string, { key: string; policy: Policy }>): string {
    const text = describe(shown, fallback);
    const found = index.get(shown);
    const who = found ? menuAccess(found.policy, found.key) : null;
    if (!who) return text.slice(0, 100);
    const tag = ` · ${who}`;
    return (text.length + tag.length <= 100 ? text : `${text.slice(0, 99 - tag.length)}…`) + tag;
}

function applyDescriptions(command: any, index: Map<string, { key: string; policy: Policy }>) {
    const walk = (options: any[], prefix: string) => {
        for (const o of options ?? []) {
            if (o.type === 2) walk(o.options, `${prefix} ${o.name}`);
            else if (o.type === 1) o.description = menuDescription(`${prefix} ${o.name}`, o.description, index);
        }
    };
    if ((command.options ?? []).some(isSub)) walk(command.options, `/${command.name}`);
    else command.description = menuDescription(`/${command.name}`, command.description, index);
    return command;
}

/** The command list sent to Discord — slash is primary, comma aliases remain for compatibility. */
export function treeJson(registry: Registry) {
    const index = shownIndex(registry);
    return buildTree(registry).map(c => applyDescriptions(structuredClone(c), index));
}

function buildTree(registry: Registry) {
    const out: any[] = [];
    for (const u of UMBRELLAS) {
        const options: any[] = [];
        for (const e of u.entries) {
            const def = registry.commands.get(`1:${e.child}`);
            if (!def) continue;
            const j = json(def);
            const filtered = slashOptions(def, j.options ?? []);
            if (e.mode === 'single' && e.in) {
                let group = options.find(o => o.type === 2 && o.name === e.in);
                if (!group) { group = { type: 2, name: e.in, description: GROUP_DESCRIPTIONS[e.in] ?? e.in, options: [] }; options.push(group); }
                group.options.push({ type: 1, name: leafName(e), description: j.description, options: filtered });
            }
            else if (e.mode === 'flat') options.push(...filtered.filter(isSub).filter(o => !e.pick || e.pick.includes(o.name)).map(o => e.rename?.[o.name] ? { ...o, name: e.rename[o.name] } : o));
            else if (e.mode === 'group') {
                if (filtered.length)
                    options.push({ type: 2, name: leafName(e), description: j.description, options: filtered.filter(isSub) });
            }
            else options.push({ type: 1, name: leafName(e), description: j.description, options: filtered });
        }
        if (options.length)
            out.push({ type: 1, name: u.name, description: u.description, contexts: [0], integration_types: [0], options });
    }
    for (const name of STANDALONE) {
        const def = registry.commands.get(`1:${name}`);
        if (def) out.push({ ...json(def), options: slashOptions(def, json(def).options ?? []) });
    }
    // Anything not placed in the tree (a newly added command) still shows up on its own, unless it's developer-only.
    const placed = new Set([...UMBRELLAS.flatMap(u => u.entries.map(e => e.child)), ...STANDALONE, ...RETIRED]);
    for (const def of registry.commands.values()) {
        const data = json(def);
        if (!placed.has(data.name))
            out.push({ ...data, options: slashOptions(def, data.options ?? []) });
    }
    return out;
}

/** Where a module and subcommand live in the grouped tree, e.g. ("automod","links") → "/security automod links". */
export function displayPath(child: string, sub = ''): string {
    const first = sub.split(' ')[0] ?? '';
    for (const u of UMBRELLAS) for (const e of u.entries) if (e.child === child) {
        if (e.mode === 'flat' && e.pick && !e.pick.includes(first)) continue;
        const shown = e.mode === 'flat' && e.rename?.[first] ? [e.rename[first], ...sub.split(' ').slice(1)].join(' ') : sub;
        return `/${[u.name, e.in ?? null, e.mode === 'flat' ? null : leafName(e), e.mode === 'single' ? null : shown || null].filter(Boolean).join(' ')}`;
    }
    return `/${[child, sub || null].filter(Boolean).join(' ')}`;
}

/**
 * Turn an interaction on the grouped tree into the shape its original module expects.
 * Returns the interaction unchanged when it is not a grouped command.
 */
export function routeInteraction<T extends Interaction>(i: T): T {
    if (!(i.isChatInputCommand() || i.isAutocomplete())) return i;
    const u = UMBRELLAS.find(x => x.name === i.commandName);
    if (!u) return i;
    const top = (i.options as any).data?.[0];
    if (!top) return i;
    let entry: Entry | undefined, data: any[] = [];
    if (top.type === 2) {
        entry = u.entries.find(e => e.mode === 'group' && leafName(e) === top.name);
        data = top.options ?? [];
        if (!entry) {
            const inner = (top.options ?? [])[0];
            entry = u.entries.find(e => e.mode === 'single' && e.in === top.name && leafName(e) === inner?.name);
            data = inner?.options ?? [];
        }
    } else {
        entry = u.entries.find(e => e.mode === 'single' && !e.in && leafName(e) === top.name);
        if (entry) data = top.options ?? [];
        else {
            entry = u.entries.find(e => e.mode === 'flat' && shownSubs(e).has(top.name));
            // Shown under another name (/setup security → security config): hand the module its own name back.
            const original = entry?.rename ? Object.entries(entry.rename).find(([, shown]) => shown === top.name)?.[0] : undefined;
            data = [original ? { ...top, name: original } : top];
        }
    }
    if (!entry) return i;
    const child = entry.child;
    // A fresh resolver built from the module's own option shape: discord.js works out the subcommand
    // (none for single-mode) and hoists the options. (Proxying the original resolver is not possible:
    // its `data` property is read-only.)
    const options = new (CommandInteractionOptionResolver as any)(i.client, data, (i.options as any).resolved);
    return new Proxy(i, { get: (target, key) => {
        if (key === 'commandName') return child;
        if (key === 'options') return options;
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
    } }) as T;
}

let flatSubs = new Map<string, Set<string>>();
const subNames = (child: string) => flatSubs.get(child) ?? new Set<string>();
/** The names a flat entry shows in Discord: its picked subcommands, renamed where asked. */
const shownSubs = (e: Entry) => new Set([...subNames(e.child)].filter(n => !e.pick || e.pick.includes(n)).map(n => e.rename?.[n] ?? n));
/** Remember each flat module's subcommand names (needed to route /mod ban → moderation). */
export function indexTree(registry: Registry) {
    flatSubs = new Map();
    for (const u of UMBRELLAS) for (const e of u.entries) if (e.mode === 'flat') {
        const def = registry.commands.get(`1:${e.child}`);
        if (def) flatSubs.set(e.child, new Set((json(def).options ?? []).filter(isSub).map((o: any) => o.name)));
    }
}
