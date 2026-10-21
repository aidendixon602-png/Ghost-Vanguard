import { Routes, type REST } from 'discord.js';
import type { Store } from '../database/db.js';
import { logEvent } from '../errors.js';

const canonical = (x: any): any => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().filter(k => x[k] !== undefined).map(k => [k, canonical(x[k])])) : x;

function option(o: any): any {
    const value: any = { type: o.type, name: o.name, description: o.description, name_localizations: o.name_localizations ?? null, description_localizations: o.description_localizations ?? null };
    if (o.type <= 2)
        value.options = (o.options ?? []).map(option);
    else {
        value.required = o.required ?? false;
        for (const k of ['min_value', 'max_value', 'min_length', 'max_length'])
            if (o[k] !== undefined && o[k] !== null)
                value[k] = o[k];
        if ([3, 4, 10].includes(o.type)) {
            value.autocomplete = o.autocomplete ?? false;
            value.choices = (o.choices ?? []).map((c: any) => ({ name: c.name, value: c.value, name_localizations: c.name_localizations ?? null }));
        }
        if (o.type === 7)
            value.channel_types = [...(o.channel_types ?? [])].sort((a, b) => a - b);
    }
    return value;
}

export function normalizeCommands(commands: any[]): string {
    return JSON.stringify(canonical(commands.map(c => ({ type: c.type ?? 1, name: c.name, description: c.description ?? '',
        name_localizations: c.name_localizations ?? null, description_localizations: c.description_localizations ?? null,
        default_member_permissions: c.default_member_permissions == null ? null : String(c.default_member_permissions), nsfw: c.nsfw ?? false,
        contexts: [...(c.contexts ?? [0, 1, 2])].sort(), integration_types: [...(c.integration_types ?? [0])].sort(), options: (c.options ?? []).map(option)
    })).sort((a, b) => a.type - b.type || a.name.localeCompare(b.name))));
}

export async function syncCommands(rest: Pick<REST, 'get' | 'put'>, application: string, desired: any[], opts: { force?: boolean } = {}) {
    const route = Routes.applicationCommands(application);
    const current = await rest.get(route) as any[];
    const currentNorm = normalizeCommands(current);
    const desiredNorm = normalizeCommands(desired);
    if (!opts.force && currentNorm === desiredNorm) {
        logEvent('command_sync', { result: 'unchanged', count: desired.length, names: desired.map((c: any) => c.name).sort() });
        return false;
    }
    if (currentNorm !== desiredNorm) {
        const curNames = (current as any[]).map(c => c.name).sort();
        const desNames = desired.map((c: any) => c.name).sort();
        logEvent('command_sync', { result: 'updating', count: desired.length, from: curNames, to: desNames, force: !!opts.force });
    }
    // Bulk replacement also removes obsolete global commands, including context commands.
    await rest.put(route, { body: desired });
    logEvent('command_sync', { result: 'updated', count: desired.length, names: desired.map((c: any) => c.name).sort() });
    return true;
}

/** Bulk-overwrite one guild's commands and return the names that were removed (present before, gone from `desired`). */
export async function syncGuildCommands(rest: Pick<REST, 'get' | 'put'>, application: string, guildId: string, desired: any[]): Promise<string[]> {
    const route = Routes.applicationGuildCommands(application, guildId);
    const current = await rest.get(route).catch(() => []) as any[];
    const want = new Set(desired.map((c: any) => c.name));
    const removed = current.filter((c: any) => !want.has(c.name)).map((c: any) => String(c.name));
    await rest.put(route, { body: desired });
    logEvent('command_sync', { result: 'guild_updated', guildId, count: desired.length, removed });
    return removed;
}

/**
 * Remove every guild-scoped command from a guild so only the global set shows there. This is the fix for
 * duplicate commands: when the same command is registered both globally and in a guild, Discord lists it
 * twice in that guild. Returns the names that were removed.
 */
export async function clearGuildCommands(rest: Pick<REST, 'get' | 'put'>, application: string, guildId: string): Promise<string[]> {
    const route = Routes.applicationGuildCommands(application, guildId);
    const current = await rest.get(route).catch(() => []) as any[];
    const removed = current.map((c: any) => String(c.name));
    if (removed.length) await rest.put(route, { body: [] });
    logEvent('command_sync', { result: 'guild_cleared', guildId, removed: removed.length });
    return removed;
}

/** Global command names Discord currently has that `desired` no longer defines (the ones a bulk overwrite deletes). */
export async function outdatedGlobalCommands(rest: Pick<REST, 'get'>, application: string, desired: any[]): Promise<string[]> {
    const current = await rest.get(Routes.applicationCommands(application)).catch(() => []) as any[];
    const want = new Set(desired.map((c: any) => c.name));
    return current.filter((c: any) => !want.has(c.name)).map((c: any) => String(c.name));
}

export async function cleanLegacyGuildCommands(rest: Pick<REST, 'get' | 'put'>, application: string, guildId: string, store: Store) {
    const key = `global-migration-v2:${guildId}`;
    if (store.get('SELECT 1 FROM runtime_meta WHERE key=?', key))
        return;
    const route = Routes.applicationGuildCommands(application, guildId);
    const current = await rest.get(route) as any[];
    if (current.length) {
        await rest.put(route, { body: [] });
        logEvent('legacy_commands_removed', { guildId, count: current.length });
    }
    store.run('INSERT OR REPLACE INTO runtime_meta VALUES(?,?)', key, 'complete');
}
