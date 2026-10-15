import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';

for (const mode of ['install', 'current', 'error'] as const)
test(`launcher update guard: ${mode}`, { timeout: 15000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vg-update-race-'));
    const remote = join(dir, 'remote'), host = join(dir, 'host');
    const git = (cwd: string, ...args: string[]) => {
        const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
        assert.equal(r.status, 0, r.stderr);
        return r.stdout.trim();
    };
    const server = createServer();
    let launcher: ReturnType<typeof spawn> | undefined;
    let output = '';
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
        writeFileSync(join(remote, 'dist/index.js'), `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
appendFileSync('starts', 'started\\n');
process.on('message', m => {
    appendFileSync('replies', JSON.stringify(m) + '\\n');
    if (m.id === 'one' && m.result?.state === 'installing')
        process.send({ type: 'vg-restart', id: 'restart', by: 'test' });
    if (m.id === 'one' && ${JSON.stringify(mode)} !== 'install')
        process.send({ type: 'vg-update', op: 'now', id: 'three' });
});
if (!existsSync('requested')) {
    writeFileSync('requested', 'yes');
    process.send({ type: 'vg-update', op: 'now', id: 'one' });
    process.send({ type: 'vg-update', op: 'now', id: 'two' });
}
process.on('SIGTERM', () => process.exit(0));
process.on('disconnect', () => process.exit(0));
setInterval(() => {}, 1000);`);
        git(remote, 'init', '-q', '-b', 'main');
        git(remote, 'add', '.');
        git(remote, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'initial');
        const initial = git(remote, 'rev-parse', 'HEAD');
        writeFileSync(join(remote, 'updated'), 'new version');
        git(remote, 'add', '.');
        git(remote, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'update');
        const latest = git(remote, 'rev-parse', 'HEAD');
        git(dir, 'clone', '-q', remote, host);
        git(host, 'reset', '-q', '--hard', initial);
        mkdirSync(join(host, 'node_modules/discord.js'), { recursive: true });

        let branchReads = 0;
        server.on('request', (req, res) => {
            const branch = req.url?.includes('/branches/');
            if (branch) branchReads++;
            const fail = mode === 'error' && branch && branchReads === 1;
            // Keep both IPC requests inside the first network wait.
            setTimeout(() => {
                res.setHeader('content-type', 'application/json');
                if (fail) res.statusCode = 503;
                res.end(JSON.stringify(branch ? { commit: { sha: mode === 'install' ? latest : initial } }
                    : { workflow_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] }));
            }, 100);
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address() as { port: number };
        launcher = spawn(process.execPath, ['launch.js'], { cwd: host, stdio: ['ignore', 'pipe', 'pipe'], env: {
            ...process.env, UPDATE_REPO: 'fixture/project', UPDATE_TOKEN: 'test-updater-token-000000000000', UPDATE_BRANCH: 'main',
            UPDATE_API_BASE: `http://127.0.0.1:${address.port}`, UPDATE_REMOTE_URL: remote, UPDATE_INTERVAL_MINUTES: '60',
            DATABASE_PATH: join(host, 'data/vanguard.db'), DATABASE_BACKUP_DIRECTORY: join(host, 'data/database-backups'),
        } });
        launcher.stdout!.on('data', data => { output += data; });
        launcher.stderr!.on('data', data => { output += data; });
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
            if (mode === 'install') {
                if (existsSync(join(host, 'starts')) && readFileSync(join(host, 'starts'), 'utf8').trim().split('\n').length >= 2) break;
            } else if (existsSync(join(host, 'replies')) && readFileSync(join(host, 'replies'), 'utf8').trim().split('\n').length >= 3) break;
            assert.equal(launcher.exitCode, null, output);
            await pause(25);
        }
        await pause(250);
        assert.equal(branchReads, mode === 'install' ? 1 : 2, output);
        const replies = readFileSync(join(host, 'replies'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.equal(replies.filter(r => r.result?.state === 'busy').length, 1, output);
        if (mode === 'install') {
            assert.equal(replies.filter(r => r.result?.state === 'installing').length, 1, output);
            assert.equal(replies.find(r => r.type === 'vg-restart-result')?.ok, false, output);
        } else {
            assert.equal(replies.filter(r => r.result?.state === 'current').length, mode === 'error' ? 1 : 2, output);
            assert.equal(replies.filter(r => r.result?.state === 'error').length, mode === 'error' ? 1 : 0, output);
        }
        assert.equal(readFileSync(join(host, 'starts'), 'utf8').trim().split('\n').length, mode === 'install' ? 2 : 1, output);
        assert.equal(git(host, 'rev-parse', 'HEAD'), mode === 'install' ? latest : initial);
    } finally {
        if (launcher && launcher.exitCode === null) {
            launcher.kill('SIGTERM');
            await once(launcher, 'exit');
        }
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
    }
});
