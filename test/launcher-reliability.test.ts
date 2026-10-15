import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

for (const mode of ['timeout-headers', 'timeout-body', 'install-failed', 'installed'] as const)
test(`launcher reports and recovers from ${mode}`, { timeout: 20000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vg-launcher-reliability-'));
    const remote = join(dir, 'remote'), host = join(dir, 'host');
    const git = (cwd: string, ...args: string[]) => {
        const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    };
    const server = createServer();
    let launcher: ReturnType<typeof spawn> | undefined, output = '';
    try {
        mkdirSync(join(remote, 'dist'), { recursive: true });
        copyFileSync(new URL('../launch.js', import.meta.url), join(remote, 'launch.js'));
        const recovery = new URL('../scripts/recover-database.mjs', import.meta.url);
        if (existsSync(recovery)) {
            mkdirSync(join(remote, 'scripts'));
            copyFileSync(recovery, join(remote, 'scripts/recover-database.mjs'));
        }
        writeFileSync(join(remote, 'package.json'), '{"type":"module"}');
        writeFileSync(join(remote, 'package-lock.json'), '{}');
        writeFileSync(join(remote, '.gitignore'), 'node_modules/\nstarts\nrequested\nreplies\n');
        writeFileSync(join(remote, 'dist/index.js'), `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
appendFileSync('starts', 'started\\n');
process.on('message', m => {
    appendFileSync('replies', JSON.stringify(m) + '\\n');
    if (m.id === 'one' && m.result?.state === 'error')
        process.send({ type:'vg-update', op:'now', id:'retry' });
    if (m.id === 'retry' && m.result?.state === 'current')
        process.send({ type:'vg-update', op:'status', id:'status' });
});
if (!existsSync('requested')) {
    writeFileSync('requested', 'yes');
    process.send({ type:'vg-update', op:'now', id:'one' });
} else process.send({ type:'vg-update', op:'status', id:'status' });
process.on('SIGTERM', () => process.exit(0));
process.on('disconnect', () => process.exit(0));
setInterval(() => {}, 1000);
`);
        git(remote, 'init', '-q', '-b', 'main'); git(remote, 'add', '.');
        git(remote, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'initial');
        const initial = git(remote, 'rev-parse', 'HEAD');
        writeFileSync(join(remote, 'updated'), 'new version'); git(remote, 'add', '.');
        git(remote, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'update');
        const latest = git(remote, 'rev-parse', 'HEAD');
        git(dir, 'clone', '-q', remote, host); git(host, 'reset', '-q', '--hard', initial);
        if (mode === 'install-failed') git(host, 'remote', 'set-url', 'origin', join(dir, 'unavailable-remote'));
        mkdirSync(join(host, 'node_modules/discord.js'), { recursive: true });
        let branchReads = 0;
        server.on('request', (req, res) => {
            const branch = req.url?.includes('/branches/');
            if (branch) branchReads++;
            if (branch && branchReads === 1 && mode.startsWith('timeout')) {
                if (mode === 'timeout-body') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); }
                return;
            }
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(branch ? { commit: { sha: mode.startsWith('timeout') ? initial : latest } }
                : { workflow_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] }));
        });
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        launcher = spawn(process.execPath, ['launch.js'], { cwd: host, stdio: ['ignore', 'pipe', 'pipe'], env: {
            ...process.env, UPDATE_REPO: 'fixture/project', UPDATE_TOKEN: 'test-updater-token-000000000000', UPDATE_BRANCH: 'main',
            UPDATE_API_BASE: `http://127.0.0.1:${(server.address() as { port: number }).port}`, UPDATE_REMOTE_URL: remote, UPDATE_INTERVAL_MINUTES: '60',
            DATABASE_PATH: join(host, 'data/vanguard.db'), DATABASE_BACKUP_DIRECTORY: join(host, 'data/database-backups'),
        } });
        launcher.stdout!.on('data', data => { output += data; }); launcher.stderr!.on('data', data => { output += data; });
        const readReplies = (): any[] => existsSync(join(host, 'replies')) ? readFileSync(join(host, 'replies'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline && !readReplies().some(r => r.id === 'status')) {
            assert.equal(launcher.exitCode, null, output);
            await pause(25);
        }
        const replies = readReplies(), status = replies.find(r => r.id === 'status');
        assert.ok(status, output);
        if (mode.startsWith('timeout')) {
            assert.equal(replies.find(r => r.id === 'one')?.result?.state, 'error', output);
            assert.equal(replies.find(r => r.id === 'retry')?.result?.state, 'current', output);
            assert.equal(branchReads, 2, 'a timed-out request does not prevent a fresh check');
            assert.equal(status.lastCheck.result, 'current');
        } else {
            assert.equal(status.lastCheck.result, mode === 'installed' ? 'installed' : 'install failed', output);
            assert.equal(status.running, mode === 'installed' ? latest : initial);
            assert.deepEqual(status.rejected, mode === 'installed' ? [] : [latest]);
        }
        assert.equal(git(host, 'rev-parse', 'HEAD'), mode === 'installed' ? latest : initial);
        assert.equal(readFileSync(join(host, 'starts'), 'utf8').trim().split('\n').length, mode.startsWith('timeout') ? 1 : 2);
    } finally {
        if (launcher && launcher.exitCode === null) { launcher.kill('SIGTERM'); await once(launcher, 'exit'); }
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
    }
});
