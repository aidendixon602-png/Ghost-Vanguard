import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { authorize } from './helpers.js';
import { Store } from '../src/database/db.js';
import { createRecord, setStatus } from '../src/audit/ban-log.js';
import { askLauncher, describeUpdate } from '../src/bot/updater-link.js';
import bans from '../src/commands/moderation/bans.js';
import dev from '../src/commands/developer/dev.js';
import { Registry } from '../src/bot/registry.js';
import { treeJson } from '../src/bot/command-tree.js';
import { prefixHelp } from '../src/bot/prefix-commands.js';

const G = '500000000000000001', MOD = '223456789012345678', U1 = '400000000000000001', U2 = '400000000000000002';

function seed() {
    const store = new Store(':memory:'); authorize(store, G);
    const d = (o: any) => ({ kind: 'ban', reason: 'raid', evidence: null, moderatorId: MOD, moderatorRole: 'via-bot' as const, approved: null, duration: 'Permanent', expiresAt: null, ...o });
    return store.withAuthorized(G, async () => {
        const a = createRecord(store, G, { id: U1, tag: 'one' }, d({}));
        createRecord(store, G, { id: U2, tag: 'two' }, d({ kind: 'tempban', reason: 'spam' }));
        setStatus(store, a, 'unbanned', MOD, 'via-bot', 'appeal');
        createRecord(store, G, { id: U1, tag: 'one' }, d({ kind: 'hardban', networkRecord: 'HB-00002', reason: 'threats' }));
        return store;
    });
}
async function run(store: Store, sub: string, opts: Record<string, any> = {}) {
    let out: any;
    const i: any = { guildId: G, options: { getSubcommand: () => sub, getString: (n: string) => opts[n], getUser: () => opts.user }, editReply: async (p: any) => { out = p; } };
    await store.withAuthorized(G, () => bans.execute({ store } as any, i));
    return JSON.stringify(out);
}

test('/mod bans: lookup, case, recent and stats read the ban log', async () => {
    const store = await seed();
    try {
        const lookup = await run(store, 'lookup', { user: { id: U1, tag: 'one', username: 'one', displayAvatarURL: () => 'https://a/b.png' } });
        assert.match(lookup, /BAN-0003.*Hardban HB-00002/); assert.match(lookup, /BAN-0001.*Unbanned/);
        assert.doesNotMatch(lookup, /BAN-0002/, 'only this user');
        assert.match(await run(store, 'case', { id: 'ban-0002' }), /two - Banned/);
        assert.match(await run(store, 'case', { id: '2' }), /two - Banned/);
        await assert.rejects(run(store, 'case', { id: '99' }), /no BAN-0099/);
        await assert.rejects(run(store, 'case', { id: 'abc' }), /like BAN-0005/);
        const recent = await run(store, 'recent');
        assert.ok(recent.indexOf('BAN-0003') < recent.indexOf('BAN-0001'), 'newest first');
        const stats = await run(store, 'stats');
        assert.match(stats, /"name":"Bans","value":"\*\*3\*\*"/); assert.match(stats, /"name":"Unbans \/ expired","value":"\*\*1\*\*"/);
        assert.match(stats, new RegExp(`🥇 <@${MOD}> · 3`));
    } finally { store.close(); }
});

test('/dev update talks to launch.js, and explains when it is not available', async () => {
    assert.match(describeUpdate(null, 'status'), /not started with `node launch.js`/);
    const proc: any = new EventEmitter();
    proc.connected = true;
    proc.send = (m: any) => setImmediate(() => proc.emit('message', { type: 'vg-update-result', id: m.id, enabled: true, repo: 'o/r', branch: 'main', running: 'abcdef1234', fallback: 'abcdef1234', intervalMinutes: 5,
        lastCheck: { at: Date.now(), result: 'current' }, rejected: [], result: m.op === 'now' ? { state: 'installing', sha: '1234567890' } : undefined }));
    const status = await askLauncher('status', 1000, proc);
    const statusText = describeUpdate(status, 'status');
    assert.match(statusText, /Running.*abcdef1/);
    assert.match(statusText, /\[o\/r\]\(https:\/\/github\.com\/o\/r\)/, 'repository is clickable');
    assert.match(statusText, /https:\/\/github\.com\/o\/r\/commit\/abcdef1234/, 'running commit is clickable');
    assert.match(statusText, /Last check.*Up to date.*<t:\d+:R>/);
    const firstRun = describeUpdate({ ...status!, lastCheck: { at: 0, result: 'not checked yet' } }, 'status');
    assert.match(firstRun, /No check has completed yet/);
    assert.doesNotMatch(firstRun, /<t:\d+:R>/, 'never labels an unchecked state as just checked');
    const installing = describeUpdate(await askLauncher('now', 1000, proc), 'now');
    assert.match(installing, /Installing .*1234567/);
    const silent: any = new EventEmitter(); silent.connected = true; silent.send = () => {};
    assert.equal(await askLauncher('status', 50, silent), null, 'no answer → null, never hangs');
    assert.match(describeUpdate({ enabled: false } as any, 'status'), /Automatic updates are off/);
    const disabled = describeUpdate({ enabled: false, why: 'UPDATE_TOKEN is empty in .env' } as any, 'status');
    assert.match(disabled, /UPDATE_TOKEN is empty in \.env/, 'says exactly why');
    assert.match(disabled, /Restart in the hosting panel/, 'explains how to apply the fix');
});

test('/dev update and restarts are available in slash and comma commands', async () => {
    const subcommands = (dev.data.options ?? []).map(option => option.name);
    assert.ok(subcommands.includes('update'), 'the handler and GitHub updater remain intact');
    assert.equal(subcommands.includes('restart'), false);
    const registry = new Registry();
    await registry.load();
    const tree = treeJson(registry);
    assert.ok(tree.some(command => command.name === 'dev'), '/dev is in the slash-command list');
    assert.ok(tree.some(command => command.name === 'restart'), '/restart is in the slash-command list');
    assert.match(prefixHelp(registry), /`,update \[status\|now\]`/);
    assert.match(prefixHelp(registry), /`,restart`/);
});

test('launcher restart requests ask launch.js and report when unavailable', async () => {
    const { askRestart } = await import('../src/bot/updater-link.js');
    const proc: any = new EventEmitter(); proc.connected = true;
    proc.send = (m: any) => setImmediate(() => proc.emit('message', { type: 'vg-restart-result', id: m.id, ok: true }));
    assert.equal(await askRestart('1', 1000, proc), true);
    const noLauncher: any = new EventEmitter();
    assert.equal(await askRestart('1', 50, noLauncher), null, 'not started by launch.js');
});
