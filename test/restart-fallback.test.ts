import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askRestart, fallbackRestart, selfRestart, RESTART_EXIT_CODE } from '../src/bot/updater-link.js';

const fake = (connected: boolean) => ({ send: () => true, connected, on: () => {}, off: () => {} }) as any;

test('fallback restart needs a launcher, and waits until the bot has run long enough not to look like a crash', () => {
    const before = selfRestart.run;
    try {
        let code: number | null = null;
        selfRestart.run = c => { code = c; };
        assert.equal(fallbackRestart(fake(false), 600), 'no-launcher');
        assert.equal(fallbackRestart(fake(true), 30), 'too-soon');
        assert.equal(fallbackRestart(fake(true), 600), 'scheduled');
        assert.equal(code, null, 'it waits so the reply reaches Discord first');
    } finally { selfRestart.run = before; }
});

test('an old launcher that ignores the restart request still gets a non-zero exit and starts the bot again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vg-restart-'));
    try {
        const link = new URL('../src/bot/updater-link.ts', import.meta.url).href;
        const child = join(dir, 'child.mts');
        writeFileSync(child, `import { askRestart, fallbackRestart, selfRestart } from ${JSON.stringify(link)};
selfRestart.run = code => process.exit(code);
const ok = await askRestart('dev', 300);
process.send!({ asked: ok, fallback: fallbackRestart(process, 600) });
setInterval(() => {}, 1000);`);
        // The old launcher: answers nothing, restarts on any non-zero exit.
        const result = await new Promise<{ asked: unknown; fallback: string; code: number | null }>((resolve, reject) => {
            const p = fork(child, [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
            let msg: any = null; let err = '';
            p.stderr!.on('data', d => { err += d; });
            p.on('message', m => { msg = m; });
            p.on('exit', code => msg ? resolve({ ...msg, code }) : reject(new Error(`child exited without reporting: ${err}`)));
            setTimeout(() => { p.kill(); reject(new Error('timed out')); }, 15000).unref();
        });
        assert.equal(result.asked, null, 'the old launcher did not answer');
        assert.equal(result.fallback, 'scheduled');
        assert.equal(result.code, RESTART_EXIT_CODE);
        assert.notEqual(RESTART_EXIT_CODE, 0, 'exit code 0 would make the launcher stop the whole server');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

void askRestart;
