import { Colors } from 'discord.js';
import { embed } from './ui.js';
/**
 * The live message for a ban or unban that runs across every authorized server: a
 * progress bar while it works, then a result that says whether it succeeded,
 * partially succeeded, or failed, with every server that did not work and why.
 */
const ICON = {
    'success': '✅',
    'already': '➖',
    'skipped': '➖',
    'missing-permissions': '⛔',
    'hierarchy': '⛔',
    'not-allowed': '⛔',
    'invalid-target': '✕',
    'rate-limited': '✕',
    'failed': '✕',
};
const LABEL = {
    'success': '',
    'already': 'Already done',
    'skipped': 'Nothing to do',
    'missing-permissions': 'Missing permissions',
    'hierarchy': 'Role hierarchy',
    'not-allowed': 'Not allowed',
    'invalid-target': 'Invalid user',
    'rate-limited': 'Rate limited',
    'failed': 'Error',
};
const DONE = ['success', 'already', 'skipped'];
export function tally(results) {
    const count = (...outcomes) => results.filter(r => outcomes.includes(r.outcome)).length;
    return {
        success: count('success'),
        unchanged: count('already', 'skipped'),
        failed: results.filter(r => !DONE.includes(r.outcome)).length,
        permissions: count('missing-permissions'),
        hierarchy: count('hierarchy'),
        other: count('not-allowed', 'invalid-target', 'rate-limited', 'failed'),
    };
}
function tallyLines(results, verb) {
    const t = tally(results);
    return [
        `✅ ${verb}: **${t.success}**`,
        t.unchanged ? `➖ Already done / nothing to do: **${t.unchanged}**` : '',
        `✕ Failed: **${t.failed}**${t.failed ? ` (missing permissions ${t.permissions} · role hierarchy ${t.hierarchy} · other ${t.other})` : ''}`,
    ].filter(Boolean).join('\n');
}
function bar(done, total, unit) {
    const width = 12, filled = total ? Math.round(done / total * width) : width;
    return `\`${'█'.repeat(filled)}${'░'.repeat(width - filled)}\` ${done}/${total} ${unit}s`;
}
export function progressEmbed(view, done, total, results) {
    return embed(`⏳ ${view.working}`, `${view.header}\n\n${bar(done, total, view.unit ?? 'server')}\n${tallyLines(results, view.verb)}\n\n_Working… this message updates as each ${view.unit ?? 'server'} finishes._`, Colors.Yellow);
}
export function overall(results) {
    const t = tally(results);
    if (!results.length)
        return 'none';
    if (!t.failed)
        return t.success ? 'succeeded' : 'unchanged';
    return t.success || t.unchanged ? 'partial' : 'failed';
}
export function summaryEmbed(view, results) {
    const t = tally(results);
    const total = results.length;
    const state = overall(results);
    const unit = view.unit ?? 'server';
    const servers = (n) => `${n} ${unit}${n === 1 ? '' : 's'}`;
    const title = {
        none: `✕ ${view.action} failed: no ${unit === 'server' ? 'authorized servers' : `${unit}s`} to act on`,
        succeeded: `✅ ${view.action} succeeded in ${t.unchanged ? `${t.success + t.unchanged} of ${servers(total)}` : `all ${servers(total)}`}`,
        unchanged: `➖ ${view.action}: nothing needed changing in ${servers(total)}`,
        partial: `⚠ ${view.action} partially succeeded: ${t.success + t.unchanged} of ${servers(total)}`,
        failed: `✕ ${view.action} failed in all ${servers(total)}`,
    }[state];
    const color = state === 'succeeded' ? Colors.Green : state === 'partial' ? Colors.Orange : state === 'unchanged' ? Colors.Grey : Colors.Red;
    const problems = results.filter(r => !DONE.includes(r.outcome));
    const lines = problems.slice(0, 20).map(r => `${ICON[r.outcome]} **${r.name}** · ${LABEL[r.outcome]}: ${r.reason}${r.reference ? ` (ref ${r.reference})` : ''}`);
    if (problems.length > 20)
        lines.push(`…and ${problems.length - 20} more.${unit === 'server' ? ' Every server\'s result is saved with the record.' : ''}`);
    return embed(title, [
        view.header,
        '',
        `**${unit[0].toUpperCase()}${unit.slice(1)}s:** ${servers(total)} · ${tallyLines(results, view.verb).split('\n').join(' · ')}`,
        lines.length ? `\n**Failed ${unit}s**\n${lines.join('\n')}` : '',
        view.footer ? `\n${view.footer}` : '',
    ].filter(s => s !== '').join('\n'), color);
}
/** Progress callback that edits the reply, at most every 1.5 seconds plus the first and last update. */
export function liveProgress(i, view) {
    let last = 0;
    return async (done, total, results) => {
        if (done !== 0 && done !== total && Date.now() - last < 1500)
            return;
        last = Date.now();
        try {
            await i.editReply({ embeds: [progressEmbed(view, done, total, results)], components: [], allowedMentions: { parse: [] } });
        }
        catch { }
    };
}
