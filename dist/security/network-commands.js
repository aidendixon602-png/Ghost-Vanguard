import { NO_REASON } from '../core.js';
import { SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../bot/registry.js';
import { clip } from '../core.js';
import { AppError } from '../errors.js';
import { confirmDanger } from '../ui/danger-ui.js';
import { liveProgress, summaryEmbed } from '../ui/network-ui.js';
import { classify, finish, outcomeEmbed, showWorking } from '../ui/progress.js';
import { activeBan, assertTargetable, banEverywhere, createBan, notifyBannedUser, DELETE_MESSAGE_CHOICES, deleteWindow, describeUser, idFrom, KIND_NAME, networkDeps, parseUserId, recordId, resolveTarget, revokeBan, targetServers, unbanEverywhere, } from './network-ban.js';
/**
 * `/genreban`, `/hardban` and their revoke commands share one implementation; only the
 * wording and what enforcement does afterwards differ. Their configured slash ranks still apply.
 */
const POLICY = { category: 'developer', developerOnly: true, requiresAuthorization: false, cooldown: 3000 };
const OTHER = { genreban: 'hardban', hardban: 'genreban' };
const AFTER = {
    genreban: 'While the genreban is active, the bot bans them again if they join any authorized server, including servers authorized later. A Supreme Leader can lift it from the ban-log controls; a Developer can also use `/ungenreban`.',
    hardban: 'While the hardban is active, the bot bans them again whenever they are unbanned or join, and re-checks every server every 10 minutes and after restarts. Only a developer can lift it, with `/unhardban`.',
};
function header(ban, user, fields) {
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
async function refuse(i, error, context) {
    await finish(i, outcomeEmbed('', classify(error, context)));
}
export function issueCommand(kind) {
    const name = KIND_NAME[kind];
    const description = kind === 'hardban'
        ? 'Developer: permanently ban a user from every authorized server until `/unhardban`'
        : 'Developer: ban a user from every authorized server until `/ungenreban`';
    return defineCommand(new SlashCommandBuilder().setName(kind).setDescription(description)
        .addStringOption(o => o.setName('user').setDescription('User ID, @mention or username. IDs work even if they are in no server.').setRequired(true).setMaxLength(40))
        .addStringOption(o => o.setName('reason').setDescription('Reason, shown in every server\'s log and audit log (optional)').setMaxLength(400))
        .addStringOption(o => o.setName('evidence').setDescription('Evidence: links, message IDs or a short description').setMaxLength(1000))
        .addAttachmentOption(o => o.setName('evidence_file').setDescription('Evidence screenshot or file'))
        .addIntegerOption(o => o.setName('delete_messages').setDescription('Also delete their recent messages in every server').addChoices(...DELETE_MESSAGE_CHOICES)), POLICY, async (ctx, i) => {
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
            if (!targetServers(deps).length)
                throw new AppError('VALIDATION_ERROR', 'There are no authorized, ready servers to ban them from. Nothing was recorded.');
        }
        catch (error) {
            return refuse(i, error, kind).then(() => undefined);
        }
        const target = user;
        const reason = (i.options.getString('reason') ?? NO_REASON);
        const evidence = i.options.getString('evidence');
        const file = i.options.getAttachment('evidence_file');
        const evidenceFile = file ? `[${clip(file.name, 80)}](${file.url})` : null;
        const seconds = i.options.getInteger('delete_messages') ?? 0;
        const window = deleteWindow(seconds);
        const count = targetServers(deps).length;
        await confirmDanger(ctx, i, {
            title: kind === 'hardban' ? 'Hardban a user from every authorized server' : 'Genreban a user from every authorized server',
            summary: header(null, target, { reason, evidence, evidenceFile, moderator: i.user.id }),
            consequences: [
                `They are banned from **${count}** authorized server${count === 1 ? '' : 's'}, by user ID, whether or not they are a member.`,
                AFTER[kind].replace(/ Only a developer.*$/, ''),
                window ? `**Their messages from ${window} are permanently deleted in every server.** This cannot be undone.` : 'Their messages are kept.',
                'A separate record is saved, every server\'s log channel is told, and a moderation case is recorded in each server.',
            ],
            label: kind === 'hardban' ? `Hardban in ${count} server${count === 1 ? '' : 's'}` : `Genreban in ${count} server${count === 1 ? '' : 's'}`,
            reversal: `\`/un${kind}\` lifts it in every server where the bot placed it.`,
            run: async (c, b) => {
                let ban;
                try {
                    ban = c.store.transaction(() => {
                        const created = createBan(c.store, { kind, user: target, reason, evidence, evidenceFile, moderator: { id: b.user.id, tag: b.user.tag } });
                        return created;
                    });
                }
                catch (error) {
                    return finish(b, outcomeEmbed('', classify(error, kind)));
                }
                const view = {
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
export function revokeCommand(kind) {
    const name = KIND_NAME[kind];
    const builder = new SlashCommandBuilder().setName(`un${kind}`).setDescription(`Developer: revoke a ${kind} and lift it in every authorized server`)
        .addStringOption(o => o.setName('user').setDescription('User ID, @mention, or the username recorded with the ban').setRequired(true).setMaxLength(40))
        .addStringOption(o => o.setName('reason').setDescription('Reason for lifting it (optional)').setMaxLength(400));
    if (kind === 'hardban')
        builder.addBooleanOption(o => o.setName('unban').setDescription('Also unban them where the hardban banned them (default: yes)'));
    return defineCommand(builder, POLICY, async (ctx, i) => {
        const input = i.options.getString('user', true);
        const reason = (i.options.getString('reason') ?? NO_REASON);
        await showWorking(i, `Revoking ${kind}`, `Looking up the active ${kind} for \`${clip(input, 40)}\`…`);
        let ban;
        try {
            ban = findActive(ctx, kind, input);
            if (!revokeBan(ctx.store, ban, { id: i.user.id, tag: i.user.tag }, reason))
                throw new AppError('VALIDATION_ERROR', `That ${kind} was revoked a moment ago by someone else.`);
        }
        catch (error) {
            await refuse(i, error, `un${kind}`);
            return;
        }
        const user = await ctx.client.users.fetch(ban.user_id).catch(() => ({ id: ban.user_id, tag: ban.username ?? 'Unknown user' }));
        const head = [`**Record:** ${recordId(ban)} · revoked <t:${Math.floor(Date.now() / 1000)}:f>`, describeUser(user), `**Original reason:** ${ban.reason}`, `**Revoked by:** <@${i.user.id}>`, `**Reason:** ${reason}`].join('\n');
        if (kind === 'hardban' && i.options.getBoolean('unban') === false) {
            await finish(i, outcomeEmbed(`${name} ${recordId(ban)} revoked`, { outcome: 'success', reason: `${head}\n\nThe bot will no longer re-ban them. Existing bans were left in place in every server.` }));
            return;
        }
        const view = { working: `Lifting ${kind} ${recordId(ban)}`, verb: 'Unbanned', action: `Un${kind} ${recordId(ban)}`, header: head };
        const results = await unbanEverywhere(networkDeps(ctx), ban, reason, i.user.id, liveProgress(i, view));
        await finish(i, summaryEmbed({ ...view, footer: `The ${kind} is revoked and will not be re-applied. Only bans placed by this ${kind} were lifted; bans placed by a server's own staff, or by another ban type, were left in place.` }, results));
    });
}
function findActive(ctx, kind, input) {
    const id = idFrom(input);
    let ban;
    let userId;
    if (id !== null) {
        userId = parseUserId(input);
        ban = activeBan(ctx.store, kind, userId);
    }
    else {
        const name = input.trim().replace(/^@/, '').replace(/#0$/, '').toLowerCase();
        const rows = ctx.store.all("SELECT * FROM network_bans WHERE status='active' AND kind=? AND lower(username) IN (?,?)", kind, name, `${name}#0`);
        if (rows.length > 1)
            throw new AppError('VALIDATION_ERROR', `More than one active ${kind} matches that username. Use the user ID:\n${rows.map(r => `• ${recordId(r)}: \`${r.user_id}\``).join('\n')}`);
        ban = rows[0];
        userId = ban?.user_id;
    }
    if (ban)
        return ban;
    const other = userId ? activeBan(ctx.store, OTHER[kind], userId) : undefined;
    throw new AppError('VALIDATION_ERROR', `Could not find an active ${kind} for \`${clip(input, 40)}\`.${other ? ` They have an active ${OTHER[kind]} (${recordId(other)}) instead; use \`/un${OTHER[kind]}\`.` : ''}`);
}
