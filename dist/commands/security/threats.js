import { Colors, SlashCommandBuilder } from 'discord.js';
import { defineCommand } from '../../bot/registry.js';
import { AppError } from '../../errors.js';
import { clip } from '../../core.js';
import { embed } from '../../ui/ui.js';
import { boardSummary, board, clearThreat, decayedScore, levelFor, levelLabel, recordThreatAction, threatActions, threatEvents, threatFor, THREAT_POINTS } from '../../security/threat-board.js';
import { rankOf, RANKS } from '../../bot/ranks.js';
import { developers } from '../../bot/developers.js';
/**
 * /antinuke threats — the information board of who may be attacking, what they did, and what staff
 * have done about it. Read-only for staff up to Admin; acting on someone (strike or release) needs
 * the Head Admin rank, because it can ban people. Scores never trigger automatic enforcement.
 */
const watched = (ctx, guildId, userId) => threatFor(ctx.store, guildId, userId);
function boardText(ctx, guildId) {
    const summary = boardSummary(ctx.store, guildId);
    if (!summary.total)
        return '🕊️ **Nothing on the board.** Nobody has crossed into suspicion in the last week.';
    const rows = board(ctx.store, guildId, 15).map(row => {
        const score = decayedScore(row);
        const what = THREAT_POINTS[row.last_rule]?.label ?? row.last_rule;
        return `${levelLabel(levelFor(score))} · **${score}** points · <@${row.user_id}>\n-# ${what} · <t:${Math.floor(row.last_at / 1000)}:R>${row.last_action ? ` · last action: ${row.last_action}` : ''}${row.strikes ? ` · strikes: ${row.strikes}` : ''}`;
    });
    return [
        `**Threat board** — ${summary.total} watched · ${summary.critical} critical · ${summary.high} high · ${summary.watch} watch`,
        rows.join('\n'),
        '-# Scoring: every anti-nuke incident, confirmed scam and mention-spam adds points. 25 = Watch, 55 = High, 85 = Critical.',
        '-# Automatic containment, strikes and log posts are off. Staff review the board and choose any manual action.',
        '-# Scores halve each quiet day and drop off the board after a week.',
    ].join('\n');
}
export default defineCommand(new SlashCommandBuilder().setName('threats').setDescription('Who may be attacking, and what the bot did about it')
    .addSubcommand(s => s.setName('list').setDescription('The threat board for this server'))
    .addSubcommand(s => s.setName('view').setDescription('Everything recorded about one member')
    .addUserOption(o => o.setName('member').setDescription('Who to look at').setRequired(true)))
    .addSubcommand(s => s.setName('clear').setDescription('Clear a member from the board (nothing else changes)')
    .addUserOption(o => o.setName('member').setDescription('Who to clear').setRequired(true)))
    .addSubcommand(s => s.setName('release').setDescription('Undo a strike: unban and clear the board entry')
    .addUserOption(o => o.setName('member').setDescription('Who to release').setRequired(true)))
    .addSubcommand(s => s.setName('strike').setDescription('Counter-attack now: strip, put their damage back and ban')
    .addUserOption(o => o.setName('member').setDescription('Who to strike').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Why (recorded on their case)').setMaxLength(300))), { category: 'security', cooldown: 1500, access: 'member' }, async (ctx, i) => {
    const sub = i.options.getSubcommand(true);
    const guild = i.guild;
    if (sub === 'list') {
        if (rankOf(ctx.store, i.guildId, i.user.id, ctx.actor) < RANKS.admin && !developers.has(i.user.id))
            throw new AppError('PERMISSION_ERROR', 'You need the Admin rank to see the threat board.');
        await i.editReply({ embeds: [embed('Threat board', boardText(ctx, i.guildId), Colors.Blurple)] });
        return;
    }
    const member = i.options.getMember('member');
    if (!member)
        throw new AppError('VALIDATION_ERROR', 'That member is not in this server.');
    if (sub === 'view') {
        if (rankOf(ctx.store, i.guildId, i.user.id, ctx.actor) < RANKS.admin && !developers.has(i.user.id))
            throw new AppError('PERMISSION_ERROR', 'You need the Admin rank to see the threat board.');
        const row = watched(ctx, i.guildId, member.id);
        if (!row || row.cleared_at)
            return `🕊️ **${member.displayName}** is not on the threat board. Nothing has been scored against them.`;
        const score = decayedScore(row);
        const events = threatEvents(ctx.store, i.guildId, member.id, 8)
            .map(e => `• ${levelLabel(levelFor(score))} **+${e.points}** · ${THREAT_POINTS[e.rule]?.label ?? e.rule} · <t:${Math.floor(e.at / 1000)}:R>\n   ${clip(e.detail, 160)}`);
        const actions = threatActions(ctx.store, i.guildId, 15).filter(a => a.user_id === member.id)
            .map(a => `• **${a.action}** by <@${a.by_id}> · <t:${Math.floor(a.at / 1000)}:R>\n   ${clip(a.detail, 160)}`);
        const card = embed(`${levelLabel(levelFor(score))} · ${member.displayName} · ${score} points`, [
            `**On the board since:** <t:${Math.floor(row.first_at / 1000)}:R> · **Last incident:** <t:${Math.floor(row.last_at / 1000)}:R>`,
            `**Strikes taken:** ${row.strikes}${row.last_action ? ` · **Last action:** ${row.last_action}` : ''}`,
            `**What they did**`, events.join('\n') || '• Nothing recorded yet.',
            `**Staff action history**`, actions.join('\n') || '• No staff action has been recorded.',
            '**Automatic response:** Off. This score never contains, strikes or posts an automatic log card. Review the evidence and use the manual controls if needed.',
        ].join('\n'), Colors.Orange);
        card.setThumbnail(member.displayAvatarURL());
        await i.editReply({ embeds: [card] });
        return;
    }
    // Everything below can change someone's standing, so it needs the Head Admin rank (or a developer).
    if (rankOf(ctx.store, i.guildId, i.user.id, ctx.actor, 'threats/strike') < RANKS.headadmin && !developers.has(i.user.id))
        throw new AppError('PERMISSION_ERROR', "Clearing, releasing or striking someone needs the Head Admin rank (or a developer).");
    const row = watched(ctx, i.guildId, member.id);
    if (sub === 'clear') {
        if (!row || row.cleared_at)
            throw new AppError('VALIDATION_ERROR', `${member.displayName} is not on the threat board.`);
        clearThreat(ctx.store, i.guildId, member.id, i.user.id);
        return `🕊️ Removed **${member.displayName}** from the board. Their cases, notes and any ban stay exactly as they are.`;
    }
    if (sub === 'release') {
        let unbanned = false;
        try {
            await guild.bans.remove(member.id, `Ghost Vanguard: threat board release by ${i.user.tag}`);
            unbanned = true;
        }
        catch {
            // Not banned, or missing Ban Members: releasing the board entry is still worth doing.
        }
        const cleared = clearThreat(ctx.store, i.guildId, member.id, i.user.id);
        recordThreatAction(ctx.store, i.guildId, member.id, 'release', `Released by <@${i.user.id}>${unbanned ? ' (unbanned)' : ' (was not banned)'}${cleared ? '' : ' (nothing was on the board)'}`, i.user.id);
        return `🕊️ **${member.displayName} released.** ${unbanned ? 'Their ban is lifted and ' : ''}${cleared ? 'the board entry is cleared' : 'there was nothing on the board to clear'}. Their roles are not restored automatically — use \`/mod role restore\` or the control panel if you want them back.`;
    }
    // strike: an explicit staff action, never something the score starts by itself.
    const reason = i.options.getString('reason')?.trim() || 'Manual counter-attack from the threat board';
    const stripped = await ctx.security.contain(guild, member.id);
    const banned = await guild.bans.create(member.id, { reason: `Ghost Vanguard: ${clip(reason, 300)} (by ${i.user.tag})` }).then(() => true).catch(() => false);
    const caseNumber = ctx.store.recordCase(i.guildId, member.id, i.user.id, 'strike', reason, { username: member.user.tag });
    recordThreatAction(ctx.store, i.guildId, member.id, 'strike', `${reason} — ${stripped}${banned ? ' Banned.' : ' Ban failed.'}`, i.user.id);
    if (row)
        ctx.store.run('UPDATE threat_scores SET score=MAX(score, 100), level=? WHERE guild_id=? AND user_id=?', 'critical', i.guildId, member.id);
    return [
        `⚔️ **Strike on ${member.displayName}.** Case #${caseNumber}.`,
        `**Defence:** ${stripped}`,
        banned ? '**Counter-attack:** banned.' : '**Counter-attack failed** — check my Ban Members permission and my role position.',
        '-# Everything above is recorded: `/antinuke threats view` shows it, `/antinuke threats release` undoes it.',
    ].join('\n');
});
