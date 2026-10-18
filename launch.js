/**
 * Ghost Vanguard launcher for hosts that only let you pick a "main file" (Wispbyte).
 * Startup:  cd /home/container && node launch.js
 *
 * 1. Installs dependencies if node_modules is missing.
 * 2. One-time import: if data/import/vanguard.db exists, copies the servers listed in
 *    IMPORT_GUILDS (default: Midtown Tower Cafe + MT | Human Resources) from it into
 *    data/vanguard.db, keeping every other server. Runs once (data/import is renamed after).
 * 3. Runs the bot, and restarts it if it stops unexpectedly (at most 5 times in 10 minutes).
 * 4. Automatic updates from GitHub, when UPDATE_REPO and UPDATE_TOKEN are set in .env:
 *    every 5 minutes it checks the main branch. A new commit is installed only when GitHub's
 *    tests passed for it. The bot is then restarted on the new version; if that version
 *    crashes within 2 minutes, the previous version is put back automatically.
 *    .env and data/ are never touched by an update.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, copyFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
process.chdir(root);
/** Launcher messages: one short line each, marked with a symbol so they stand out from the bot's own log. */
const say = (text, mark = '›') => console.log(`${mark} ${text}`);
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32', ...opts }).status === 0;
const quiet = (cmd, args) => spawnSync(cmd, args, { cwd: root, encoding: 'utf8' });

// ------------------------------------------------------------ settings from .env (without loading the bot)
function envFile() {
    const out = {};
    try {
        for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
            const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
            if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
    } catch { }
    return out;
}
const env = { ...envFile(), ...process.env };
// Accepts owner/repo or the full link (https://github.com/owner/repo, with or without .git).
const REPO = (env.UPDATE_REPO ?? '').trim().replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
const TOKEN = (env.UPDATE_TOKEN ?? '').trim();
const BRANCH = (env.UPDATE_BRANCH ?? 'main').trim();
const WORKFLOW = 'CI';
const CHECK_MS = Math.max(env.UPDATE_API_BASE ? 1000 : 60000, Number(env.UPDATE_INTERVAL_MINUTES ?? 5) * 60000);
// Overridable only for testing the updater against a local copy.
const API = (env.UPDATE_API_BASE || 'https://api.github.com').replace(/\/$/, '');
const REMOTE = env.UPDATE_REMOTE_URL || `https://github.com/${REPO}.git`;
const HEALTHY_MS = Number(env.UPDATE_HEALTHY_SECONDS ?? 120) * 1000;
const updatesOn = /^[\w.-]+\/[\w.-]+$/.test(REPO) && TOKEN.length > 20;
/** Why automatic updates are off, in plain words (null when they are on). */
const updatesOffReason = () => !REPO && !TOKEN ? 'UPDATE_REPO and UPDATE_TOKEN are not set in .env'
    : !/^[\w.-]+\/[\w.-]+$/.test(REPO) ? `UPDATE_REPO should look like owner/repo (it is "${REPO || 'empty'}")`
    : !TOKEN ? 'UPDATE_TOKEN is empty in .env'
    : TOKEN.length <= 20 ? 'UPDATE_TOKEN looks too short; paste the whole github_pat_… token'
    : !existsSync(join(root, '.git')) ? 'this folder is not a git checkout yet (restart once so the launcher can set it up)'
    : null;
if ((env.UPDATE_REPO || env.UPDATE_TOKEN) && updatesOffReason()) say(`Automatic updates are off: ${updatesOffReason()}`, '⚠');
const hide = text => TOKEN ? String(text).split(TOKEN).join('[token hidden]') : String(text);

// ------------------------------------------------------------ git, with the token passed per command (never saved to disk)
const auth = () => ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`];
const git = (...args) => { const r = quiet('git', [...auth(), ...args]); return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: hide(r.stderr ?? '').trim() }; };
const head = () => quiet('git', ['rev-parse', 'HEAD']).stdout?.trim() || null;

async function github(path) {
    const res = await fetch(`${API}/repos/${REPO}${path}`, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'midtown-vanguard-updater' } });
    if (!res.ok) throw new Error(`GitHub ${res.status} on ${path}`);
    return res.json();
}

/** Newest commit on the branch whose CI run succeeded, or null. */
async function latestPassing() {
    const branch = await github(`/branches/${encodeURIComponent(BRANCH)}`);
    const sha = branch?.commit?.sha;
    if (!sha) return null;
    const runs = await github(`/actions/runs?head_sha=${sha}&per_page=20`);
    const ci = (runs.workflow_runs ?? []).filter(r => r.name === WORKFLOW);
    if (!ci.length || ci.some(r => r.status !== 'completed')) return { sha, ready: false, why: 'tests still running' };
    return ci.every(r => r.conclusion === 'success') ? { sha, ready: true } : { sha, ready: false, why: 'tests failed' };
}

/** First time: turn this folder into a checkout of the repo, keeping .env, data/ and node_modules. */
function ensureCheckout() {
    if (existsSync(join(root, '.git'))) return true;
    say(`Connecting this folder to github.com/${REPO} (first time)...`);
    if (!git('init', '-q').ok) return false;
    quiet('git', ['remote', 'add', 'origin', REMOTE]);
    const fetched = git('fetch', '-q', 'origin', BRANCH);
    if (!fetched.ok) { say(`Could not reach the repo: ${fetched.err}`); rmSync(join(root, '.git'), { recursive: true, force: true }); return false; }
    git('reset', '-q', '--hard', 'FETCH_HEAD');
    return true;
}

/** Install a commit. Only tracked files change; .env, data/ and node_modules are untouched. */
function install(sha) {
    const before = head();
    if (!git('fetch', '-q', 'origin', BRANCH).ok) return false;
    if (!git('reset', '-q', '--hard', sha).ok) return false;
    if (!depsCurrent()) {
        if (!installDeps()) { say('npm install failed; going back.'); git('reset', '-q', '--hard', before); installDeps(); return false; }
    }
    return true;
}

// ------------------------------------------------------------ one-time setup
if (updatesOn) {
    if (quiet('git', ['--version']).status !== 0) say('Automatic updates need git, which this host does not have. Updates are off.');
    else if (ensureCheckout()) say(`Automatic updates are on: github.com/${REPO} (${BRANCH}), checked every ${CHECK_MS / 60000} minutes.`);
}

// Dependencies: installed when missing, and again whenever package-lock.json changed (for
// example after the host pulled a new version from GitHub), so new code never starts without them.
// The bot's own version number is in package-lock.json too; bumping it alone must not reinstall everything.
const lockHash = () => {
    try {
        const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
        delete lock.version; if (lock.packages?.['']) delete lock.packages[''].version;
        return createHash('sha1').update(JSON.stringify(lock)).digest('hex');
    } catch { return 'none'; }
};
const marker = join(root, 'node_modules', '.vanguard-lock');
function depsCurrent() {
    try { return existsSync(join(root, 'node_modules', 'discord.js')) && readFileSync(marker, 'utf8') === lockHash(); } catch { return false; }
}
function installDeps() {
    const fresh = !existsSync(join(root, 'node_modules', 'discord.js'));
    const started = Date.now();
    // npm's spinner and progress bars turn into garbage in a host panel, so run it quietly and print one summary line.
    const npm = args => spawnSync('npm', [...args, '--omit=dev', '--no-audit', '--no-fund', '--no-progress', '--loglevel=error'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
    let result = npm(['ci']);
    if (result.status !== 0) result = npm(['install']);
    const ok = result.status === 0;
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const counts = ['added', 'changed', 'removed'].map(word => { const m = new RegExp(`${word} (\\d+) package`).exec(output); return m ? `${m[1]} ${word}` : null; }).filter(Boolean);
    if (ok) {
        say(`${fresh ? 'Dependencies installed' : 'Dependencies updated'} · ${counts.join(', ') || 'up to date'} · ${Math.round((Date.now() - started) / 1000)}s`, '  📦');
        try { writeFileSync(marker, lockHash()); } catch { }
    } else {
        say('Installing dependencies failed. npm said:', '✖');
        for (const line of output.trim().split('\n').slice(-12)) console.log(`    ${line}`);
    }
    return ok;
}
if (!depsCurrent()) {
    // Older installs have no marker yet: if discord.js is there, trust it and just record the lock.
    if (existsSync(join(root, 'node_modules', 'discord.js')) && !existsSync(marker)) { try { writeFileSync(marker, lockHash()); } catch { } }
    else if (!installDeps()) { say('npm install failed.'); process.exit(1); }
}

const data = join(root, 'data'), importDb = join(data, 'import', 'vanguard.db'), main = join(data, 'vanguard.db');
// Safety net: the database file is gone but its automatic backups are still here (a deleted
// file, a bad pull). Put the newest verified backup back instead of starting empty.
const backupsDir = join(data, 'database-backups');
if (!existsSync(main) && existsSync(backupsDir)) {
    const newest = readdirSync(backupsDir).filter(f => /^\d+-[\w-]+\.db$/.test(f) && existsSync(join(backupsDir, f + '.json')))
        .map(f => ({ f, at: statSync(join(backupsDir, f)).mtimeMs })).sort((a, b) => b.at - a.at)[0];
    if (newest) {
        copyFileSync(join(backupsDir, newest.f), main);
        say(`data/vanguard.db was missing. Restored the newest backup (${newest.f}, ${new Date(newest.at).toISOString()}) so no settings are lost.`);
    }
}
if (existsSync(importDb)) {
    if (!existsSync(main)) {
        say('data/import/vanguard.db is here, but data/vanguard.db (the old Wispbyte database) is not.');
        say('Upload the old server\'s data folder first, then start again. Nothing was changed.');
        process.exit(1);
    }
    const guilds = (env.IMPORT_GUILDS ?? env.IMPORT_GUILD ?? '845678484276641842,1328761679714058331').split(',').map(s => s.trim()).filter(Boolean);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const work = join(data, `merge-work-${stamp}`);
    mkdirSync(work, { recursive: true });
    let current = data, ok = true;
    for (const [i, guild] of guilds.entries()) {
        const step = join(work, String(i));
        mkdirSync(step, { recursive: true });
        say(`Importing server ${guild} ...`);
        if (!run(process.execPath, ['scripts/merge-guild.mjs', '--bot', '.', '--from', join(data, 'import'), '--into', current, '--guild', guild, '--out', join(step, 'vanguard.db')])) { ok = false; break; }
        current = step;
    }
    if (ok) {
        for (const s of ['', '-wal', '-shm']) if (existsSync(main + s)) renameSync(main + s, join(data, `vanguard-before-merge-${stamp}.db${s}`));
        copyFileSync(join(current, 'vanguard.db'), main);
        renameSync(join(data, 'import'), join(data, `import-done-${stamp}`));
        say(`Import complete (${guilds.length} server(s)). Previous database kept as data/vanguard-before-merge-${stamp}.db`);
    } else say('IMPORT FAILED (see above). Nothing was changed; starting with the existing database.');
    rmSync(work, { recursive: true, force: true });
}

// ------------------------------------------------------------ run the bot, restart it, update it
let child = null, stopping = false, updating = false;
const launcherHash = () => { try { return createHash('sha256').update(readFileSync(join(root, 'launch.js'))).digest('hex'); } catch { return ''; } };
const LAUNCHER_HASH = launcherHash();
const crashes = [];
let lastGood = head(), startedAt = 0;

function startBot() {
    startedAt = Date.now();
    child = spawn(process.execPath, ['dist/index.js'], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], cwd: root, env: process.env });
    child.on('message', message => { void answerBot(child, message); });
    child.on('exit', (code, signal) => {
        child = null;
        if (stopping || updating) return;
        const now = Date.now();
        // A brand-new version that dies within 2 minutes is rolled back.
        if (updatesOn && lastGood && head() !== lastGood && now - startedAt < HEALTHY_MS) {
            const bad = head();
            say(`The new version ${bad?.slice(0, 7)} stopped within 2 minutes (code ${code ?? signal}). Going back to ${lastGood.slice(0, 7)} and skipping it.`, '✖');
            if (bad) rejected.add(bad);
            install(lastGood);
            return startBot();
        }
        crashes.push(now);
        while (crashes.length && now - crashes[0] > 600000) crashes.shift();
        if (code === 0 || crashes.length > 5) {
            say(code === 0 ? 'The bot stopped.' : 'The bot keeps stopping; giving up so the panel shows the error.', code === 0 ? '›' : '✖');
            process.exit(code ?? 1);
        }
        say(`The bot stopped unexpectedly (code ${code ?? signal}); restarting in 5 seconds...`, '⚠');
        setTimeout(startBot, 5000);
    });
}

function stopBot() {
    return new Promise(resolve => {
        if (!child) return resolve();
        const c = child;
        const force = setTimeout(() => c.kill('SIGKILL'), 20000);
        c.once('exit', () => { clearTimeout(force); resolve(); });
        c.kill('SIGTERM');
    });
}

const rejected = new Set();
let lastNote = '';
let lastCheck = { at: 0, result: 'not checked yet' };
/** Returns what it found; `beforeInstall` runs (and is awaited) just before the bot is restarted. */
async function checkForUpdate(beforeInstall) {
    if (updating || stopping) return { state: 'busy' };
    try {
        const latest = await latestPassing();
        const result = !latest ? { state: 'none' }
            : latest.sha === head() ? { state: 'current', sha: latest.sha }
            : rejected.has(latest.sha) ? { state: 'skipped', sha: latest.sha, why: 'it crashed or failed to install before' }
            : !latest.ready ? { state: 'waiting', sha: latest.sha, why: latest.why }
            : { state: 'installing', sha: latest.sha };
        lastCheck = { at: Date.now(), result: result.state === 'waiting' ? `waiting for ${result.sha.slice(0, 7)}: ${result.why}` : result.state };
        if (result.state === 'waiting') {
            // Say it once per commit and reason, not every check.
            const note = `${latest.sha}:${latest.why}`;
            if (note !== lastNote) say(`Update ${latest.sha.slice(0, 7)} found, not installing yet: ${latest.why}.`, '⏳');
            lastNote = note;
        }
        if (result.state !== 'installing') return result;
        if (beforeInstall) await beforeInstall(result);
        updating = true;
        const subject = quiet('git', ['log', '-1', '--format=%s', latest.sha]).stdout?.trim();
        console.log('');
        say(`Update found: ${latest.sha.slice(0, 7)}${subject ? ` · ${subject.length > 70 ? `${subject.slice(0, 67)}...` : subject}` : ''}`, '↻');
        const previous = head();
        await stopBot();
        if (install(latest.sha)) {
            lastGood = previous; say(`Installed ${latest.sha.slice(0, 7)} · starting the new version`, '✔');
            // The bot code is new now, but this launcher keeps running the code it started with.
            if (launcherHash() !== LAUNCHER_HASH) say('launch.js itself changed in this update. Press Restart in the Wispbyte panel when convenient to load it (the bot keeps working until then).', '⚠');
        }
        else { rejected.add(latest.sha); say('The update could not be installed; staying on the current version.', '✖'); }
        updating = false;
        startBot();
        // Once the new version has run for 2 minutes, it becomes the version to fall back to.
        setTimeout(() => { if (child && Date.now() - startedAt >= HEALTHY_MS - 1000) lastGood = head(); }, HEALTHY_MS + 1000).unref();
        return { state: 'installed', sha: latest.sha };
    } catch (error) {
        updating = false;
        const why = hide(error instanceof Error ? error.message : error);
        lastCheck = { at: Date.now(), result: `check failed: ${why}` };
        say(`Update check failed: ${why} (trying again in ${CHECK_MS / 60000} minutes)`, '⚠');
        if (!child && !stopping) startBot();
        return { state: 'error', why };
    }
}

/** /dev update asks the launcher (over the bot's IPC channel) for status, or to check now. */
async function answerBot(c, message) {
    // Discord restart request: stop the bot cleanly and start it again (the launcher stays up).
    if (message?.type === 'vg-restart' && c?.connected) {
        try { c.send({ type: 'vg-restart-result', id: message.id, ok: !updating && !stopping }); } catch { }
        if (updating || stopping) return;
        console.log('');
        say(`Restart requested from Discord by ${String(message.by ?? 'a developer').replace(/[^\d]/g, '') || 'a developer'}`, '↻');
        updating = true;
        await new Promise(r => setTimeout(r, 2000));
        await stopBot();
        updating = false;
        startBot();
        return;
    }
    if (!message || message.type !== 'vg-update' || !c?.connected) return;
    const reply = data => { try { if (c.connected) c.send({ type: 'vg-update-result', id: message.id, ...data }); } catch { } };
    const status = { enabled: updatesOn && existsSync(join(root, '.git')), why: updatesOffReason(), repo: REPO || null, branch: BRANCH, running: head(), fallback: lastGood, intervalMinutes: CHECK_MS / 60000, lastCheck, rejected: [...rejected] };
    if (message.op !== 'now' || !status.enabled) return reply(status);
    const result = await checkForUpdate(async found => { reply({ ...status, result: found }); await new Promise(r => setTimeout(r, 2500)); });
    if (result.state !== 'installing' && result.state !== 'installed') reply({ ...status, result });
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    stopping = true;
    await stopBot();
    process.exit(0);
});

startBot();
if (updatesOn && existsSync(join(root, '.git'))) setInterval(() => { void checkForUpdate(); }, CHECK_MS).unref?.();
// Keep the launcher alive while the bot runs.
setInterval(() => { }, 1 << 30);
