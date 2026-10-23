import type { GuildMember, Message, Role, User } from 'discord.js';
import { KeyedQueue } from '../core.js';
import { config } from '../config.js';
import { AppError, failure, logEvent } from '../errors.js';
import { Guard } from './guard.js';
import { canUsePrefixRestart, requestPrefixRestart, type PrefixRestartResult } from './prefix-restart.js';
import { clearRestartNotice, completeRestartNotice, restartInProgressText, restartNoticeText, saveRestartNotice } from './restart-notice.js';
import { prefixDeleteDelayMs, schedulePrefixMessageDeletion } from './prefix-cleanup.js';
import { defaults, isDeveloperPrefixOnly, validateArguments, type CommandContext, type Definition, type Registry, type Services } from './registry.js';

type MessageLike = Message & { guild: NonNullable<Message['guild']> };
type Invocation = {
    commandName: string;
    path: string[];
    args: string[];
    def?: Definition;
    error?: string;
    special?: 'help' | 'restart';
};

type Resolved = {
    users: Map<string, User>;
    members: Map<string, GuildMember>;
    roles: Map<string, Role>;
    channels: Map<string, any>;
    attachments: Map<string, any>;
};

const ALIASES: Record<string, { command: string; path?: string[] }> = {
    update: { command: 'dev', path: ['update'] },
    servers: { command: 'authorizedservers' },
    authservers: { command: 'authorizedservers' },
};

/** Identifies known comma commands before ordinary chat moderation/scanning runs. */
export function recognizesPrefixCommand(message: Pick<Message, 'content' | 'guildId' | 'author'>, registry: Registry): boolean {
    if (!message.guildId || message.author.bot || !message.content.trimStart().startsWith(','))
        return false;
    return !!parsePrefixInvocation(message.content, registry);
}

export class PrefixCommands {
    private readonly guard: Guard;
    constructor(private readonly services: Services, private readonly queue: KeyedQueue) {
        this.guard = new Guard(services.store, id => services.lifecycle.isReady(id));
    }

    recognizes(message: Pick<Message, 'content' | 'guildId' | 'author'>): boolean {
        return recognizesPrefixCommand(message, this.services.registry);
    }

    async handle(message: Message): Promise<void> {
        const invocation = parsePrefixInvocation(message.content, this.services.registry);
        if (!invocation || !message.guildId || !message.guild || message.author.bot)
            return;
        const command = message as MessageLike;
        // Prefix commands are deliberately stricter than bot-wide slash ranks: only an explicit
        // DEVELOPER_IDS entry qualifies. BOT_OWNER_ID is not an implicit exception.
        if (!config.developers.has(command.author.id))
            return;

        const requestedAt = Date.now();
        try {
            if (invocation.special === 'restart') {
                await this.restart(command, requestedAt);
                return;
            }

            // The caller's message is queued for deletion as soon as a valid developer command is accepted.
            schedulePrefixMessageDeletion(this.services.client, this.services.store, command.channelId, command.id, requestedAt + prefixDeleteDelayMs());
            if (invocation.special === 'help') {
                await this.sendAndExpire(command, prefixHelp(this.services.registry));
                return;
            }
            if (invocation.error || !invocation.def) {
                await this.sendAndExpire(command, invocation.error ?? 'That comma command is not available. Use `,help` to list developer commands.');
                return;
            }
            await this.execute(command, invocation);
        } catch (error) {
            const f = failure(error);
            logEvent('prefix_command_failure', { reference: f.reference, command: invocation.commandName, userId: command.author.id,
                guildId: command.guildId, channelId: command.channelId, category: f.category, details: f.details });
            await this.sendAndExpire(command, `${f.message}\n\nReference: **${f.reference}**`).catch(() => {});
        }
    }

    private async restart(message: MessageLike, requestedAt: number) {
        if (!canUsePrefixRestart(message.author.id))
            return;
        schedulePrefixMessageDeletion(this.services.client, this.services.store, message.channelId, message.id, requestedAt + prefixDeleteDelayMs());
        const notice = await message.reply(restartNoticeText(requestedAt));
        if (!saveRestartNotice(this.services.store, message.channelId, notice.id, requestedAt)) {
            await notice.edit(restartInProgressText());
            schedulePrefixMessageDeletion(this.services.client, this.services.store, message.channelId, notice.id, Date.now() + prefixDeleteDelayMs());
            return;
        }

        const result = await requestPrefixRestart(message.author.id);
        const failureText: Partial<Record<PrefixRestartResult, string>> = {
            'not-authorized': '⛔ This comma command is restricted to IDs listed in `DEVELOPER_IDS`.',
            busy: 'A restart or update is already in progress. Try again in a minute.',
            'too-soon': 'The bot started less than 3 minutes ago. Wait a minute, then try `,restart` again.',
            'no-launcher': 'I can’t restart from Discord because the launcher is not available. Use **Restart** in Wispbyte. Keep the startup command `cd /home/container && node launch.js`.',
        };
        if (result === 'restarting')
            return;
        if (result === 'scheduled') {
            await notice.edit(`${restartNoticeText(requestedAt)}\nℹ️ Using the backup restart route; the host will relaunch the bot.`);
            return;
        }
        clearRestartNotice(this.services.store);
        await notice.edit(failureText[result] ?? 'The restart could not be scheduled.');
        schedulePrefixMessageDeletion(this.services.client, this.services.store, message.channelId, notice.id, Date.now() + prefixDeleteDelayMs());
    }

    private async execute(message: MessageLike, invocation: Invocation) {
        const def = invocation.def!;
        const key = `${invocation.commandName}${invocation.path.length ? `/${invocation.path.join('/')}` : ''}`;
        const built = await buildOptions(message, def, invocation.path, invocation.args);
        const response = makePrefixInteraction(message, invocation, built);
        const policy = this.services.registry.policy(def, response);
        if (!isDeveloperPrefixOnly(policy, key))
            throw new AppError('PERMISSION_ERROR', 'That action is not configured as a developer comma command.');
        validateArguments(def.data, response.options.data);

        const actor = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
        response.member = actor;
        const checked = await this.guard.check(response, policy, key, true, false);
        const context: CommandContext = {
            ...this.services,
            actor: checked,
            policy,
            actionKey: key,
            serialize: work => this.queue.run(message.guildId!, work),
            assertActive: () => { if (policy.requiresAuthorization) this.services.store.assertAuthorized(message.guildId!); },
        };
        const run = async () => {
            context.actor = await this.guard.check(response, policy, key, false, false);
            if (policy.requiresAuthorization)
                return this.services.store.withAuthorized(message.guildId!, async () => {
                    const result = await def.execute(context, response as any);
                    context.assertActive();
                    return result;
                });
            return def.execute(context, response as any);
        };
        const result = policy.requiresAuthorization ? await this.queue.run(message.guildId!, run) : await run();
        if (typeof result === 'string')
            await response.editReply(result);
        else if (!response._prefixReply)
            await response.editReply('Done.');

        for (const reply of response._prefixReplies as any[])
            schedulePrefixMessageDeletion(this.services.client, this.services.store, message.channelId, reply.id, Date.now() + prefixDeleteDelayMs());
        logEvent('command_activity', { command: invocation.commandName, subcommand: invocation.path.join('/'), user: message.author.tag,
            userId: message.author.id, guildId: message.guildId, guild: message.guild.name, result: 'success', source: 'prefix' });
    }

    private async sendAndExpire(message: MessageLike, content: string) {
        const replies: any[] = [];
        for (const part of splitText(content)) {
            const reply = await message.reply(part);
            replies.push(reply);
            schedulePrefixMessageDeletion(this.services.client, this.services.store, message.channelId, reply.id, Date.now() + prefixDeleteDelayMs());
        }
        return replies[0];
    }
}

function parsePrefixInvocation(content: string, registry: Registry): Invocation | null {
    const trimmed = content.trim();
    const syntaxError = hasUnclosedQuote(trimmed) ? 'Close the quote around that value.' : undefined;
    const tokens = tokenize(trimmed);
    if (!tokens.length || !tokens[0]!.startsWith(','))
        return null;
    const typedName = tokens.shift()!.slice(1).toLowerCase();
    if (!typedName)
        return null;
    if (typedName === 'restart')
        return tokens.length ? null : { commandName: 'restart', path: [], args: [], special: 'restart' };
    if (typedName === 'help')
        return syntaxError ? { commandName: 'help', path: [], args: [], error: syntaxError }
            : tokens.length ? { commandName: 'help', path: [], args: [], error: 'Usage: `,help`.' } : { commandName: 'help', path: [], args: [], special: 'help' };

    const alias = ALIASES[typedName];
    const commandName = alias?.command ?? typedName;
    const def = registry.commands.get(`1:${commandName}`);
    if (!def)
        return null;
    if (syntaxError)
        return { commandName, path: [], args: [], def, error: syntaxError };

    const data: any = def.data;
    const subcommands = (data.options ?? []).filter((o: any) => o.type === 1 || o.type === 2);
    let path = alias?.path ? [...alias.path] : [];
    let args = tokens;
    if (!alias?.path && subcommands.length) {
        const eligible = subcommands.some((node: any) => {
            const nodeKey = `${commandName}/${node.name}`;
            const nodePolicy = { ...def.metadata, ...def.subcommands?.[node.name] };
            return isDeveloperPrefixOnly(nodePolicy, nodeKey);
        });
        if (!def.metadata.developerOnly && !eligible)
            return null;
        const first = args[0]?.toLowerCase();
        if (!first) {
            if (!def.metadata.developerOnly)
                return null;
            return { commandName, path: [], args: [], def, error: `Choose a subcommand for ,${commandName}. Use ,help for the developer command list.` };
        }
        const selected = subcommands.find((o: any) => o.name === first);
        if (!selected) {
            if (!def.metadata.developerOnly)
                return null;
            return { commandName, path: [], args: [], def, error: `Unknown ,${commandName} subcommand \`${first}\`.` };
        }
        path = [selected.name];
        args = args.slice(1);
        if (selected.type === 2) {
            const nested = args.shift()?.toLowerCase();
            const child = (selected.options ?? []).find((o: any) => o.type === 1 && o.name === nested);
            if (!child)
                return { commandName, path, args: [], def, error: `Choose a subcommand under ,${commandName} ${selected.name}.` };
            path.push(child.name);
        }
    }

    const key = `${commandName}${path.length ? `/${path.join('/')}` : ''}`;
    const selectedPolicy = { ...def.metadata, ...def.subcommands?.[path.join('/')] };
    if (!isDeveloperPrefixOnly(selectedPolicy, key))
        return null;
    try {
        findSchema(data.options ?? [], path);
    } catch (error) {
        return { commandName, path, args: [], def, error: error instanceof Error ? error.message : 'Invalid comma command.' };
    }
    return { commandName, path, args, def };
}

function hasUnclosedQuote(input: string): boolean {
    let quote: '"' | "'" | null = null, escaped = false;
    for (const char of input) {
        if (escaped) { escaped = false; continue; }
        if (quote && char === '\\') { escaped = true; continue; }
        if (quote) { if (char === quote) quote = null; continue; }
        if (char === '"' || char === "'") quote = char;
    }
    return quote !== null;
}

function tokenize(input: string): string[] {
    const tokens: string[] = [];
    let current = '', quote: '"' | "'" | null = null, escaped = false, started = false;
    for (const char of input) {
        if (escaped) { current += char; escaped = false; started = true; continue; }
        if (quote && char === '\\') { escaped = true; continue; }
        if (quote) {
            if (char === quote) quote = null;
            else current += char;
            started = true;
            continue;
        }
        if (char === '"' || char === "'") { quote = char; started = true; continue; }
        if (/\s/.test(char)) {
            if (started) { tokens.push(current); current = ''; started = false; }
            continue;
        }
        current += char; started = true;
    }
    if (escaped) current += '\\';
    if (started) tokens.push(current);
    return tokens;
}

function findSchema(options: any[], path: string[]): { chain: any[]; leaf: any[] } {
    let children = options;
    const chain: any[] = [];
    for (const name of path) {
        const node = children.find(o => (o.type === 1 || o.type === 2) && o.name === name);
        if (!node)
            throw new AppError('VALIDATION_ERROR', `Unknown developer subcommand \`${path.join(' ')}\`.`);
        chain.push(node);
        children = node.options ?? [];
    }
    return { chain, leaf: children.filter(o => o.type > 2) };
}

async function buildOptions(message: MessageLike, def: Definition, path: string[], args: string[]) {
    const { chain, leaf } = findSchema((def.data as any).options ?? [], path);
    const tokens = [...args];
    const supplied = new Map<string, string>();
    const byName = new Map(leaf.map(option => [String(option.name), option]));
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!;
        if (token.startsWith('--')) {
            const [rawName, inline] = token.slice(2).split(/=(.*)/s, 2);
            const name = rawName!.toLowerCase().replaceAll('-', '_');
            const option = byName.get(name);
            if (!option) throw new AppError('VALIDATION_ERROR', `Unknown option \`--${rawName}\`.`);
            if (supplied.has(name)) throw new AppError('VALIDATION_ERROR', `Option \`--${name}\` was supplied twice.`);
            if (option.type === 11) {
                if (inline !== undefined) throw new AppError('VALIDATION_ERROR', `Attach the file for \`--${name}\`; do not type a value.`);
                continue;
            }
            let next = inline;
            if (next === undefined && i + 1 < tokens.length && !(option.type === 5 && tokens[i + 1]!.startsWith('--')))
                next = tokens[++i];
            if (option.type === 5 && next === undefined) supplied.set(name, 'true');
            else if (next === undefined) throw new AppError('VALIDATION_ERROR', `Give a value for \`--${name}\`.`);
            else supplied.set(name, next);
            continue;
        }
        const eq = token.indexOf('=');
        if (eq > 0) {
            const name = token.slice(0, eq).toLowerCase().replaceAll('-', '_');
            if (byName.has(name)) {
                if (supplied.has(name)) throw new AppError('VALIDATION_ERROR', `Option \`${name}\` was supplied twice.`);
                supplied.set(name, token.slice(eq + 1));
                continue;
            }
        }
        let index = 0;
        while (index < leaf.length && (leaf[index]!.type === 11 || supplied.has(String(leaf[index]!.name)))) index++;
        if (index >= leaf.length)
            throw new AppError('VALIDATION_ERROR', 'Too many values. Quote multiword values and use `--option value` for optional fields.');
        supplied.set(String(leaf[index]!.name), token);
    }

    const resolved: Resolved = { users: new Map(), members: new Map(), roles: new Map(), channels: new Map(), attachments: new Map() };
    const optionData: any[] = [];
    const attachment = firstAttachment(message);
    for (const option of leaf) {
        const name = String(option.name);
        if (option.type === 11) {
            if (attachment) {
                resolved.attachments.set(attachment.id, attachment);
                optionData.push({ type: option.type, name, value: attachment.id });
            }
            continue;
        }
        if (!supplied.has(name)) continue;
        const raw = supplied.get(name)!;
        const value = await resolveValue(message, option, raw, resolved);
        optionData.push({ type: option.type, name, value });
    }

    let data = optionData;
    for (const node of [...chain].reverse())
        data = [{ type: node.type, name: node.name, options: data }];
    return { data, leaf: optionData, resolved, path };
}

async function resolveValue(message: MessageLike, option: any, raw: string, resolved: Resolved): Promise<string | number | boolean> {
    if (option.type === 4 || option.type === 10) {
        const number = Number(raw);
        if (!Number.isFinite(number)) throw new AppError('VALIDATION_ERROR', `\`${option.name}\` must be a number.`);
        return number;
    }
    if (option.type === 5) {
        const value = raw.toLowerCase();
        if (['true', 'yes', 'on', '1'].includes(value)) return true;
        if (['false', 'no', 'off', '0'].includes(value)) return false;
        throw new AppError('VALIDATION_ERROR', `\`${option.name}\` must be true or false.`);
    }
    if (option.choices?.length) {
        const choice = option.choices.find((item: any) => String(item.value).toLowerCase() === raw.toLowerCase());
        if (!choice) throw new AppError('VALIDATION_ERROR', `Choose one of: ${option.choices.map((item: any) => item.value).join(', ')}.`);
        return choice.value;
    }
    if (option.type === 6) {
        const id = discordId(raw);
        if (!id) throw new AppError('VALIDATION_ERROR', `Use a user mention or Discord ID for \`${option.name}\`.`);
        let user = message.mentions.users.get(id) ?? message.client.users.cache.get(id) ?? message.guild.members.cache.get(id)?.user;
        if (!user) user = await message.client.users.fetch(id).catch(() => null) ?? undefined;
        if (!user) throw new AppError('VALIDATION_ERROR', `Could not find user \`${id}\`.`);
        resolved.users.set(id, user);
        let member = message.guild.members.cache.get(id);
        if (!member) member = await message.guild.members.fetch(id).catch(() => null) ?? undefined;
        if (member) resolved.members.set(id, member);
        return id;
    }
    if (option.type === 8) {
        const id = discordId(raw);
        const role = (id ? message.mentions.roles.get(id) ?? message.guild.roles.cache.get(id) : undefined)
            ?? message.guild.roles.cache.find(r => r.name.toLowerCase() === raw.toLowerCase());
        if (!role) throw new AppError('VALIDATION_ERROR', `Could not find role \`${raw}\`.`);
        resolved.roles.set(role.id, role);
        return role.id;
    }
    if (option.type === 7) {
        const id = discordId(raw);
        const channel = (id ? message.mentions.channels.get(id) ?? message.guild.channels.cache.get(id) : undefined)
            ?? message.guild.channels.cache.find(c => 'name' in c && c.name?.toLowerCase() === raw.toLowerCase());
        if (!channel) throw new AppError('VALIDATION_ERROR', `Could not find channel \`${raw}\`.`);
        resolved.channels.set(channel.id, channel);
        return channel.id;
    }
    if (option.type === 9) {
        const id = discordId(raw);
        const role = id ? message.mentions.roles.get(id) ?? message.guild.roles.cache.get(id) : undefined;
        if (role) { resolved.roles.set(role.id, role); return role.id; }
        const user = id ? message.mentions.users.get(id) ?? message.client.users.cache.get(id) ?? message.guild.members.cache.get(id)?.user : undefined;
        if (user) { resolved.users.set(user.id, user); return user.id; }
        throw new AppError('VALIDATION_ERROR', `Use a user or role mention for \`${option.name}\`.`);
    }
    return raw;
}

function discordId(value: string): string | null {
    const match = /^(?:<@!?|<@&|<#)?(\d{17,20})>?$/.exec(value.trim());
    return match?.[1] ?? null;
}

function firstAttachment(message: MessageLike): any | null {
    const collection: any = message.attachments;
    return collection?.first?.() ?? collection?.values?.().next?.().value ?? null;
}

class PrefixOptions {
    constructor(readonly data: any[], private readonly leaf: any[], private readonly resolved: Resolved, private readonly path: string[]) { }
    getSubcommandGroup(required = true): string | null { const value = this.path.length > 1 ? this.path[0]! : null; if (required && !value) throw new AppError('VALIDATION_ERROR', 'Choose a subcommand group.'); return value; }
    getSubcommand(required = true): string | null { const value = this.path.at(-1) ?? null; if (required && !value) throw new AppError('VALIDATION_ERROR', 'Choose a subcommand.'); return value; }
    private find(name: string, type: number, required = false): any {
        const option = this.leaf.find(item => item.name === name && item.type === type);
        if (!option && required) throw new AppError('VALIDATION_ERROR', `Missing required option \`${name}\`.`);
        return option;
    }
    get(name: string, required = false): any | null {
        const option = this.leaf.find(item => item.name === name);
        if (!option && required) throw new AppError('VALIDATION_ERROR', `Missing required option \`${name}\`.`);
        if (!option) return null;
        const value: any = { name: option.name, type: option.type, value: option.value };
        const id = String(option.value ?? '');
        if (option.type === 6) { value.user = this.resolved.users.get(id) ?? null; value.member = this.resolved.members.get(id) ?? null; }
        if (option.type === 8) value.role = this.resolved.roles.get(id) ?? null;
        if (option.type === 9) { value.user = this.resolved.users.get(id) ?? null; value.role = this.resolved.roles.get(id) ?? null; }
        return value;
    }
    getString(name: string, required = false): string | null { return this.find(name, 3, required)?.value ?? null; }
    getInteger(name: string, required = false): number | null { return this.find(name, 4, required)?.value ?? null; }
    getNumber(name: string, required = false): number | null { return this.find(name, 10, required)?.value ?? null; }
    getBoolean(name: string, required = false): boolean | null { return this.find(name, 5, required)?.value ?? null; }
    getUser(name: string, required = false): User | null { const id = this.find(name, 6, required)?.value; return id ? this.resolved.users.get(String(id)) ?? null : null; }
    getMember(name: string, required = false): GuildMember | null { const id = this.find(name, 6, required)?.value; return id ? this.resolved.members.get(String(id)) ?? null : null; }
    getRole(name: string, required = false): Role | null { const id = this.find(name, 8, required)?.value; return id ? this.resolved.roles.get(String(id)) ?? null : null; }
    getChannel(name: string, required = false): any | null { const id = this.find(name, 7, required)?.value; return id ? this.resolved.channels.get(String(id)) ?? null : null; }
    getMentionable(name: string, required = false): User | Role | null { const id = this.find(name, 9, required)?.value; return id ? this.resolved.users.get(String(id)) ?? this.resolved.roles.get(String(id)) ?? null : null; }
    getAttachment(name: string, required = false): any | null { const id = this.find(name, 11, required)?.value; return id ? this.resolved.attachments.get(String(id)) ?? null : null; }
}

function makePrefixInteraction(message: MessageLike, invocation: Invocation, built: Awaited<ReturnType<typeof buildOptions>>) {
    let reply: any = null;
    const replies: any[] = [];
    const edit = async (payload: any) => {
        const parts = typeof payload === 'string' ? splitText(payload) : [payload];
        if (!reply) {
            for (const part of parts) {
                reply = await message.reply(part);
                replies.push(reply);
            }
            return reply;
        }
        const first = parts.shift() ?? '';
        reply = await reply.edit(first);
        if (!replies.some(item => item.id === reply.id)) replies.push(reply);
        for (const part of parts) {
            const next = await message.reply(part);
            replies.push(next);
        }
        return reply;
    };
    const interaction: any = {
        id: message.id,
        commandName: invocation.commandName,
        commandType: 1,
        user: message.author,
        guild: message.guild,
        guildId: message.guildId,
        channel: message.channel,
        channelId: message.channelId,
        member: message.member,
        client: message.client,
        options: new PrefixOptions(built.data, built.leaf, built.resolved, invocation.path),
        deferred: false,
        replied: false,
        responded: false,
        createdTimestamp: message.createdTimestamp,
        inGuild: () => true,
        inCachedGuild: () => true,
        isRepliable: () => true,
        isCommand: () => true,
        isChatInputCommand: () => true,
        isAutocomplete: () => false,
        isButton: () => false,
        isAnySelectMenu: () => false,
        isModalSubmit: () => false,
        reply: async (payload: any) => { interaction.replied = true; return edit(payload); },
        editReply: async (payload: any) => { interaction.replied = true; return edit(payload); },
        followUp: async (payload: any) => { const sent = await message.reply(payload); replies.push(sent); return sent; },
        deferReply: async () => { interaction.deferred = true; },
        fetchReply: async () => reply,
        deleteReply: async () => reply?.delete?.(),
        get _prefixReply() { return reply; },
        _prefixReplies: replies,
    };
    return interaction;
}

function splitText(text: string): string[] {
    if (text.length <= 1900) return [text];
    const parts: string[] = [];
    while (text.length > 1900) {
        let cut = text.lastIndexOf('\n', 1900);
        if (cut < 1) cut = 1900;
        parts.push(text.slice(0, cut));
        text = text.slice(cut + 1);
    }
    if (text) parts.push(text);
    return parts;
}

export function prefixHelp(registry: Registry): string {
    const rows: string[] = [];
    const add = (command: string, path: string[], options: any[], description: string) => {
        const key = `${command}${path.length ? `/${path.join('/')}` : ''}`;
        const display = key === 'dev/update' ? ',update'
            : key === 'authorizedservers' ? ',servers'
                : `,${command}${path.length ? ` ${path.join(' ')}` : ''}`;
        const args = options.filter(option => option.type > 2).map(prefixOptionUsage).filter(Boolean);
        const suffix = key === 'dev/update' ? ' [status|now]' : args.length ? ` ${args.join(' ')}` : '';
        const prefixDescription = description.replace(/\/network\s+(un(?:genreban|hardban))/g, ',$1');
        rows.push(`\`${display}${suffix}\` — ${prefixDescription}`);
    };

    for (const def of registry.commands.values()) {
        const data: any = def.data;
        if ((data.type ?? 1) !== 1)
            continue;
        const options: any[] = data.options ?? [];
        const subs = options.filter(option => option.type === 1 || option.type === 2);
        if (!subs.length) {
            if (isDeveloperPrefixOnly(def.metadata, data.name))
                add(data.name, [], options, data.description ?? 'Developer command.');
            continue;
        }
        const walk = (nodes: any[], prefix: string[] = []) => {
            for (const node of nodes) {
                if (node.type === 2) {
                    walk(node.options ?? [], [...prefix, node.name]);
                    continue;
                }
                if (node.type !== 1)
                    continue;
                const path = [...prefix, node.name];
                const key = `${data.name}/${path.join('/')}`;
                const policy = { ...def.metadata, ...def.subcommands?.[path.join('/')] };
                if (isDeveloperPrefixOnly(policy, key))
                    add(data.name, path, node.options ?? [], node.description ?? 'Developer command.');
            }
        };
        walk(options);
    }

    rows.sort((a, b) => a.localeCompare(b));
    rows.unshift('`,restart` — gracefully restart, then update this message with the actual downtime and readiness status.');
    return [
        '**Developer comma commands** · only IDs listed in `DEVELOPER_IDS` (the bot owner is not an implicit exception)',
        ...rows,
        'Use quotes for multiword values, `--option value` for optional arguments, and attach the backup file for `,database restore-settings`.',
        'Slash commands stay permission-checked; use `/help` for the non-developer command menu.',
    ].join('\n');
}

function prefixOptionUsage(option: any): string {
    if (option.type === 11)
        return option.required ? '<attach file>' : '[attach file]';
    if (option.type === 5)
        return `[--${option.name}]`;
    const choices = option.choices?.map((choice: any) => String(choice.value));
    const value = choices?.length ? choices.join('|') : option.type === 6 ? '<user>' : option.type === 7 ? '<channel>'
        : option.type === 8 ? '<role>' : option.type === 9 ? '<user|role>' : option.type === 4 || option.type === 10 ? '<number>' : `<${option.name}>`;
    return option.required ? value : `[--${option.name} ${value}]`;
}
