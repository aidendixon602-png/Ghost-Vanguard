import { randomUUID } from 'node:crypto';
export function askLauncher(op, timeoutMs = 20000, proc = process) {
    if (typeof proc.send !== 'function' || !proc.connected)
        return Promise.resolve(null);
    const id = randomUUID();
    return new Promise(resolve => {
        const done = (value) => { clearTimeout(timer); proc.off('message', listen); resolve(value); };
        const listen = (message) => { if (message?.type === 'vg-update-result' && message.id === id)
            done(message); };
        const timer = setTimeout(() => done(null), timeoutMs);
        proc.on('message', listen);
        proc.send({ type: 'vg-update', op, id });
    });
}
const short = (sha) => sha ? `\`${sha.slice(0, 7)}\`` : 'unknown';
export function describeUpdate(s, op) {
    if (!s)
        return 'Automatic updates are not available: the bot was not started with `node launch.js`, or the launcher did not answer.';
    if (!s.enabled)
        return '**Automatic updates are off.** Add `UPDATE_REPO` and `UPDATE_TOKEN` to `.env` and restart to turn them on.';
    const lines = [
        `**Repository:** \`${s.repo}\` · branch \`${s.branch}\``,
        `**Running:** ${short(s.running)}${s.fallback && s.fallback !== s.running ? ` · falls back to ${short(s.fallback)} if it crashes` : ''}`,
        `**Checks:** every ${s.intervalMinutes} minutes · last <t:${Math.floor((s.lastCheck.at || Date.now()) / 1000)}:R>: ${s.lastCheck.result}`,
    ];
    if (s.rejected.length)
        lines.push(`**Skipped versions:** ${s.rejected.map(short).join(', ')}`);
    if (op === 'now' && s.result) {
        const r = s.result;
        lines.unshift(r.state === 'installing' ? `🔄 **Installing ${short(r.sha)} now.** The bot restarts in a few seconds; run \`/dev diagnostics\` in a minute to confirm.`
            : r.state === 'current' ? '✅ **Already on the newest version.**'
                : r.state === 'waiting' ? `⏳ **${short(r.sha)} is waiting:** ${r.why}. It installs by itself once GitHub's tests pass.`
                    : r.state === 'skipped' ? `⏭️ **${short(r.sha)} is skipped:** ${r.why}. Push a fix to install a newer version.`
                        : r.state === 'busy' ? '🔄 **An update is already in progress.**'
                            : r.state === 'error' ? `⚠️ **Could not check GitHub:** ${r.why}`
                                : 'Nothing to update.', '');
    }
    return lines.join('\n');
}
/** Ask launch.js to restart the bot. Resolves true when it accepted (the bot stops a few seconds later). */
export function askRestart(by, timeoutMs = 5000, proc = process) {
    if (typeof proc.send !== 'function' || !proc.connected)
        return Promise.resolve(null);
    const id = randomUUID();
    return new Promise(resolve => {
        const done = (value) => { clearTimeout(timer); proc.off('message', listen); resolve(value); };
        const listen = (message) => { if (message?.type === 'vg-restart-result' && message.id === id)
            done(!!message.ok); };
        const timer = setTimeout(() => done(null), timeoutMs);
        proc.on('message', listen);
        proc.send({ type: 'vg-restart', id, by });
    });
}
/** Set by index.ts: shut down cleanly with a non-zero code so any launch.js (even an old one) starts the bot again. */
export const selfRestart = { run: null };
/** Exit code the launcher treats as "stopped, start again" (anything but 0, which stops the server). */
export const RESTART_EXIT_CODE = 75;
/**
 * Fallback for a launch.js started before /dev restart existed: it does not answer the restart request,
 * but it restarts the bot whenever it stops with a non-zero code. Only after 2.5 minutes of uptime, so the
 * launcher never mistakes it for a freshly installed version crashing (which would roll the update back).
 */
export function fallbackRestart(proc = process, uptimeSeconds = proc.uptime()) {
    if (typeof proc.send !== 'function' || !proc.connected || !selfRestart.run)
        return 'no-launcher';
    if (uptimeSeconds < 150)
        return 'too-soon';
    const run = selfRestart.run;
    setTimeout(() => run(RESTART_EXIT_CODE), 1500).unref?.();
    return 'scheduled';
}
