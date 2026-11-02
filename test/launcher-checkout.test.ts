import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

test('first checkout retries public Git after GitHub rejects the token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vanguard-launch-'));
    const calls: boolean[] = [];
    const server = createServer((req, res) => {
        const authenticated = Boolean(req.headers.authorization);
        calls.push(authenticated);
        res.writeHead(authenticated ? 401 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ commit: { sha: '1234567' } }));
    });
    let child: ReturnType<typeof spawn> | undefined;
    try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const port = (server.address() as { port: number }).port;
        mkdirSync(join(dir, 'bin'));
        mkdirSync(join(dir, 'dist'));
        mkdirSync(join(dir, 'node_modules', 'discord.js'), { recursive: true });
        copyFileSync(new URL('../launch.js', import.meta.url), join(dir, 'launch.js'));
        writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
        writeFileSync(join(dir, 'dist', 'index.js'), 'setInterval(() => {}, 1000);');
        writeFileSync(join(dir, 'bin', 'git'), `#!/bin/sh
case "$1" in
  --version) exit 0 ;;
  init) mkdir -p .git; exit 0 ;;
  -c) shift 2; if [ "$1" = fetch ]; then printf 'authenticated\\n' >> git-calls; exit 1; fi; if [ "$1" = init ]; then mkdir -p .git; fi; exit 0 ;;
  fetch) printf 'public\\n' >> git-calls; exit 0 ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
        child = spawn(process.execPath, ['launch.js'], { cwd: dir, env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, UPDATE_REPO: 'owner/repo', UPDATE_TOKEN: 'invalid-test-token-long-enough', UPDATE_API_BASE: `http://127.0.0.1:${port}`, UPDATE_INTERVAL_MINUTES: '60' }, stdio: ['ignore', 'pipe', 'pipe'] });
        const output = await new Promise<string>((resolve, reject) => {
            let text = '';
            const timer = setTimeout(() => reject(new Error(`launcher timed out: ${text}`)), 10000);
            child!.stdout!.on('data', chunk => {
                text += chunk.toString();
                if (text.includes('Automatic updates are on:')) { clearTimeout(timer); resolve(text); }
            });
            child!.once('exit', code => { clearTimeout(timer); reject(new Error(`launcher exited ${code}: ${text}`)); });
        });
        assert.match(output, /GitHub rejected UPDATE_TOKEN/);
        assert.deepEqual(calls, [true, false]);
        assert.equal(readFileSync(join(dir, 'git-calls'), 'utf8'), 'authenticated\npublic\n');
    } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            await once(child, 'exit');
        }
        server.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('a stalled GitHub probe cannot block bot startup after a failed checkout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vanguard-launch-timeout-'));
    const server = createServer(() => { /* Simulate a server that never answers. */ });
    let child: ReturnType<typeof spawn> | undefined;
    try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const port = (server.address() as { port: number }).port;
        mkdirSync(join(dir, 'bin'));
        mkdirSync(join(dir, 'dist'));
        mkdirSync(join(dir, 'node_modules', 'discord.js'), { recursive: true });
        copyFileSync(new URL('../launch.js', import.meta.url), join(dir, 'launch.js'));
        writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
        writeFileSync(join(dir, 'dist', 'index.js'), 'console.log("bot started"); setInterval(() => {}, 1000);');
        writeFileSync(join(dir, 'bin', 'git'), `#!/bin/sh
if [ "$1" = -c ]; then shift 2; fi
case "$1" in init) mkdir -p .git ;; fetch) exit 1 ;; esac
exit 0
`, { mode: 0o755 });
        child = spawn(process.execPath, ['launch.js'], { cwd: dir, env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, UPDATE_REPO: 'owner/repo', UPDATE_TOKEN: 'invalid-test-token-long-enough', UPDATE_API_BASE: `http://127.0.0.1:${port}`, UPDATE_INTERVAL_MINUTES: '60' }, stdio: ['ignore', 'pipe', 'pipe'] });
        const output = await new Promise<string>((resolve, reject) => {
            let text = '';
            const timer = setTimeout(() => reject(new Error(`bot did not start: ${text}`)), 10000);
            child!.stdout!.on('data', chunk => {
                text += chunk.toString();
                if (text.includes('bot started')) { clearTimeout(timer); resolve(text); }
            });
            child!.once('exit', code => { clearTimeout(timer); reject(new Error(`launcher exited ${code}: ${text}`)); });
        });
        assert.match(output, /Could not reach the repo/);
    } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            await once(child, 'exit');
        }
        server.closeAllConnections();
        server.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('the launcher says when it starts installing dependencies and which version it is starting, so the console is never blank', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vanguard-launch-'));
    let child: ReturnType<typeof spawn> | undefined;
    try {
        mkdirSync(join(dir, 'bin'));
        mkdirSync(join(dir, 'dist'));
        copyFileSync(new URL('../launch.js', import.meta.url), join(dir, 'launch.js'));
        writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
        writeFileSync(join(dir, 'dist', 'index.js'), 'setInterval(() => {}, 1000);');
        // There is no node_modules, so the launcher installs dependencies. The fake npm answers at once.
        writeFileSync(join(dir, 'bin', 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        writeFileSync(join(dir, 'bin', 'git'), '#!/bin/sh\ncase "$1" in\n  rev-parse) echo 0123456789abcdef0123456789abcdef01234567 ;;\nesac\nexit 0\n', { mode: 0o755 });
        child = spawn(process.execPath, ['launch.js'], { cwd: dir, env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, UPDATE_REPO: '', UPDATE_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
        const output = await new Promise<string>((resolve, reject) => {
            let text = '';
            const timer = setTimeout(() => reject(new Error(`launcher timed out: ${text}`)), 10000);
            child!.stdout!.on('data', chunk => {
                text += chunk.toString();
                if (text.includes('Starting the bot')) { clearTimeout(timer); resolve(text); }
            });
            child!.once('exit', code => { clearTimeout(timer); reject(new Error(`launcher exited ${code}: ${text}`)); });
        });
        const at = ['Installing dependencies. This can take a few minutes', 'Dependencies installed', 'Starting the bot · 0123456'].map(part => output.indexOf(part));
        assert.ok(at.every(position => position !== -1), `all three lines are printed:\n${output}`);
        assert.deepEqual([...at].sort((a, b) => a - b), at, 'the install is announced before it runs, and the bot is announced after it');
    } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            await once(child, 'exit');
        }
        rmSync(dir, { recursive: true, force: true });
    }
});
