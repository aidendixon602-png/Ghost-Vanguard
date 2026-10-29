import { CommandInteractionOptionResolver, MessageFlags } from 'discord.js';
import { AppError } from '../errors.js';
import { TRUSTED_BOTS } from './trusted-bots.js';
import { gvText } from '../ui/gv-names.js';
/**
 * `,gv …` text commands: Ghost Vanguard has no slash commands. Members type its commands with Veil Utilities'
 * prefix (`,gv raid mode on`, `,gv antinuke status`); Veil checks Ghost Vanguard is in the server and reacts 🛡️
 * to the message. That reaction, from Veil's own bot account, is the hand-off: only then does Vanguard read the
 * message and run the command exactly as its slash command would have run, with every rank, permission and
 * confirmation check, answering in the channel.
 *
 *   `,gv raid mode on`                     → /raid mode on
 *   `,gv antinuke whitelist add @mod`      → /antinuke whitelist add user:@mod
 *   `,gv mod ban @raider reason:spam bot`  → named options, the rest of the line for the last text option
 */
/** The emoji Veil reacts with to hand a message over. */
export const HANDOFF_EMOJI = '🛡️';
/** A hand-off older than this is ignored (a reaction added to an old message is not a command). */
export const HANDOFF_WINDOW_MS = 2 * 60 * 1000;
/** `,gv`, `!vanguard`, `,ghost`: any one-character-or-more prefix, then the command word. */
const LEAD = /^\s*\S*?\b(gv|vanguard|ghost)\b\s*/i;
/** Commands whose answers can carry server lists, diagnostics or update details: answered by DM, not in the channel. */
export const PRIVATE_COMMANDS = new Set(['dev', 'network']);
/** Split a line into words; "double quotes" keep spaces together, also after a name (`reason:"two words"`). */
export function words(text) {
    return (text.match(/(?:[^\s"]*"[^"]*")+[^\s"]*|\S+/g) ?? []).map(w => w.replace(/"/g, ''));
}
/** The command text after the prefix and `gv`, or null when the message isn't a `,gv` command. */
export function commandText(content) {
    const m = LEAD.exec(content);
    if (!m || m.index !== 0)
        return null;
    return content.slice(m[0].length).trim();
}
const SUB = 1, GROUP = 2;
const ID = /^<?[@#]?[!&]?(\d{17,20})>?$/;
const BOOL = new Set(['on', 'yes', 'true', 'enable', 'enabled', '1', 'off', 'no', 'false', 'disable', 'disabled', '0']);
/** A word that is clearly a value: a number, on/off, a mention or an ID. */
const typed = (w) => /^-?\d+(\.\d+)?$/.test(w) || BOOL.has(w.toLowerCase()) || /^<[@#][!&]?\d{17,20}>$/.test(w);
/** Whether an option can take this word. */
function fits(option, w) {
    const raw = /^\d{17,20}$/.test(w);
    switch (option.type) {
        case 3: return !option.choices?.length || option.choices.some((c) => [String(c.name), String(c.value)].some(v => v.toLowerCase() === w.toLowerCase()));
        case 4: return /^-?\d+$/.test(w) && !raw;
        case 10: return /^-?\d+(\.\d+)?$/.test(w) && !raw;
        case 5: return BOOL.has(w.toLowerCase());
        case 6: return /^<@!?\d{17,20}>$/.test(w) || raw;
        case 7: return /^<#\d{17,20}>$/.test(w) || raw || /^#\S+$/.test(w);
        case 8: return /^<@&\d{17,20}>$/.test(w) || raw || /^@\S+$/.test(w);
        case 9: return /^<@[!&]?\d{17,20}>$/.test(w) || raw;
        default: return false;
    }
}
/**
 * Match words against the command tree (the same JSON Discord used to get): the command, its subcommand group
 * and subcommand, then options. Options are `name:value` or positional in their declared order; the last text
 * option takes the rest of the line. Mentions and IDs are kept as IDs here and resolved to users, roles and
 * channels by `resolve`.
 */
export function parse(text, tree) {
    const tokens = words(text);
    const top = tokens.shift()?.toLowerCase();
    if (!top)
        throw new AppError('VALIDATION_ERROR', HELP_HINT);
    const command = tree.find(c => c.name === top);
    if (!command)
        throw new AppError('VALIDATION_ERROR', `There is no \`gv ${top}\` command. ${HELP_HINT}`);
    const path = [];
    let node = command;
    while ((node.options ?? []).some((o) => o.type === SUB || o.type === GROUP)) {
        const word = tokens[0]?.toLowerCase();
        const next = (node.options ?? []).find((o) => (o.type === SUB || o.type === GROUP) && o.name === word);
        if (!next) {
            const choices = (node.options ?? []).filter((o) => o.type === SUB || o.type === GROUP).map((o) => o.name);
            throw new AppError('VALIDATION_ERROR', `\`gv ${[top, ...path.map(p => p.name)].join(' ')}\` needs one of: ${choices.map((c) => `\`${c}\``).join(', ')}.`);
        }
        tokens.shift();
        path.push(next);
        node = next;
    }
    const leafOptions = node.options ?? [];
    const values = new Map();
    const positional = [];
    for (const token of tokens) {
        const named = /^([a-z0-9_-]+):(.*)$/i.exec(token);
        if (named && leafOptions.some(o => o.name === named[1].toLowerCase()))
            values.set(named[1].toLowerCase(), named[2]);
        else
            positional.push(token);
    }
    // Positional words go to the first open option that can take them (a role mention to a role option, a number
    // to a number option…), in the options' declared order. A text option takes words up to the next one that is
    // clearly a value for a later option (`,gv mod ban @x being rude 7` → reason "being rude", 7 days).
    const open = leafOptions.filter(o => !values.has(o.name) && o.type !== 11);
    while (positional.length) {
        const token = positional[0];
        const at = open.findIndex(o => fits(o, token));
        if (at < 0)
            break;
        const option = open.splice(at, 1)[0];
        if (option.type !== 3) {
            values.set(option.name, positional.shift());
            continue;
        }
        const taken = [positional.shift()];
        while (positional.length && !(typed(positional[0]) && open.some(o => o.type !== 3 && fits(o, positional[0])))) {
            if (option.choices?.length)
                break;
            taken.push(positional.shift());
        }
        values.set(option.name, taken.join(' '));
    }
    if (positional.length) {
        const choice = open.find(o => o.choices?.length);
        if (choice)
            throw new AppError('VALIDATION_ERROR', `\`${choice.name}\` must be one of: ${choice.choices.map((c) => `\`${c.value}\``).join(', ')}.`);
        throw new AppError('VALIDATION_ERROR', `Didn't understand \`${positional.join(' ')}\`. ${usage(top, path, leafOptions)}`);
    }
    const missing = leafOptions.filter(o => o.required && !values.has(o.name) && o.type !== 11);
    for (const option of leafOptions.filter(o => o.type === 11))
        values.delete(option.name);
    if (missing.length)
        throw new AppError('VALIDATION_ERROR', `Missing ${missing.map(o => `\`${o.name}\``).join(', ')}. ${usage(top, path, leafOptions)}`);
    const leaf = leafOptions.filter(o => values.has(o.name)).map(o => convert(o, values.get(o.name)));
    let data = leaf;
    for (const step of [...path].reverse())
        data = [{ name: step.name, type: step.type, options: data }];
    return { commandName: command.name, data, fileOption: leafOptions.find(o => o.type === 11)?.name };
}
const HELP_HINT = 'Type `,gv help` for the list.';
function usage(top, path, options) {
    const shown = options.map(o => o.required ? `<${o.name}>` : `[${o.name}]`).join(' ');
    return `Usage: \`,gv ${[top, ...path.map(p => p.name)].join(' ')}${shown ? ` ${shown}` : ''}\``;
}
function convert(option, raw) {
    const base = { name: option.name, type: option.type };
    switch (option.type) {
        case 4:
        case 10: {
            const n = Number(raw);
            if (!Number.isFinite(n) || (option.type === 4 && !Number.isInteger(n)))
                throw new AppError('VALIDATION_ERROR', `\`${option.name}\` must be a number.`);
            return { ...base, value: n };
        }
        case 5: {
            const v = raw.toLowerCase();
            if (['on', 'yes', 'true', 'enable', 'enabled', '1'].includes(v))
                return { ...base, value: true };
            if (['off', 'no', 'false', 'disable', 'disabled', '0'].includes(v))
                return { ...base, value: false };
            throw new AppError('VALIDATION_ERROR', `\`${option.name}\` must be on or off.`);
        }
        case 6:
        case 7:
        case 8:
        case 9: return { ...base, value: ID.exec(raw)?.[1] ?? raw };
        default: {
            const choice = (option.choices ?? []).find((c) => String(c.name).toLowerCase() === raw.toLowerCase() || String(c.value).toLowerCase() === raw.toLowerCase());
            if (option.choices?.length && !choice)
                throw new AppError('VALIDATION_ERROR', `\`${option.name}\` must be one of: ${option.choices.map((c) => `\`${c.value}\``).join(', ')}.`);
            return { ...base, value: choice ? choice.value : raw };
        }
    }
}
/** Turn IDs into the users, members, roles, channels and attachments discord.js puts on an interaction's options. */
export async function resolve(data, guild) {
    const out = [];
    for (const option of data) {
        if (option.type === SUB || option.type === GROUP) {
            out.push({ ...option, options: await resolve(option.options ?? [], guild) });
            continue;
        }
        const value = String(option.value);
        if (option.type === 6 || option.type === 9) {
            const user = /^\d{17,20}$/.test(value) ? await guild.client.users.fetch(value).catch(() => null) : null;
            const role = option.type === 9 && !user ? guild.roles.cache.get(value) ?? guild.roles.cache.find(r => r.name.toLowerCase() === value.toLowerCase()) : null;
            if (!user && !role)
                throw new AppError('VALIDATION_ERROR', `Couldn't find a ${option.type === 6 ? 'user' : 'user or role'} matching \`${value}\`.`);
            const member = user ? await guild.members.fetch(user.id).catch(() => null) : null;
            out.push(user ? { ...option, value: user.id, user, ...(member ? { member } : {}) } : { ...option, value: role.id, role });
            continue;
        }
        if (option.type === 7) {
            const channel = guild.channels.cache.get(value) ?? guild.channels.cache.find(c => c.name.toLowerCase() === value.replace(/^#/, '').toLowerCase());
            if (!channel)
                throw new AppError('VALIDATION_ERROR', `Couldn't find a channel matching \`${value}\`.`);
            out.push({ ...option, value: channel.id, channel });
            continue;
        }
        if (option.type === 8) {
            const role = guild.roles.cache.get(value) ?? guild.roles.cache.find(r => r.name.toLowerCase() === value.replace(/^@/, '').toLowerCase());
            if (!role)
                throw new AppError('VALIDATION_ERROR', `Couldn't find a role matching \`${value}\`.`);
            out.push({ ...option, value: role.id, role });
            continue;
        }
        out.push(option);
    }
    return out;
}
/** A command that takes a file gets the message's first attachment. */
function attach(data, name, file) {
    if (data.length === 1 && (data[0].type === SUB || data[0].type === GROUP))
        return [{ ...data[0], options: attach(data[0].options ?? [], name, file) }];
    return [...data, { name, type: 11, value: file.id, attachment: file }];
}
const strip = (payload) => {
    if (typeof payload === 'string')
        return { content: payload };
    const { ephemeral: _e, fetchReply: _f, withResponse: _w, flags, ...rest } = payload ?? {};
    // Ephemeral replies don't exist outside interactions; keep any other flags (suppressed embeds…).
    const kept = typeof flags === 'number' ? flags & ~MessageFlags.Ephemeral : undefined;
    return gvText({ allowedMentions: { parse: [] }, ...rest, ...(kept ? { flags: kept } : {}) });
};
/**
 * A slash-command interaction made from a message, close enough for Vanguard's command code: replies post in the
 * channel as replies to the member's message (or by DM for developer commands), edits edit that reply, and
 * buttons on it are real buttons. Forms (modals) can't open from a message, so those commands say to use a button.
 */
export class TextCommandInteraction {
    message;
    commandName;
    options;
    privately;
    isTextCommand = true;
    type = 2;
    commandType = 1;
    commandId = null;
    locale = 'en-US';
    deferred = false;
    replied = false;
    ephemeral = false;
    sent = null;
    constructor(message, commandName, options, privately) {
        this.message = message;
        this.commandName = commandName;
        this.options = options;
        this.privately = privately;
    }
    get id() { return `text:${this.message.id}`; }
    get client() { return this.message.client; }
    get user() { return this.message.author; }
    get member() { return this.message.member; }
    get guild() { return this.message.guild; }
    get guildId() { return this.message.guildId; }
    get channel() { return this.message.channel; }
    get channelId() { return this.message.channelId; }
    get applicationId() { return this.message.client.user?.id ?? null; }
    get createdTimestamp() { return this.message.createdTimestamp; }
    get guildLocale() { return this.message.guild.preferredLocale; }
    isCommand() { return true; }
    isChatInputCommand() { return true; }
    isAutocomplete() { return false; }
    isContextMenuCommand() { return false; }
    isButton() { return false; }
    isAnySelectMenu() { return false; }
    isStringSelectMenu() { return false; }
    isModalSubmit() { return false; }
    isMessageComponent() { return false; }
    isRepliable() { return true; }
    inGuild() { return true; }
    inCachedGuild() { return true; }
    inRawGuild() { return false; }
    async post(payload) {
        if (this.privately) {
            const dm = await this.user.send(strip(payload)).catch(() => null);
            if (dm) {
                if (!this.sent)
                    await this.message.reply({ content: '📬 Sent you the answer by DM.', allowedMentions: { parse: [] } }).catch(() => null);
                return dm;
            }
            throw new AppError('VALIDATION_ERROR', 'Open your DMs: developer answers are sent privately.');
        }
        return this.message.reply({ ...strip(payload), failIfNotExists: false });
    }
    async deferReply(options) {
        this.deferred = true;
        this.ephemeral = !!(options?.ephemeral || (typeof options?.flags === 'number' && options.flags & MessageFlags.Ephemeral));
        await this.channel.sendTyping?.().catch(() => null);
    }
    async reply(payload) {
        this.sent = await this.post(payload);
        this.replied = true;
        return this.sent;
    }
    async editReply(payload) {
        if (!this.sent) {
            this.sent = await this.post(payload);
            this.replied = true;
            return this.sent;
        }
        this.sent = await this.sent.edit(strip(payload));
        return this.sent;
    }
    async followUp(payload) { return this.post(payload); }
    async fetchReply() {
        if (!this.sent)
            this.sent = await this.post({ content: '⏳' });
        return this.sent;
    }
    async deleteReply() { }
    async showModal() {
        throw new AppError('VALIDATION_ERROR', 'This one opens a form, which only works from a button. Use the button on Ghost Vanguard\'s panel for it.');
    }
    async awaitModalSubmit() { return this.showModal(); }
}
/** Build the interaction for a message, or throw an AppError that says what's wrong with the command. */
export async function fromMessage(message, tree) {
    const text = commandText(message.content);
    if (text === null)
        throw new AppError('VALIDATION_ERROR', HELP_HINT);
    const parsed = parse(text || 'help', tree);
    let data = await resolve(parsed.data, message.guild);
    const file = message.attachments?.first?.();
    if (parsed.fileOption && file)
        data = attach(data, parsed.fileOption, file);
    const options = new CommandInteractionOptionResolver(message.client, data, {});
    return new TextCommandInteraction(message, parsed.commandName, options, PRIVATE_COMMANDS.has(parsed.commandName));
}
/** Whether a reaction is Veil handing this message over (Veil's own account, the hand-off emoji, a fresh message). */
export function isHandoff(userId, emoji, message, now = Date.now()) {
    if (!TRUSTED_BOTS.has(userId) || emoji !== HANDOFF_EMOJI)
        return false;
    if (message.author?.bot)
        return false;
    // An edited message could now say something Veil never approved.
    if (message.editedTimestamp)
        return false;
    if (now - message.createdTimestamp > HANDOFF_WINDOW_MS)
        return false;
    return commandText(message.content ?? '') !== null;
}
