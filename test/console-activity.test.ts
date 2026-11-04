import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { logEvent } from '../src/errors.js';
import { accessSummary } from '../src/bot/access-summary.js';
import { announceStopped, announceStopping, drained } from '../src/startup-progress.js';
import { Store } from '../src/database/db.js';

const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');

/** What logEvent prints under the given settings. Both default to the shipped defaults, whatever .env says. */
function printed(work: () => void, settings: { logLevel?: string; logFormat?: string } = {}) {
    const original = console.log, level = config.logLevel, format = config.logFormat, lines: string[] = [];
    config.logLevel = settings.logLevel ?? 'info';
    config.logFormat = settings.logFormat ?? 'pretty';
    console.log = (...args: any[]) => { lines.push(plain(args.join(' '))); };
    try { work(); } finally { console.log = original; config.logLevel = level; config.logFormat = format; }
    return lines;
}

const typed = { command: 'staff', subcommand: 'global', typed: 'setup staff global', user: 'aiden', userId: '1277709272041394187', guildId: '123', guild: 'Midtown HQ', durationMs: 142, result: 'success' };
const untyped = { command: 'tp', subcommand: '', user: 'aiden', userId: '1277709272041394187', guildId: '123', guild: 'Midtown HQ', durationMs: 3, result: 'success' };

test('a typed command is one line: what was typed, who, where, how long', () => {
    const run = (launcher: boolean, fields: Record<string, unknown> = typed) => {
        const had = Object.getOwnPropertyDescriptor(process, 'send');
        Object.defineProperty(process, 'send', { value: launcher ? () => true : undefined, configurable: true, writable: true });
        try { return printed(() => logEvent('command_activity', fields)); }
        finally { if (had) Object.defineProperty(process, 'send', had); else delete (process as any).send; }
    };
    const [line, ...rest] = run(false);
    assert.deepEqual(rest, []);
    assert.match(line!, /^\d\d:\d\d:\d\d {2}\/setup staff global · aiden · Midtown HQ · 142 ms$/, 'on its own the bot adds the time');
    assert.deepEqual(run(true), ['  /setup staff global · aiden · Midtown HQ · 142 ms'], 'under launch.js the host panel adds the time');
    // A command in a direct message has no server to name.
    assert.deepEqual(run(true, { ...typed, guild: null }), ['  /setup staff global · aiden · 142 ms']);
});

test('buttons, menus and autocomplete (no typed command) stay at debug level', () => {
    assert.deepEqual(printed(() => logEvent('command_activity', untyped)), []);
    assert.deepEqual(printed(() => logEvent('command_activity', typed), { logLevel: 'warn' }), [], 'LOG_LEVEL=warn keeps the console quiet');
    const debug = printed(() => logEvent('command_activity', untyped), { logLevel: 'debug' });
    assert.equal(debug.length, 1);
    assert.match(debug[0]!, /DEBUG +Command activity · command=tp/);
});

test('with LOG_FORMAT=json a typed command is one JSON object', () => {
    const [line, ...rest] = printed(() => logEvent('command_activity', typed), { logFormat: 'json' });
    assert.deepEqual(rest, []);
    assert.deepEqual({ event: JSON.parse(line!).event, typed: JSON.parse(line!).typed, durationMs: JSON.parse(line!).durationMs }, { event: 'command_activity', typed: 'setup staff global', durationMs: 142 });
});

test('the bot says why it is stopping and then that it stopped, in plain text or as JSON', () => {
    const out: string[] = [];
    announceStopping('asked to stop (SIGTERM)', line => out.push(line), false);
    announceStopped(0, line => out.push(line), false);
    announceStopped(75, line => out.push(line), false);
    assert.deepEqual(out, ['› Stopping: asked to stop (SIGTERM)', '› Stopped · exit code 0', '› Stopped · exit code 75']);
    const json: string[] = [];
    announceStopping('Ctrl+C (SIGINT)', line => json.push(line), true);
    announceStopped(1, line => json.push(line), true);
    assert.deepEqual(json.map(l => { const o = JSON.parse(l); return [o.event, o.reason ?? o.code]; }), [['shutdown_started', 'Ctrl+C (SIGINT)'], ['shutdown_finished', 1]]);
    assert.ok(json.every(l => !Number.isNaN(Date.parse(JSON.parse(l).timestamp))));
});

test('drained waits for what is already queued, gives up after its limit, and never fails', async () => {
    const writes: string[] = [];
    const answers = (after: number | null) => ({ write(chunk: string, callback: () => void) { writes.push(chunk); if (after !== null) setTimeout(callback, after); return true; } });
    const t0 = Date.now();
    await drained([answers(30), answers(60)], 2000);
    assert.ok(Date.now() - t0 >= 55 && Date.now() - t0 < 1500, 'waited for the slower stream, not for the limit');
    assert.deepEqual(writes, ['', ''], 'an empty write queues behind everything already written');
    const t1 = Date.now();
    await drained([answers(null)], 80);
    assert.ok(Date.now() - t1 >= 75 && Date.now() - t1 < 1500, 'a stream that never answers costs only the limit');
    await drained([{ write() { throw new Error('closed'); } }], 2000);
    await drained([], 2000);
});

test('index.ts announces the stop before it closes anything, and the exit code last, and every cause gives a reason', () => {
    const source = readFileSync('src/index.ts', 'utf8');
    const body = source.slice(source.indexOf('async function shutdown('), source.indexOf('selfRestart.run ='));
    assert.match(body, /shuttingDown = true;\n\s+announceStopping\(reason\);\n\s+timers\.forEach\(clearInterval\);/, 'said first, before any timer or connection is closed');
    assert.match(body, /store\.close\(\);\n\s+announceStopped\(code\);\n\s+\/\/[^\n]*\n\s+await drained\(\);\n\s+process\.exit\(code\);/, 'said last, with the code the launcher will see, and given a moment to leave a busy pipe');
    assert.doesNotMatch(source, /\bshutdown\((\d+)?\)/, 'every shutdown( call says why');
    for (const [signal, reason] of [['SIGINT', 'Ctrl\\+C'], ['SIGTERM', 'asked to stop \\(SIGTERM\\)']])
        assert.match(source, new RegExp(`process\\.on\\('${signal}', \\(\\) => task\\('shutdown', shutdown\\(0, '${reason}`), `${signal} says why`);
    for (const cause of ['uncaught exception', 'unhandled rejection', 'could not log in', 'lease was lost', 'lease could not be renewed', 'health server', 'restart requested', 'start-up failed'])
        assert.ok(source.includes(cause), `a stop caused by "${cause}" is named`);
    assert.match(source, /accessSummary\(store, id => client\.users\.cache\.get\(id\)\?\.username\)/, 'the access list asks the bot who each ID is');
});

test('the access list names people the bot has seen, and says how to take back a rank given with a command', () => {
    const owner = '1277709272041394187', overseer = '1446573101142769847', supreme = '843909457616044092';
    const was = { ownerId: config.ownerId, developers: new Set(config.developers) };
    const store = new Store(':memory:'), supremeBefore = new Set(config.supremeExtra);
    try {
        // SUPREME_LEADER_IDS in .env would add IDs to the same line, so this test sets it.
        config.supremeExtra.clear();
        config.ownerId = owner; config.developers.clear(); config.developers.add(owner);
        const names: Record<string, string> = { [owner]: 'aiden', [overseer]: 'jane' };
        assert.ok(!accessSummary(store).join('\n').includes('Remove rank'), 'no rank given with the command, nothing to take back');
        store.run("INSERT INTO bot_staff(user_id,level,by_id,at) VALUES(?,?,?,?)", overseer, 'overseer', owner, 1);
        store.run("INSERT INTO bot_staff(user_id,level,by_id,at) VALUES(?,?,?,?)", supreme, 'supreme', owner, 1);
        const text = plain(accessSummary(store, id => names[id]).join('\n'));
        assert.match(text, new RegExp(`Owner +${owner} · aiden\\n`));
        assert.match(text, new RegExp(`Developers +${owner} · aiden\\n`));
        assert.match(text, new RegExp(`Bot-wide +${overseer} \\(overseer\\) · jane\\n`));
        assert.match(text, new RegExp(`Supreme +${supreme}\\n`), 'someone the bot has not seen is just the ID');
        assert.match(text, /Bot-wide.*\n +To take back a rank given with \/setup staff global, run it again with rank "Remove rank"\.\n +Bot DMs to/);
        // Without a name lookup the lines are what they were before.
        assert.match(plain(accessSummary(store).join('\n')), new RegExp(`Bot-wide +${overseer} \\(overseer\\)\\n`));
    } finally { config.ownerId = was.ownerId; config.developers.clear(); for (const id of was.developers) config.developers.add(id); config.supremeExtra.clear(); for (const id of supremeBefore) config.supremeExtra.add(id); store.close(); }
});
