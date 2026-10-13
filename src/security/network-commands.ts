import { SlashCommandBuilder } from 'discord.js';
import { defineCommand, type CommandContext } from '../bot/registry.js';
import { clip } from '../core.js';
import { AppError } from '../errors.js';
import { confirmDanger } from '../ui/danger-ui.js';
import { liveProgress, summaryEmbed, type NetworkView } from '../ui/network-ui.js';
import { classify, finish, outcomeEmbed, showWorking } from '../ui/progress.js';
import {
    activeBan, assertTargetable, banEverywhere, createBan, notifyBannedUser, DELETE_MESSAGE_CHOICES, deleteWindow, describeUser, idFrom, KIND_NAME, networkDeps,
    parseUserId, recordId, resolveTarget, revokeBan, targetServers, unbanEverywhere, type NetworkBan, type NetworkKind,
} from './network-ban.js';

/**
 * /network genreban, /network hardban and their revoke commands share one implementation; only the
 * wording and what enforcement does afterwards differ. All four are developer-only.
 */

const POLICY = { category: 'developer', developerOnly: true, requiresAuthorization: false, cooldown: 3000 } as const;

const OTHER: Record<NetworkKind, NetworkKind> = { genreban: 'hardban', hardban: 'genreban' };

const AFTER: Record<NetworkKind, string> = {
    genreban: 'While the genreban is active, the bot bans them again if they join any authorized server, including servers authorized later. Only a developer can lift it, with `/network ungenreban`.',
    hardban: 'While the hardban is active, the bot bans them again whenever they are unbanned or join, and re-checks every server every 10 minutes and after restarts. Only a developer can lift it, with `/network unhardban`.',
};

function header(ban: Pick<NetworkBan, 'id' | 'kind' | 'reason' | 'evidence' | 'evidence_file' | 'moderator_id' | 'created_at'> | null, user: Parameters<typeof describeUser>[0], fields: { reason: string; evidence?: string | null; evidenceFile?: string | null; moderator: string }) {
    return [
        ban ? `**Record:** ${recordId(ban)} · <t:${Math.floor(ban.created_at / 1000)}:f>` : '',
        describeUser(user),
        `**Reason:** ${fields.reason}`,
        fields.evidence ? `**Evidence:** ${clip(fields.evidence, 600)}` : '',
        fields.evidenceFile ? `**Evidence file:** ${fields.evidenceFile}` : '',
        `**Moderator:** <@${fields.moderator}>`,
    ].filter(Boolean).join('\n');
}

/** Turns a failure before any server was touched into a clear final message. */
async function refuse(i: any, error: unknown, context: string) {
    await finish(i, outcomeEmbed('', classify(error, context)));
}

export function issueCommand(kind: NetworkKind) {
    const name = KIND_NAME[kind];
    const description = kind === 'hardban'
        ? 'Developer: permanently ban a user from every authorized server until /network unhardban'
        : 'Developer: ban a user from every authorized server until /network ungenreban';
    return defineCommand(new SlashCommandBuilder().setName(kind).setDescription(description)
        .addStringOption(o => o.setName('user').setDescription('User ID, @mention or username. IDs work even if they are in no server.').setRequired(true).setMaxLength(40))
        .addStringOption(o => o.setName('reason').setDescription('Reason, shown in every server\'s log and audit log').setRequired(true).setMaxLength(400))
        .addStringOption(o => o.setName('evidence').setDescription('Evidence: links, message IDs or a short description').setMaxLength(1000))
        .addAttachmentOption(o => o.setName('evidence_file').setDescription('Evidence screenshot or file'))
        .addIntegerOption(o => o.setName('delete_messages').setDescription('Also delete their recent messages in every server').addChoices(...DELETE_MESSAGE_CHOICES)),
    POLICY, async (ctx: CommandContext, i) => {
        const deps = networkDeps(ctx);
        const input = i.options.getString('user', true);
        await showWorking(i, `Preparing ${kind}`, `Looking up \`${clip(input, 40)}\` and checking existing bans…`);
        let user;
        try {
            user = await resolveTarget(deps, input);
            assertTargetable(ctx.client, user.id, i.user.id);
            const existing = activeBan(ctx.store, kind, user.id);
            if (existing)
                throw new AppError('VALIDATION_ERROR', `${describeUser(user)}\nalready has an active ${kind}, **${recordId(existing)}**, since <t:${Math.floor(existing.created_at / 1000)}:R> by <@${existing.moderator_id}>. No duplicate record was created.`);
            const covering = kind === 'genreban' ? activeBan(ctx.store, 'hardban', user.id) : undefined;
            if (covering)
                throw new AppError('VALIDATION_ERROR', `${describeUser(user)}\nalready has an active hardban, **${recordId(covering)}**, which already bans them everywhere. No genreban was created.`);
            if (!targetServers(deps).length)
                throw new AppError('VALIDATION_ERROR', 'There are no authorized, ready servers to ban them from. Nothing was recorded.');
        } catch (error) {
            return refuse(i, error, kind).then(() => undefined);
        }
        const target = user;
        const reason = i.options.getString('reason', true);
        const evidence = i.options.getString('evidence');
        const file = i.options.getAttachment('evidence_file');
        const evidenceFile = file ? `[${clip(file.name, 80)}](${file.url})` : null;
        const seconds = i.options.getInteger('delete_messages') ?? 0;
        const window = deleteWindow(seconds);
        const count = targetServers(deps).length;
        const replaces = kind === 'hardban' ? activeBan(ctx.store, 'genreban', target.id) : undefined;
        await confirmDanger(ctx, i, {
            title: kind === 'hardban' ? 'Hardban a user from every authorized server' : 'Genreban a user from every authorized server',
            summary: header(null, target, { reason, evidence, evidenceFile, moderator: i.user.id }),
            consequences: [
                `They are banned from **${count}** authorized server${count === 1 ? '' : 's'}, by user ID, whether or not they are a member.`,
                AFTER[kind].replace(/ Only a developer.*$/, ''),
                window ? `**Their messages from ${window} are permanently deleted in every server.** This cannot be undone.` : 'Their messages are kept.',
                replaces ? `Their active genreban **${recordId(replaces)}** is closed and replaced by this hardban.` : 'A record is saved, every server\'s log channel is told, and a moderation case is recorded in each server.',
            ],
            label: kind === 'hardban' ? `Hardban in ${count} server${count === 1 ? '' : 's'}` : `Genreban in ${count} server${count === 1 ? '' : 's'}`,
            reversal: `\`/network un${kind}\` lifts it in every server where the bot placed it.`,
            run: async (c, b) => {
                let ban: NetworkBan;
                try {
                    ban = c.store.transaction(() => {
                        const created = createBan(c.store, { kind, user: target, reason, evidence, evidenceFile, moderator: { id: b.user.id, tag: b.user.tag } });
                        const old = kind === 'hardban' ? activeBan(c.store, 'genreban', target.id) : undefined;
                        if (old)
                            revokeBan(c.store, old, { id: b.user.id, tag: b.user.tag }, `Replaced by hardban ${recordId(created)}`);
                        return created;
                    });
                } catch (error) {
                    return finish(b, outcomeEmbed('', classify(error, kind)));
                }
                const view: NetworkView = {
                    working: `Applying ${kind} ${recordId(ban)}`, verb: 'Banned', action: `${name} ${recordId(ban)}`,
                    header: header(ban, target, { reason, evidence, evidenceFile, moderator: b.user.id }),
                };
                // Tell them first: once every shared server has banned them, Discord no longer allows a DM.
                const dm = await notifyBannedUser(c.client, ban, targetServers(networkDeps(c)).length);
                const results = await banEverywhere(networkDeps(c), ban, seconds, liveProgress(b, view));
                const failedSome = results.some(r => !['success', 'already', 'skipped'].includes(r.outcome));
                return finish(b, summaryEmbed({ ...view, footer: `**DM to the user:** ${dm ? 'delivered, with the reason and record ID.' : 'not delivered (their DMs are closed, or they share no server with the bot).'}\n${AFTER[kind]}${failedSome ? (kind === 'hardban' ? '\nFailed servers are retried automatically every 10 minutes; fixing the bot’s permissions there is enough.' : '\nIn failed servers they are banned as soon as they join, once the bot’s permissions are fixed.') : ''}` }, results));
            },
        });
    });
}

export function revokeCommand(kind: NetworkKind) {
    const name = KIND_NAME[kind];
    const builder = new SlashCommandBuilder().setName(`un${kind}`).setDescription(`Developer: revoke a ${kind} and lift it in every authorized server`)
        .addStringOption(o => o.setName('user').setDescription('User ID, @mention, or the username recorded with the ban').setRequired(true).setMaxLength(40))
        .addStringOption(o => o.setName('reason').setDescription('Reason for lifting it').setRequired(true).setMaxLength(400));
    if (kind === 'hardban')
        builder.addBooleanOption(o => o.setName('unban').setDescription('Also unban them where the hardban banned them (default: yes)'));
    return defineCommand(builder, POLICY, async (ctx: CommandContext, i) => {
        const input = i.options.getString('user', true);
        const reason = i.options.getString('reason', true);
        await showWorking(i, `Revoking ${kind}`, `Looking up the active ${kind} for \`${clip(input, 40)}\`…`);
        let ban: NetworkBan;
        try {
            ban = findActive(ctx, kind, input);
            if (!revokeBan(ctx.store, ban, { id: i.user.id, tag: i.user.tag }, reason))
                throw new AppError('VALIDATION_ERROR', `That ${kind} was revoked a moment ago by someone else.`);
        } catch (error) {
            await refuse(i, error, `un${kind}`);
            return;
        }
        const user = await ctx.client.users.fetch(ban.user_id).catch(() => ({ id: ban.user_id, tag: ban.username ?? 'Unknown user' }));
        const head = [`**Record:** ${recordId(ban)} · revoked <t:${Math.floor(Date.now() / 1000)}:f>`, describeUser(user), `**Original reason:** ${ban.reason}`, `**Revoked by:** <@${i.user.id}>`, `**Reason:** ${reason}`].join('\n');
        if (kind === 'hardban' && i.options.getBoolean('unban') === false) {
            await finish(i, outcomeEmbed(`${name} ${recordId(ban)} revoked`, { outcome: 'success', reason: `${head}\n\nThe bot will no longer re-ban them. Existing bans were left in place in every server.` }));
            return;
        }
        const view: NetworkView = { working: `Lifting ${kind} ${recordId(ban)}`, verb: 'Unbanned', action: `Un${kind} ${recordId(ban)}`, header: head };
        const results = await unbanEverywhere(networkDeps(ctx), ban, reason, i.user.id, liveProgress(i, view));
        await finish(i, summaryEmbed({ ...view, footer: `The ${kind} is revoked and will not be re-applied. Only bans placed by this ${kind} were lifted; bans placed by a server's own staff, or by another ban type, were left in place.` }, results));
    });
}

function findActive(ctx: CommandContext, kind: NetworkKind, input: string): NetworkBan {
    const id = idFrom(input);
    let ban: NetworkBan | undefined;
    let userId: string | undefined;
    if (id !== null) {
        userId = parseUserId(input);
        ban = activeBan(ctx.store, kind, userId);
    } else {
        const name = input.trim().replace(/^@/, '').replace(/#0$/, '').toLowerCase();
        const rows = ctx.store.all("SELECT * FROM network_bans WHERE status='active' AND kind=? AND lower(username) IN (?,?)", kind, name, `${name}#0`) as unknown as NetworkBan[];
        if (rows.length > 1)
            throw new AppError('VALIDATION_ERROR', `More than one active ${kind} matches that username. Use the user ID:\n${rows.map(r => `• ${recordId(r)}: \`${r.user_id}\``).join('\n')}`);
        ban = rows[0];
        userId = ban?.user_id;
    }
    if (ban)
        return ban;
    const other = userId ? activeBan(ctx.store, OTHER[kind], userId) : undefined;
    throw new AppError('VALIDATION_ERROR', `Could not find an active ${kind} for \`${clip(input, 40)}\`.${other ? ` They have an active ${OTHER[kind]} (${recordId(other)}) instead; use \`/network un${OTHER[kind]}\`.` : ''}`);
}
