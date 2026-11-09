import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/database/db.js';
import plus from '../src/commands/antinuke/antinuke-plus.js';
import { plusConfig, PLUS_DEFAULTS } from '../src/features/plus-settings.js';
import { authorize } from './helpers.js';

function run(store: Store, options: Record<string, boolean | number | null> = {}, sub = 'settings') {
    const pushed: any[] = [];
    const ctx: any = { store, logs: { push: (_guild: string, card: any) => pushed.push(card.toJSON()) } };
    const i: any = { guildId: 'g', guild: { id: 'g' }, user: { id: 'owner' }, options: {
        getSubcommand: () => sub,
        getBoolean: (name: string) => (name in options ? options[name] : null),
        getInteger: (name: string) => (name in options ? options[name] : null),
    } };
    return plus.execute(ctx, i).then(text => ({ text: String(text), pushed }));
}

test('/antinuke settings has a switch for each new layer, each with a description Discord will accept', () => {
    const data: any = plus.data, json: any = data.toJSON ? data.toJSON() : data;
    const settings = json.options.find((o: any) => o.name === 'settings');
    const names = settings.options.map((o: any) => o.name);
    for (const name of ['backup_sync', 'auto_restore', 'new_account_guard']) {
        assert.ok(names.includes(name), name);
        const option = settings.options.find((o: any) => o.name === name);
        assert.equal(option.type, 5, `${name} is a yes/no option`);
        assert.ok(option.description.length > 0 && option.description.length <= 100, `${name} description is ${option.description.length} characters`);
    }
    assert.ok(settings.options.length <= 25);
});

test('the new layers are on for every server, including ones saved before they existed', async () => {
    const store = new Store(':memory:');
    try {
        authorize(store, 'g');
        assert.deepEqual([PLUS_DEFAULTS.backupSync, PLUS_DEFAULTS.autoRestore, PLUS_DEFAULTS.freshGuard], [true, true, true]);
        store.run("INSERT INTO guild_features(guild_id,key,json) VALUES('g','antinukeplus',?)", JSON.stringify({ raidAuto: false, raidAutoHours: 2, settingsLock: true, botQuarantine: true }));
        const c = plusConfig(store, 'g');
        assert.deepEqual([c.raidAuto, c.backupSync, c.autoRestore, c.freshGuard], [false, true, true, true]);
        const { text } = await run(store);
        assert.match(text, /\*\*New-account guard:\*\* 🟢 on\n\*\*Backup sync:\*\* 🟢 on\n\*\*Auto-restore:\*\* 🟢 on/);
        assert.equal(plusConfig(store, 'g').raidAuto, false, 'looking at the settings changes none of them');
    } finally { store.close(); }
});

test('each switch changes only itself, is remembered, and is shown with the others', async () => {
    const store = new Store(':memory:');
    try {
        authorize(store, 'g');
        let { text, pushed } = await run(store, { backup_sync: false });
        assert.match(text, /\*\*Backup sync:\*\* ⚪ off/);
        assert.match(text, /\*\*Auto-restore:\*\* 🟢 on/);
        assert.match(text, /\*\*New-account guard:\*\* 🟢 on/);
        assert.deepEqual([plusConfig(store, 'g').backupSync, plusConfig(store, 'g').autoRestore, plusConfig(store, 'g').freshGuard], [false, true, true]);
        assert.match(pushed[0].description, /\*\*Backup sync:\*\* ⚪ off/, 'the change is logged for staff');
        ({ text } = await run(store, { new_account_guard: false, auto_restore: false }));
        assert.match(text, /\*\*New-account guard:\*\* ⚪ off/);
        assert.match(text, /\*\*Auto-restore:\*\* ⚪ off/);
        assert.match(text, /\*\*Backup sync:\*\* ⚪ off/, 'an earlier switch is not flipped back by a later command');
        ({ text } = await run(store, { backup_sync: true, auto_restore: true, new_account_guard: true }));
        assert.deepEqual([plusConfig(store, 'g').backupSync, plusConfig(store, 'g').autoRestore, plusConfig(store, 'g').freshGuard], [true, true, true]);
        assert.match(text, /These work while anti-nuke is enabled\./);
    } finally { store.close(); }
});
