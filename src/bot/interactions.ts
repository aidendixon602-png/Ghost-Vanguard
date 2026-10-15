import { Colors, type Interaction } from 'discord.js';
import { KeyedQueue } from '../core.js';
import { BUSY_MESSAGE } from '../recovery/recovery.js';
import { AppError, logEvent } from '../errors.js';
import { Guard } from './guard.js';
import { validateArguments, type CommandContext, type Policy, type Services } from './registry.js';
import { acknowledge, commandFailure, respond } from './responses.js';
import { ReplyPanels } from './reply-panels.js';
import { routeInteraction } from './command-tree.js';

export class Interactions {
    readonly guard: Guard;
    readonly queue = new KeyedQueue();
    readonly panels = new ReplyPanels();
    private depths = new Map<string, number>();
    private seen = new Map<string, number>();

    constructor(readonly services: Services) {
        this.guard = new Guard(services.store, id => services.lifecycle.isReady(id));
    }

    async handle(i: Interaction) {
        if (!(i.isCommand() || i.isAutocomplete() || i.isButton() || i.isAnySelectMenu() || i.isModalSubmit()))
            return;
        if (this.seen.has(i.id))
            return;
        // Grouped commands (/mod ban, /security automod links) run their original module.
        i = this.panels.wrap(routeInteraction(i));
        this.seen.set(i.id, Date.now());
        for (const [id, at] of this.seen)
            if (at < Date.now() - 900000)
                this.seen.delete(id);
        const start = Date.now();
        let name = 'unknown', path = '', policy: Policy | undefined, execute: any;
        try {
            const registry = this.services.registry;
            if (i.isCommand() || i.isAutocomplete()) {
                name = i.commandName;
                const type = i.isAutocomplete() ? 1 : i.commandType;
                const def = registry.commands.get(`${type}:${name}`);
                if (!def)
                    throw new AppError('VALIDATION_ERROR', 'This command was replaced. Refresh Discord and use /help.');
                policy = registry.policy(def, i);
                if (i.isChatInputCommand() || i.isAutocomplete()) {
                    path = [i.options.getSubcommandGroup(false), i.options.getSubcommand(false)].filter(Boolean).join('/');
                    if (!i.isAutocomplete())
                        validateArguments(def.data, i.options.data);
                }
                if (i.isAutocomplete()) {
                    if (!def.autocomplete)
                        throw new AppError('VALIDATION_ERROR', 'Autocomplete is unavailable for this command.');
                    execute = def.autocomplete;
                } else
                    execute = def.execute;
            } else {
                const kind = i.isButton() ? 'button' : i.isAnySelectMenu() ? 'select' : 'modal';
                name = i.customId.split(':')[0]!;
                const def = registry.components.find(c => c.kinds.includes(kind) && i.customId.startsWith(c.prefix));
                if (!def)
                    throw new AppError('VALIDATION_ERROR', 'This control is no longer available. Run its command again.');
                policy = def.metadata;
                execute = def.execute;
            }
            // No DB/network/queue awaits before ACK. Validation above is synchronous.
            // A 'modal' policy stays unacknowledged: Discord rejects a modal on a deferred interaction.
            if (policy.deferral !== 'modal')
                await acknowledge(i, policy.ephemeralDefault);
            const actor = await this.guard.check(i, policy, `${name}/${path}`, !i.isAutocomplete());
            const context: CommandContext = { ...this.services, actor, policy, actionKey:`${name}/${path}`, serialize:work=>this.queue.run(i.guildId!,work), assertActive: () => {
                    if (policy!.requiresAuthorization)
                        this.services.store.assertAuthorized(i.guildId!);
                } };
            const guildId = i.guildId!;
            const recovery = name === 'restore' || name === 'snapshotdelete' || name === 'snapshot' && ['create', 'restore', 'delete'].includes(path) || name === 'backup' || name === 'copylayout';
            if (recovery) {
                const pending = i.isButton() ? this.services.confirmations.get(i.customId.slice('restore:'.length)) : undefined;
                const destination = pending?.destination ?? (i.isChatInputCommand() && name === 'copylayout' ? i.options.getString('destination_id') : null);
                if (this.services.snapshots.locks.busy(guildId) || destination && this.services.snapshots.locks.busy(destination))
                    throw new AppError('VALIDATION_ERROR', BUSY_MESSAGE);
            }
            const depth = this.depths.get(guildId) ?? 0;
            if (depth >= 50)
                throw new AppError('RATE_LIMIT_ERROR', 'This server has too many pending actions. Try again shortly.');
            this.depths.set(guildId, depth + 1);
            try {
                // Authorized work per guild is serialized; lifecycle commands skip it so revocation is immediate.
                const run = async () => {
                    // Modal commands must answer within three seconds, so the member is not re-fetched.
                    context.actor = await this.guard.check(i, policy!, `${name}/${path}`, false, policy!.requiresAuthorization && policy!.deferral !== 'modal');
                    if (policy!.requiresAuthorization)
                        return this.services.store.withAuthorized(guildId, async () => {
                            const result = await execute(context, i);
                            context.stats?.invalidate();
                            context.assertActive();
                            return result;
                        });
                    return execute(context, i);
                };
                const result = policy.requiresAuthorization && !recovery ? await this.queue.run(guildId, run) : await run();
                if (typeof result === 'string' && !i.isAutocomplete())
                    await respond(i, result, policy.responseKind === 'info' ? 'Ghost Vanguard · Information' : '✓ Action completed', policy.responseKind === 'info' ? Colors.Blurple : Colors.Green);
            } finally {
                this.depths.set(guildId, Math.max(0, (this.depths.get(guildId) ?? 1) - 1));
            }
            logEvent('command_activity', { command: name, subcommand: path, user: i.user.tag, userId: i.user.id, guildId, guild: i.inCachedGuild() ? i.guild.name : null, durationMs: Date.now() - start, result: 'success' });
        } catch (error) {
            await commandFailure(i, error, name, { subcommand: path, user: i.user.tag, guild: i.inCachedGuild() ? i.guild.name : null, durationMs: Date.now() - start, result: 'failure' });
        }
    }

    clearGuild(id: string) {
        this.panels.clearGuild(id);
        this.guard.clearGuild(id);
        this.depths.delete(id);
        for (const [key, value] of this.services.confirmations)
            if (value.guild === id)
                this.services.confirmations.delete(key);
    }
}
