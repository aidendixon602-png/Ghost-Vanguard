import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConsoleLog, currentConsoleLog, formatTail, startConsoleLog, stopConsoleLog } from '../src/console-log.js';
import dev from '../src/commands/developer/dev.js';

function fakeStream(result = true) {
    const calls: unknown[][] = [];
    const stream = {
        write(...args: unknown[]) {
            calls.push(args);
            (args.find(a => typeof a === 'function') as (() => void) | undefined)?.();
            return result;
        },
    };
    return { stream, calls, original: stream.write };
}

const texts = (log: ConsoleLog, count = 100) => log.tail(count).map(l => l.text);
const scratch = () => mkdtempSync(join(tmpdir(), 'gv-console-'));

test('the console still gets every write exactly as before, and the log gets a copy', () => {
    const { stream, calls } = fakeStream(false);
    const log = new ConsoleLog();
    log.attach(stream, 'out');
    let called = 0;
    assert.equal(stream.write('hello\n'), false, 'the return value (back-pressure) is the console stream own');
    stream.write(Buffer.from('bytes\n'));
    stream.write('with callback\n', () => { called++; });
    stream.write('latin\n', 'latin1', () => { called++; });
    assert.equal(called, 2, 'callbacks still run');
    assert.deepEqual(calls.map(c => typeof c[0] === 'string' ? c[0] : String(c[0])), ['hello\n', 'bytes\n', 'with callback\n', 'latin\n']);
    assert.deepEqual(texts(log), ['hello', 'bytes', 'with callback', 'latin']);
});

test('colour codes go, split writes join up, and a redrawn progress line keeps its last state', () => {
    const { stream } = fakeStream();
    const log = new ConsoleLog();
    log.attach(stream, 'out');
    stream.write('\u001b[31mred\u001b[0m and \u001b[38;5;196mmore\u001b[0m\n');
    stream.write('par');
    stream.write('tial line\n');
    stream.write('crlf line\r\n');
    stream.write('download 10%\rdownload 50%\rdownload 100%\n');
    stream.write('\u001b[2K\u001b[1Gafter clear\n');
    stream.write('\u001b]0;window title\u0007with a title\n');
    stream.write('\n   \n\u001b[0m\n');
    // A character split between two chunks must not turn into replacement marks.
    const heart = Buffer.from('✔ done\n');
    stream.write(heart.subarray(0, 1));
    stream.write(heart.subarray(1));
    assert.deepEqual(texts(log), ['red and more', 'partial line', 'crlf line', 'download 100%', 'after clear', 'with a title', '✔ done']);
});

test('output and errors share one timeline, and a line is not mixed with the other stream line', () => {
    const out = fakeStream(), err = fakeStream();
    const log = new ConsoleLog();
    log.attach(out.stream, 'out');
    log.attach(err.stream, 'err');
    out.stream.write('one ');
    err.stream.write('error line\n');
    out.stream.write('two\n');
    assert.deepEqual(texts(log), ['error line', 'one two']);
});

test('secrets and token-shaped text never reach the log', () => {
    const { stream } = fakeStream();
    const token = ['M' + 'A'.repeat(23), 'B'.repeat(6), 'C'.repeat(27)].join('.');
    const log = new ConsoleLog({ secrets: () => ['a-very-secret-api-value', undefined, 'short'] });
    log.attach(stream, 'out');
    stream.write('key a-very-secret-api-value used\n');
    stream.write(`login ${token} failed\n`);
    stream.write('password=hunter22 and a short word\n');
    const seen = texts(log).join('\n');
    assert.ok(!seen.includes('a-very-secret-api-value') && !seen.includes(token) && !seen.includes('hunter22'), seen);
    assert.match(seen, /key \[hidden\] used/);
    assert.match(seen, /a short word/, 'values under 8 characters are left alone, so ordinary words survive');
});

test('only the newest lines are kept in memory, and very long lines are cut', () => {
    const { stream } = fakeStream();
    const log = new ConsoleLog({ maxLines: 3 });
    log.attach(stream, 'out');
    for (const n of [1, 2, 3, 4, 5]) stream.write(`line ${n}\n`);
    assert.deepEqual(texts(log), ['line 3', 'line 4', 'line 5']);
    assert.deepEqual(texts(log, 2), ['line 4', 'line 5']);
    assert.deepEqual(log.tail(0), []);
    stream.write(`${'x'.repeat(5000)}\n`);
    const long = log.tail(1)[0]!.text;
    assert.equal(long.length, 2000);
    assert.ok(long.endsWith('…'));
});

test('lines are written to a timestamped file, a new file starts when it grows, and a broken file costs nothing', () => {
    const dir = scratch();
    try {
        let clock = Date.UTC(2026, 10, 2, 2, 14, 33);
        const file = join(dir, 'data', 'console.log');
        const { stream } = fakeStream();
        const log = new ConsoleLog({ file, header: '===== run 1 =====', maxBytes: 120, now: () => clock });
        log.attach(stream, 'out');
        stream.write('first\n');
        clock += 5000;
        stream.write('second\n');
        log.flush();
        assert.equal(readFileSync(file, 'utf8'), '===== run 1 =====\n2026-11-02 02:14:33 first\n2026-11-02 02:14:38 second\n');
        assert.equal(log.filePath, file);

        // Past maxBytes the next write moves the old file aside and starts again.
        for (let n = 0; n < 6; n++) stream.write(`filler line number ${n} to make the file bigger\n`);
        log.flush();
        stream.write('after the move\n');
        log.flush();
        assert.ok(existsSync(join(dir, 'data', 'console.old.log')), 'the full file was kept as console.old.log');
        assert.match(readFileSync(file, 'utf8'), /after the move/);
        assert.match(readFileSync(join(dir, 'data', 'console.old.log'), 'utf8'), /first/);
        log.detach();

        // A folder that cannot be created: the file is given up on, nothing throws, memory still works.
        writeFileSync(join(dir, 'a-file'), 'x');
        const broken = new ConsoleLog({ file: join(dir, 'a-file', 'console.log') });
        broken.attach(stream, 'out');
        stream.write('still captured\n');
        assert.doesNotThrow(() => broken.flush());
        assert.equal(broken.filePath, null);
        assert.deepEqual(texts(broken), ['still captured']);
        broken.detach();
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('detach puts the stream back and writes a last line that never got its newline', () => {
    const dir = scratch();
    try {
        const file = join(dir, 'console.log');
        const { stream, original } = fakeStream();
        const log = new ConsoleLog({ file, now: () => Date.UTC(2026, 10, 2, 0, 0, 0) });
        log.attach(stream, 'out');
        assert.notEqual(stream.write, original);
        stream.write('no newline at the end');
        log.detach();
        assert.equal(stream.write, original, 'the stream is exactly what it was');
        assert.equal(readFileSync(file, 'utf8'), '2026-11-02 00:00:00 no newline at the end\n');
        stream.write('after detach\n');
        assert.deepEqual(texts(log), ['no newline at the end'], 'nothing is copied any more');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('/dev logs lines read as UTC time and text, whatever zone the host is set to', () => {
    const saved = process.env.TZ;
    process.env.TZ = 'Pacific/Auckland';
    try {
        assert.equal(formatTail([{ at: Date.UTC(2026, 10, 2, 2, 14, 33), text: 'Connected as Ghost Vanguard' }, { at: Date.UTC(2026, 10, 2, 13, 5, 9), text: 'next' }]),
            '02:14:33 Connected as Ghost Vanguard\n13:05:09 next');
    } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
});

test('a real process keeps its console output unchanged, and everything it printed is in the file, even after process.exit', () => {
    const dir = scratch();
    try {
        const file = join(dir, 'console.log');
        const script = join(dir, 'probe.mts');
        writeFileSync(script, `import { startConsoleLog } from ${JSON.stringify(pathToFileURL(resolve('src/console-log.ts')).href)};
startConsoleLog(undefined, ${JSON.stringify(file)});
console.log('\\u001b[32mfirst\\u001b[0m');
console.error('an error line');
process.stdout.write('no newline');
process.exit(3);
`);
        const result = spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: resolve('.'), encoding: 'utf8', timeout: 30_000 });
        assert.equal(result.status, 3, result.stderr);
        assert.equal(result.stdout, '\u001b[32mfirst\u001b[0m\nno newline', 'the console still gets the colours and the unfinished line');
        assert.equal(result.stderr, 'an error line\n');
        const saved = readFileSync(file, 'utf8').split('\n');
        assert.match(saved[0]!, /^===== Ghost Vanguard v\d+\.\d+\.\d+ started \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC, process \d+ =====$/);
        assert.deepEqual(saved.slice(1, 4).map(l => l.replace(/^\S+ \S+ /, '')), ['first', 'an error line', 'no newline']);
        assert.match(saved[1]!, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d first$/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

function logsCall(lines: number | null) {
    const sent: any[] = [];
    const i: any = { options: { getSubcommand: () => 'logs', getInteger: () => lines }, editReply: async (p: any) => { sent.push(p); } };
    return { i, sent, run: () => (dev as any).execute({}, i) as Promise<string | void> };
}

test('/dev logs shows the newest lines in the reply, and says so when there is nothing to show', async () => {
    assert.equal(currentConsoleLog(), null);
    assert.match(String(await logsCall(null).run()), /not keeping a copy of its console/);
    const dir = scratch();
    const { stream } = fakeStream();
    try {
        const log = startConsoleLog({ stdout: stream, stderr: fakeStream().stream }, join(dir, 'console.log'));
        assert.equal(currentConsoleLog(), log);
        assert.equal(startConsoleLog({ stdout: stream, stderr: stream }), log, 'a second start returns the same log');
        assert.match(String(await logsCall(null).run()), /has not printed anything yet/);
        for (const n of [1, 2, 3, 4, 5, 6]) stream.write(n === 3 ? 'has ``` inside\n' : `line ${n}\n`);
        const call = logsCall(4);
        const reply = String(await call.run());
        assert.match(reply, /^\*\*Last 4 console lines\*\* · up \d+ min · times are UTC\n```\n/);
        assert.match(reply, /\n\d\d:\d\d:\d\d line 4\n\d\d:\d\d:\d\d line 5\n\d\d:\d\d:\d\d line 6\n```/);
        assert.ok(!reply.includes('line 2') && !reply.includes('has ``` inside'), 'only the newest four lines');
        assert.match(reply, /Older lines are in `[^`]*console\.log`/);
        assert.equal(call.sent.length, 0, 'it fits, so no file');
        for (let n = 0; n < 50; n++) stream.write(`filler ${n}\n`);
        assert.match(String(await logsCall(null).run()), /^\*\*Last 40 console lines\*\*/, 'without a number it shows the newest 40');
        for (const n of [1, 2, 3, 4, 5, 6]) stream.write(n === 3 ? 'has ``` inside\n' : `line ${n}\n`);
        const withTicks = String(await logsCall(5).run());
        assert.match(withTicks, /has ''' inside/, 'three backticks cannot end the code block early');
        assert.equal(withTicks.split('```').length, 3, 'exactly one code block');
    } finally { stopConsoleLog(); rmSync(dir, { recursive: true, force: true }); }
    assert.equal(currentConsoleLog(), null);
});

test('/dev logs attaches a file when the lines do not fit in one message', async () => {
    const dir = scratch();
    const { stream } = fakeStream();
    startConsoleLog({ stdout: stream, stderr: fakeStream().stream }, join(dir, 'console.log'));
    try {
        for (let n = 0; n < 120; n++) stream.write(`console line number ${String(n).padStart(3, '0')} with some words to take up room\n`);
        const call = logsCall(100);
        assert.equal(await call.run(), undefined, 'the reply is sent by the command itself');
        assert.equal(call.sent.length, 1);
        const { content, files } = call.sent[0];
        assert.match(content, /^\*\*Last 100 console lines\*\*.*\nToo long for one message, so it is attached\./s);
        assert.equal(files.length, 1);
        assert.equal(files[0].name, 'console.txt');
        const body = files[0].attachment.toString('utf8').split('\n');
        assert.equal(body.length, 100);
        assert.match(body[0]!, /^\d\d:\d\d:\d\d console line number 020 /);
        assert.match(body.at(-1)!, / console line number 119 /);
    } finally { stopConsoleLog(); rmSync(dir, { recursive: true, force: true }); }
});

test('the bot copies its console from the very first line', () => {
    const startup = readFileSync('src/startup.ts', 'utf8');
    assert.ok(startup.indexOf('startConsoleLog()') > -1 && startup.indexOf('startConsoleLog()') < startup.indexOf('startup.step('), 'the log starts before the first line is printed');
});
