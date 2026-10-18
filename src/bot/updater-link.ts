import { randomUUID } from 'node:crypto';

/**
 * Talks to launch.js, which runs the bot and installs updates from GitHub. Only available when
 * the bot was started by launch.js (it gives the bot a private message channel).
 */
export interface UpdateStatus {
    enabled: boolean; why?: string | null; repo: string | null; branch: string; running: string | null; fallback: string | null;
    intervalMinutes: number; lastCheck: { at: number; result: string }; rejected: string[];
    result?: { state: string; sha?: string; why?: string };
}

export function askLauncher(op: 'status' | 'now', timeoutMs = 20000, proc: NodeJS.Process = process): Promise<UpdateStatus | null> {
    if (typeof proc.send !== 'function' || !proc.connected) return Promise.resolve(null);
    const id = randomUUID();
    return new Promise(resolve => {
        const done = (value: UpdateStatus | null) => { clearTimeout(timer); proc.off('message', listen); resolve(value); };
        const listen = (message: any) => { if (message?.type === 'vg-update-result' && message.id === id) done(message as UpdateStatus); };
        const timer = setTimeout(() => done(null), timeoutMs);
        proc.on('message', listen);
        proc.send!({ type: 'vg-update', op, id });
    });
}

const short = (sha?: string | null) => sha ? `\`${sha.slice(0, 7)}\`` : '`unknown`';
const validRepo = (repo: string | null | undefined) => !!repo && /^[\w.-]+\/[\w.-]+$/.test(repo);

function repoLink(repo: string | null) {
    return validRepo(repo) ? `[${repo}](https://github.com/${repo})` : repo ? `\`${repo.replace(/`/g, '')}\`` : '`not configured`';
}

function commitLink(repo: string | null, sha?: string | null) {
    if (!sha) return '`unknown`';
    const label = short(sha);
    return validRepo(repo) && /^[a-f0-9]{7,40}$/i.test(sha)
        ? `[${label}](https://github.com/${repo}/commit/${sha})`
        : label;
}

function lastCheckLabel(result: string) {
    if (result === 'current') return '✅ Up to date';
    if (result === 'not checked yet') return '⏳ No check has completed yet';
    if (result === 'installing') return '🔄 Update installing';
    if (result === 'installed') return '✅ Update installed';
    if (result === 'skipped') return '⏭️ Update skipped';
    if (result === 'none') return 'ℹ️ No eligible update found';
    if (result === 'busy') return '🔄 Update already in progress';
    if (/^waiting/i.test(result)) return `⏳ ${result}`;
    if (/^check failed:/i.test(result)) return `⚠️ ${result}`;
    if (result === 'error') return '⚠️ Check failed';
    return `ℹ️ ${result || 'Status unavailable'}`;
}

function nowResult(s: UpdateStatus, interval: string) {
    const r = s.result;
    if (!r) return '';
    if (r.state === 'installing')
        return `🔄 **Installing ${commitLink(s.repo, r.sha)}**\nGhost Vanguard is restarting to load it. Check \`/dev update\` again in a moment.`;
    if (r.state === 'installed')
        return `✅ **Update installed:** ${commitLink(s.repo, r.sha)}\nThe bot is starting on the new version now.`;
    if (r.state === 'current') return '✅ **You’re up to date.** No newer passing version is available.';
    if (r.state === 'waiting')
        return `⏳ **Update found, but it isn’t ready yet:** ${commitLink(s.repo, r.sha)}\n${r.why || 'GitHub checks are still running.'} It will install automatically once checks pass.`;
    if (r.state === 'skipped')
        return `⏭️ **Version skipped:** ${commitLink(s.repo, r.sha)}\n${r.why || 'It previously failed to install.'} Push a fix to install a newer version.`;
    if (r.state === 'busy') return '🔄 **An update is already in progress.** Try again in a minute.';
    if (r.state === 'error') return `⚠️ **GitHub check failed:** ${r.why || 'No details were returned.'}\nAutomatic checks will retry every ${interval}.`;
    if (r.state === 'none') return 'ℹ️ **No eligible update found.** Check the configured branch and GitHub Actions status.';
    return `ℹ️ **Update check complete:** ${r.state}.`;
}

/** A readable, linked status card. Keeps the first-launch state honest: no fake "just checked" timestamp. */
export function describeUpdate(s: UpdateStatus | null, op: 'status' | 'now'): string {
    if (!s) return '⚠️ **Launcher connection unavailable**\nThe bot was not started with `node launch.js`, or the launcher did not answer. On Wispbyte, keep the startup command `cd /home/container && node launch.js`, then try again.';
    if (!s.enabled) {
        const reason = s.why || 'Add `UPDATE_REPO` and `UPDATE_TOKEN` to `.env`.';
        const reasonText = /[.!?]$/.test(reason) ? reason : `${reason}.`;
        return `🟠 **Automatic updates are off**\n**Reason:** ${reasonText}\n\nFix the \`.env\` settings, then press Restart in the hosting panel. Your token is never displayed here.`;
    }

    const interval = `${s.intervalMinutes} ${s.intervalMinutes === 1 ? 'minute' : 'minutes'}`;
    const check = s.lastCheck ?? { at: 0, result: 'not checked yet' };
    const checkedAt = Number.isFinite(check.at) && check.at > 0 ? ` · <t:${Math.floor(check.at / 1000)}:R>` : '';
    const lines = [
        '✅ **Automatic updates enabled**',
        '',
        `📦 **Repository**  ${repoLink(s.repo)}`,
        `🌿 **Branch**  \`${s.branch}\``,
        `🟢 **Running**  ${commitLink(s.repo, s.running)}`,
        `🕒 **Last check**  ${lastCheckLabel(check.result)}${checkedAt}`,
        `⏱️ **Auto-check**  Every ${interval}`,
    ];
    if (s.fallback && s.fallback !== s.running)
        lines.push(`🛟 **Rollback version**  ${commitLink(s.repo, s.fallback)}`);
    if (s.rejected.length) {
        const shown = s.rejected.slice(0, 3).map(sha => commitLink(s.repo, sha)).join(', ');
        const more = s.rejected.length > 3 ? `, and ${s.rejected.length - 3} more` : '';
        lines.push(`⏭️ **Skipped versions**  ${shown}${more}`);
    }
    if (op === 'now' && s.result) lines.unshift(nowResult(s, interval), '');
    return lines.join('\n');
}
/** Ask launch.js to restart the bot. Resolves true when it accepted (the bot stops a few seconds later). */
export function askRestart(by: string, timeoutMs = 5000, proc: NodeJS.Process = process): Promise<boolean | null> {
    if (typeof proc.send !== 'function' || !proc.connected) return Promise.resolve(null);
    const id = randomUUID();
    return new Promise(resolve => {
        const done = (value: boolean | null) => { clearTimeout(timer); proc.off('message', listen); resolve(value); };
        const listen = (message: any) => { if (message?.type === 'vg-restart-result' && message.id === id) done(!!message.ok); };
        const timer = setTimeout(() => done(null), timeoutMs);
        proc.on('message', listen);
        proc.send!({ type: 'vg-restart', id, by });
    });
}

/** Set by index.ts: shut down cleanly with a non-zero code so any launch.js (even an old one) starts the bot again. */
export const selfRestart: { run: ((code: number) => void) | null } = { run: null };

/** Exit code the launcher treats as "stopped, start again" (anything but 0, which stops the server). */
export const RESTART_EXIT_CODE = 75;

/**
 * Fallback for a launch.js that does not understand the Discord restart request. It restarts the bot
 * when it stops with a non-zero code, but only after 2.5 minutes of uptime, so the
 * launcher never mistakes it for a freshly installed version crashing (which would roll the update back).
 */
export function fallbackRestart(proc: NodeJS.Process = process, uptimeSeconds = proc.uptime()): 'scheduled' | 'too-soon' | 'no-launcher' {
    if (typeof proc.send !== 'function' || !proc.connected || !selfRestart.run) return 'no-launcher';
    if (uptimeSeconds < 150) return 'too-soon';
    const run = selfRestart.run;
    setTimeout(() => run(RESTART_EXIT_CODE), 1500).unref?.();
    return 'scheduled';
}
