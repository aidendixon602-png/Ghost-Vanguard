import { readdir } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AppError } from '../errors.js';
import { isAdminRestricted, needsDeveloper, requiredRank } from './ranks.js';
export const defaults = { responseKind: 'success', category: 'utility', developerOnly: false, requiresAuthorization: true,
    requiredPermissions: [], botPermissions: [], cooldown: 1500, ephemeralDefault: true, dmAllowed: false, guildOnly: true, access: 'member', deferral: 'defer' };
const PRIVATE_CATEGORIES = new Set(['moderation', 'security', 'configuration', 'recovery', 'ticket', 'tickets']);
/** Developer-only slash actions are dispatched only through the comma command handler. */
export function isDeveloperPrefixOnly(policy, key) {
    return policy.developerOnly || !!key && needsDeveloper(key);
}
/** Slash replies for staff/admin/sensitive actions are private; ordinary utility replies stay public. */
export function isSensitiveSlashPolicy(policy, key) {
    return policy.developerOnly
        || policy.access !== 'member'
        || PRIVATE_CATEGORIES.has(policy.category)
        || policy.requiredPermissions.length > 0
        || !!policy.channelPermissions?.length
        || !!policy.userChannelPermissions?.length
        || isAdminRestricted(key)
        || (requiredRank(key) ?? 0) > 0;
}
export function defineCommand(builder, metadata, execute, extra = {}) {
    const data = builder.toJSON();
    // Guild installation/context only. Guild ID is never used for registration.
    data.contexts = [0];
    data.integration_types = [0];
    delete data.dm_permission;
    return { data, metadata: { ...defaults, ...metadata }, execute, ...extra };
}
export function validateSchema(data, path = data.name, nested = false) {
    if (!data.name || (!nested && (data.type ?? 1) !== 1 ? data.name.length > 32 : !/^[a-z0-9_-]{1,32}$/.test(data.name)))
        throw new Error(`Invalid command name at ${path}`);
    if ((nested || (data.type ?? 1) === 1) && (!data.description || data.description.length > 100))
        throw new Error(`Invalid description at ${path}`);
    const seen = new Set();
    let optional = false;
    for (const o of data.options ?? []) {
        if (seen.has(o.name))
            throw new Error(`Duplicate option ${path}/${o.name}`);
        seen.add(o.name);
        if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].includes(o.type))
            throw new Error(`Invalid option type ${path}/${o.name}`);
        if (o.type > 2) {
            if (optional && o.required)
                throw new Error(`Required option after optional at ${path}/${o.name}`);
            optional ||= !o.required;
        }
        validateSchema(o, `${path}/${o.name}`, true);
    }
    if ((data.options?.length ?? 0) > 25)
        throw new Error(`Too many options at ${path}`);
}
export class Registry {
    commands = new Map();
    components = [];
    add(def, source) {
        if (!def || typeof def.execute !== 'function' || !def.data || !def.metadata)
            throw new Error(`Command ${source} has no valid handler/schema/metadata`);
        validateSchema(def.data);
        const key = `${def.data.type ?? 1}:${def.data.name}`;
        if (this.commands.has(key))
            throw new Error(`Duplicate command ${def.data.name} (${source})`);
        if (def.data.options?.some((o) => o.autocomplete) && !def.autocomplete)
            throw new Error(`Missing autocomplete handler: ${source}`);
        this.commands.set(key, def);
    }
    component(def) {
        if (!def.prefix || !def.kinds.length || typeof def.execute !== 'function' || this.components.some(c => c.prefix.startsWith(def.prefix) || def.prefix.startsWith(c.prefix)))
            throw new Error(`Invalid/duplicate component handler: ${def.prefix}`);
        this.components.push(def);
    }
    get json() {
        return [...this.commands.values()].map(c => c.data);
    }
    policy(def, i) {
        const path = i.isChatInputCommand?.() || i.isAutocomplete?.() ? [i.options.getSubcommandGroup(false), i.options.getSubcommand(false)].filter(Boolean).join('/') : '';
        const policy = { ...def.metadata, ...def.subcommands?.[path], ...def.contextualPolicy?.(i) };
        const key = path ? `${def.data.name}/${path}` : def.data.name;
        return { ...policy, ephemeralDefault: isSensitiveSlashPolicy(policy, key) };
    }
    async load(directory = join(dirname(fileURLToPath(import.meta.url)), '..', 'commands')) {
        const extension = extname(fileURLToPath(import.meta.url));
        const walk = async (dir) => {
            for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
                const path = join(dir, entry.name);
                if (entry.isDirectory())
                    await walk(path);
                else if (entry.name.endsWith(extension) && !entry.name.endsWith('.d.ts')) {
                    try {
                        this.add((await import(pathToFileURL(path).href)).default, path);
                    }
                    catch (error) {
                        throw new Error(`Command load failed: ${path}`, { cause: error });
                    }
                }
            }
        };
        await walk(directory);
        if (!this.commands.size)
            throw new Error('No commands loaded');
    }
}
export function validateArguments(schema, supplied) {
    const definitions = schema.options ?? [];
    for (const option of supplied) {
        const rule = definitions.find((r) => r.name === option.name && r.type === option.type);
        if (!rule)
            throw new AppError('VALIDATION_ERROR', `Unknown option ${option.name}. Refresh the command in Discord.`);
        if (option.type <= 2) {
            validateArguments(rule, option.options ?? []);
            continue;
        }
        const value = option.value;
        if ([6, 7, 8, 9].includes(option.type) && !/^\d{17,20}$/.test(String(value)))
            throw new AppError('VALIDATION_ERROR', `Invalid Discord ID for ${option.name}.`);
        if (option.type === 3) {
            if (typeof value !== 'string' || !value.trim() || value.length > (rule.max_length ?? 1000) || value.length < (rule.min_length ?? 1))
                throw new AppError('VALIDATION_ERROR', `Invalid length for ${option.name}.`);
            if (option.name.endsWith('_id') && !((/roblox/.test(option.name) || option.name === 'group_id') ? /^[1-9]\d{0,19}$/ : /^\d{17,20}$/).test(value))
                throw new AppError('VALIDATION_ERROR', `Invalid ID for ${option.name}.`);
            if (/url$/.test(option.name)) {
                try {
                    const u = new URL(value);
                    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password)
                        throw 0;
                }
                catch {
                    throw new AppError('VALIDATION_ERROR', 'Use a valid HTTP(S) URL without credentials.');
                }
            }
        }
        if ([4, 10].includes(option.type) && (typeof value !== 'number' || !Number.isFinite(value) || option.type === 4 && !Number.isSafeInteger(value) || value < (rule.min_value ?? -Infinity) || value > (rule.max_value ?? Infinity)))
            throw new AppError('VALIDATION_ERROR', `Invalid number for ${option.name}.`);
        if (option.type === 5 && typeof value !== 'boolean')
            throw new AppError('VALIDATION_ERROR', `Invalid boolean for ${option.name}.`);
        if (rule.choices && !rule.choices.some((c) => c.value === value))
            throw new AppError('VALIDATION_ERROR', `Invalid choice for ${option.name}.`);
    }
    for (const rule of definitions)
        if (rule.required && !supplied.some(o => o.name === rule.name))
            throw new AppError('VALIDATION_ERROR', `Missing required option ${rule.name}.`);
    if (definitions.some((r) => r.type <= 2) && supplied.filter(o => o.type <= 2).length !== 1)
        throw new AppError('VALIDATION_ERROR', 'Choose a valid subcommand.');
}
