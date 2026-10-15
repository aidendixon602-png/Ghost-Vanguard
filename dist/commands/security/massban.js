import { NO_REASON } from '../../core.js';
import { Colors, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { embed } from '../../ui/ui.js';
import { confirmDanger } from '../../ui/danger-ui.js';
import { staffReason } from '../../security/raidmode.js';
import { developers } from '../../bot/developers.js';
import { config } from '../../config.js';
import { BOT_BELOW_TARGET, classify, finish } from '../../ui/progress.js';
import { liveProgress, summaryEmbed } from '../../ui/network-ui.js';
import { banTypeFromReason } from '../../security/network-ban.js';
import { caseId, recordExistingBan } from '../../audit/ban-log.js';
function requireMassbanAccess(ctx, guild) {
    const actor = ctx.actor;
    // Many bans in a minute is exactly what anti-nuke stops, so only people anti-nuke already trusts may do it.
    if (!(actor.id === guild.ownerId || actor.id === config.ownerId || developers.has(actor.id) || ctx.security.trusted(guild, actor.id)))
        throw new AppError('PERMISSION_ERROR', 'Mass bans are limited to the server owner, Vanguard developers and staff on the anti-nuke whitelist. Otherwise anti-nuke would treat it as a nuke and punish you.');
}
export function parseIds(text) {
    const ids = [...new Set(text.split(/[\s,;]+/).map(s => s.replace(/[<@!>]/g, '')).filter(Boolean))];
    const bad = ids.filter(id => !/^\d{17,20}$/.test(id));
    if (bad.length)
        throw new AppError('VALIDATION_ERROR', `Not a Discord user ID: ${bad.slice(0, 5).join(', ')}. Paste IDs separated by spaces or commas.`);
    if (!ids.length)
        throw new AppError('VALIDATION_ERROR', 'Paste at least one Discord user ID.');
    if (ids.length > 200)
        throw new AppError('VALIDATION_ERROR', 'At most 200 IDs at once.');
    return ids;
}
export default defineCommand(new SlashCommandBuilder().setName('massban').setDescription('Raid cleanup: ban up to 200 user IDs at once (whitelisted staff only)')
    .addStringOption(o => o.setName('user_ids').setDescription('IDs separated by spaces or commas').setRequired(true).setMaxLength(6000))
    .addStringOption(o => o.setName('reason').setDescription('Reason (optional)').setMaxLength(400))
    .addIntegerOption(o => o.setName('delete_messages').setDescription('Also delete their recent messages (default 24 hours)').addChoices({ name: 'Keep messages', value: 0 }, { name: 'Last hour', value: 3600 }, { name: 'Last 24 hours', value: 86400 }, { name: 'Last 7 days', value: 604800 })), { category: 'security', access: 'security', requiredPermissions: [PermissionFlagsBits.BanMembers], botPermissions: [PermissionFlagsBits.BanMembers], cooldown: 10000 }, async (ctx, i) => {
    const actor = ctx.actor;
    requireMassbanAccess(ctx, i.guild);
    const me = await i.guild.members.fetchMe();
    const protectedIds = new Set([actor.id, me.id, i.guild.ownerId, config.ownerId]);
    const all = parseIds(i.options.getString('user_ids', true));
    const ids = all.filter(id => !protectedIds.has(id) && !developers.has(id) && !ctx.security.trusted(i.guild, id));
    const skipped = all.length - ids.length;
    if (!ids.length)
        throw new AppError('VALIDATION_ERROR', 'Every ID was protected (you, the owner, developers, Vanguard or whitelisted accounts).');
    const reason = (i.options.getString('reason') ?? NO_REASON), seconds = i.options.getInteger('delete_messages') ?? 86400;
    await confirmDanger(ctx, i, {
        title: `Ban ${ids.length} account(s)`, summary: `**Reason:** ${reason}${skipped ? `\n${skipped} protected ID(s) were removed from the list.` : ''}`,
        consequences: [`${ids.length} account(s) are banned, including any not in the server.`, seconds ? 'Their recent messages are permanently deleted.' : 'Their messages are kept.', 'Members above Vanguard\'s role cannot be banned and are reported.', 'One case is recorded per account.'],
        label: `Ban ${ids.length}`, reversal: '`/mod unban` per account. Deleted messages are gone.',
        run: async (c, b) => {
            requireMassbanAccess(c, b.guild);
            // One row per account, shown with the same live progress and summary as network bans.
            const view = { working: `Mass-banning ${ids.length} account(s)`, verb: 'Banned', action: 'Mass ban', unit: 'account',
                header: `**Moderator:** <@${c.actor.id}>\n**Reason:** ${reason}${skipped ? `\n${skipped} protected ID(s) were removed from the list.` : ''}` };
            const progress = liveProgress(b, view);
            // Existing bans with their reasons, so a genreban/hardban is never touched and a local one gets this reason on record.
            const already = await b.guild.bans.fetch({ limit: 1000, cache: false }).then((l) => new Map([...l.entries()].map(([id, ban]) => [id, ban?.reason ?? null])), () => new Map());
            const results = [];
            await progress(0, ids.length, results);
            for (const id of ids) {
                const row = (outcome, why, reference) => ({ guildId: id, name: `\`${id}\``, outcome, reason: why, reference });
                const member = b.guild.members.cache.get(id);
                // Protection may have been granted after the prompt, or while earlier accounts were processed.
                if ([c.actor.id, me.id, b.guild.ownerId, config.ownerId].includes(id) || developers.has(id) || c.security.trusted(b.guild, id))
                    results.push(row('not-allowed', 'This account is now protected; no action was taken.'));
                else if (already.has(id)) {
                    const type = banTypeFromReason(already.get(id) ?? null);
                    if (type !== 'local')
                        results.push(row('already', `Already banned by a ${type}; left as it is.`));
                    else {
                        c.store.recordCase(b.guildId, id, c.actor.id, 'massban', reason, { username: member?.user?.tag ?? null });
                        const { record } = recordExistingBan(c.store, c.logs, b.guildId, { id, tag: member?.user?.tag ?? null }, c.actor.id, reason, null);
                        results.push(row('already', `Already banned; reason added to ${caseId(record)}.`));
                    }
                }
                else if (member && !member.bannable)
                    results.push(row('hierarchy', BOT_BELOW_TARGET));
                else
                    try {
                        await b.guild.members.ban(id, { reason: staffReason(c.actor.id, `massban: ${reason}`), deleteMessageSeconds: seconds });
                        c.store.recordCase(b.guildId, id, c.actor.id, 'massban', reason, { username: member?.user?.tag ?? null });
                        results.push(row('success', member ? 'Banned (was a member).' : 'Banned by user ID.'));
                    }
                    catch (error) {
                        const f = classify(error, 'massban');
                        results.push(row(f.outcome, f.reason, f.reference));
                    }
                await progress(results.length, ids.length, results);
            }
            const banned = results.filter(r => r.outcome === 'success').length, failed = results.filter(r => !['success', 'already'].includes(r.outcome)).length;
            c.logs.push(b.guildId, embed('Mass ban', `By <@${c.actor.id}> · **${banned}** banned${failed ? ` · ${failed} failed` : ''}\n**Reason:** ${reason}`, Colors.Red));
            return finish(b, summaryEmbed(view, results));
        },
    });
});
