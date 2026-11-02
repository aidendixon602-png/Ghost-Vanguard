import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStartupProgress, REMINDER_MS } from '../src/startup-progress.js';

const recorder = () => {
    const lines: string[] = [];
    return { lines, print: (line: string) => { lines.push(line); } };
};

/** Fake timers for setInterval and Date, so "30 seconds" is exact and nothing really waits. */
const withFakeTime = (work: () => void) => {
    mock.timers.enable({ apis: ['setInterval', 'Date'] });
    try { work(); } finally { mock.timers.reset(); }
};

test('every step is printed the moment it begins', () => {
    const { lines, print } = recorder();
    const progress = createStartupProgress(print, { json: false });
    progress.step('Starting Ghost Vanguard v3.2.1');
    progress.step('Opening the database');
    progress.done();
    assert.deepEqual(lines, ['› Starting Ghost Vanguard v3.2.1', '› Opening the database']);
});

test('a step that runs long is reminded about every 30 seconds, with how long and what it was told to say', () => withFakeTime(() => {
    const { lines, print } = recorder();
    const progress = createStartupProgress(print, { json: false });
    progress.step('Connecting to Discord', 'The bot is running; Discord has not answered yet.');
    mock.timers.tick(REMINDER_MS - 1);
    assert.deepEqual(lines, ['› Connecting to Discord'], 'nothing before 30 seconds');
    mock.timers.tick(1);
    assert.equal(lines[1], '⚠ Still waiting after 30 s on "Connecting to Discord". The bot is running; Discord has not answered yet.');
    mock.timers.tick(REMINDER_MS);
    assert.match(lines[2]!, /after 60 s on "Connecting to Discord"/);
    progress.done();
}));

test('a new step starts its own count, so a quick step is never reported as slow', () => withFakeTime(() => {
    const { lines, print } = recorder();
    const progress = createStartupProgress(print, { json: false });
    progress.step('Opening the database');
    mock.timers.tick(20_000);
    progress.step('Loading commands and checking the database');
    mock.timers.tick(20_000);
    assert.equal(lines.length, 2, '40 seconds in, but only 20 seconds into this step: no reminder, and none about the first step');
    mock.timers.tick(10_000);
    assert.equal(lines.length, 3);
    assert.match(lines[2]!, /^⚠ Still waiting after 30 s on "Loading commands and checking the database"\.$/);
    progress.done();
}));

test('detail shows up in the next reminder and is never printed by itself', () => withFakeTime(() => {
    const { lines, print } = recorder();
    const progress = createStartupProgress(print, { json: false });
    progress.step('Connected as Ghost Vanguard#0001. Starting servers');
    progress.detail('1 of 3');
    progress.detail('2 of 3');
    assert.equal(lines.length, 1, 'detail prints nothing');
    mock.timers.tick(REMINDER_MS);
    assert.equal(lines[1], '⚠ Still waiting after 30 s on "Connected as Ghost Vanguard#0001. Starting servers" (2 of 3).');
    progress.step('Registering slash commands');
    mock.timers.tick(REMINDER_MS);
    assert.doesNotMatch(lines.at(-1)!, /2 of 3/, 'the detail belongs to the step it was set on');
    progress.done();
}));

test('done stops the reminders for good, and steps after it are ignored', () => withFakeTime(() => {
    const { lines, print } = recorder();
    const progress = createStartupProgress(print, { json: false });
    progress.step('Registering slash commands');
    progress.done();
    mock.timers.tick(REMINDER_MS * 4);
    progress.step('Something late');
    mock.timers.tick(REMINDER_MS * 4);
    assert.deepEqual(lines, ['› Registering slash commands']);
}));

test('with LOG_FORMAT=json every line is one JSON object', () => withFakeTime(() => {
    const { lines, print } = recorder();
    const progress = createStartupProgress(print, { json: true });
    progress.step('Connecting to Discord', 'not used in JSON');
    progress.detail('attempt 1');
    mock.timers.tick(REMINDER_MS);
    const [first, second] = lines.map(line => JSON.parse(line));
    assert.deepEqual([first.event, first.step], ['startup_progress', 'Connecting to Discord']);
    assert.deepEqual([second.event, second.step, second.detail, second.waitedSeconds], ['startup_slow', 'Connecting to Discord', 'attempt 1', 30]);
    assert.ok(!Number.isNaN(Date.parse(first.timestamp)));
    progress.done();
}));

test('a pending reminder never keeps the process alive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vanguard-progress-'));
    try {
        const script = join(dir, 'probe.mts');
        writeFileSync(script, `import { createStartupProgress } from ${JSON.stringify(pathToFileURL(resolve('src/startup-progress.ts')).href)};
createStartupProgress(() => {}, { json: false, reminderMs: 50 }).step('waiting forever');
`);
        const result = spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: resolve('.'), encoding: 'utf8', timeout: 20_000 });
        assert.equal(result.error, undefined, `the probe should end on its own: ${result.error?.message}`);
        assert.equal(result.status, 0, result.stderr);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('index.ts imports the start-up notice first and reports each step in the order the bot goes through them', () => {
    const source = readFileSync('src/index.ts', 'utf8');
    assert.match(source.split('\n').find(line => line.startsWith('import '))!, /from '\.\/startup\.js'/, 'first import, so its line is printed before the rest of the bot is evaluated');
    const inOrder = (markers: string[]) => {
        const at = markers.map(marker => { const i = source.indexOf(marker); assert.notEqual(i, -1, `${marker} is in index.ts`); return i; });
        assert.deepEqual([...at].sort((a, b) => a - b), at, `in order: ${markers.join(' → ')}`);
    };
    inOrder(["startup.step('Opening the database')", "startup.step('Loading commands and checking the database')", "startup.step('Connecting to Discord'", 'await client.login(']);
    inOrder(['startup.step(`Connected as', "startup.step('Registering slash commands')", 'startup.done()', "logEvent('ready'"]);
});

test('the first line is printed before anything else, even when the settings are wrong and the bot cannot start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-boot-'));
    try {
        const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
            cwd: resolve('.'), encoding: 'utf8', timeout: 90_000,
            env: { ...process.env, DISCORD_TOKEN: '', DISCORD_CLIENT_ID: '', DEVELOPER_IDS: '', NO_COLOR: '1', DATABASE_PATH: join(dir, 'vanguard.db') },
        });
        assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
        assert.match(result.stdout, /^› Starting Ghost Vanguard v\d+\.\d+\.\d+$/m, 'the console says the bot is starting');
        assert.match(result.stderr, /Ghost Vanguard cannot start/);
        // The same two messages are in the console log next to the database, for a host whose console tab stays empty.
        const saved = readFileSync(join(dir, 'console.log'), 'utf8');
        assert.match(saved, /^===== Ghost Vanguard v\d+\.\d+\.\d+ started .* UTC, process \d+ =====$/m);
        assert.match(saved, /^\S+ \S+ › Starting Ghost Vanguard v\d+\.\d+\.\d+$/m);
        assert.match(saved, /^\S+ \S+ ✖ Ghost Vanguard cannot start\. Fix these settings in \.env:$/m);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
