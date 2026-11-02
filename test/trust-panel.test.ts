import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { Store } from '../src/database/db.js';
import { Registry } from '../src/bot/registry.js';
import { scopeName, TRUST_PRESETS } from '../src/ui/antinuke-panel.js';
import { ALLOW_OPTIONS, panelFor, registerTrustPanel, trustPanel } from '../src/ui/trust-panel.js';
import { authorize } from './helpers.js';

const GUILD = '333333333333333333';
const USER = '222222222222222222';
const TARGET = '444444444444444444';

function setup() {
    const store = new Store(':memory:');
    authorize(store, GUILD);
    store.save(store.settings(GUILD));
    const logs: any[] = [];
    const ctx: any = { store, actor: { id: 'owner', guild: { ownerId: 'owner' }, roles: { cache: new Collection() } }, logs: { push: (_guild: string, e: any) => logs.push(e) } };
    const registry = new Registry();
    registerTrustPanel(registry);
    const handler = registry.components[0]!;
    /** Press a control on a rendered panel the way Discord would: by its custom id, with the picked values. */
    async function press(panel: any, row: number, col: number, values: string[] = []) {
        const customId = panel.components[row].toJSON().components[col].custom_id as string;
        let reply: any;
        await handler.execute(ctx, { customId, guildId: GUILD, user: { id: USER }, values, editReply: async (p: any) => { reply = p; } } as any);
        return reply;
    }
    return { store, ctx, logs, press };
}

const dropdown = (panel: any) => panel.components[2].toJSON().components[0] as { options: { label: string; value: string; description?: string; default?: boolean; emoji?: unknown }[] };
const ticked = (panel: any) => dropdown(panel).options.filter(o => o.default).map(o => o.value);
const text = (panel: any) => panel.embeds[0].toJSON().description as string;

test('whitelist dropdown: every option reads in full, fits Discord, and nothing looks ticked', () => {
    const { store, ctx } = setup();
    try {
        const panel = trustPanel(ctx, GUILD, USER, { target: null, role: false, mask: 0, hours: 0 });
        const { options } = dropdown(panel);
        assert.ok(options.length <= 25, 'Discord allows 25 options in one dropdown');
        assert.equal(new Set(options.map(o => o.value)).size, options.length, 'values are unique');
        for (const o of options) {
            assert.ok(o.label.length <= 100, o.label);
            assert.ok((o.description ?? '').length <= 100, `${o.label}: ${o.description}`);
        }
        // Nothing is cut: each preset shows its own full description, with no ellipsis and no open bracket.
        for (const [key, preset] of Object.entries(TRUST_PRESETS)) {
            const shown = options.find(o => o.value === `preset:${key}`)!.description!;
            assert.equal(shown, preset.description, `${preset.title} is shortened in the dropdown`);
            assert.ok(!shown.endsWith('…'), shown);
            assert.equal(shown.split('(').length, shown.split(')').length, `${preset.title} has an unclosed bracket: ${shown}`);
        }
        assert.match(options.find(o => o.value === 'preset:roles')!.description!, /protected permissions need their own whitelist$/);
        // A green check in front of "Everything" read as "already ticked" while the panel said nothing was.
        assert.equal(options[0]!.value, 'all');
        assert.ok(options.every(o => !/^[✅✔✓☑]/u.test(o.label) && !o.emoji), 'no option carries a check mark');
        assert.deepEqual(ticked(panel), []);
        assert.match(text(panel), /\*\*2\. Allowed:\*\* \*nothing ticked\*/);
        // The saved-scope sentence has no brackets inside brackets.
        assert.equal(scopeName(TRUST_PRESETS.roles!.rules).split('(').length, 2);
    } finally { store.close(); }
});

test('whitelist dropdown: Everything keeps the permission-grant tick, and drops the other ticks', async () => {
    const { store, ctx, press } = setup();
    try {
        const start = trustPanel(ctx, GUILD, USER, panelFor(ctx, GUILD, TARGET, false));

        const both = await press(start, 2, 0, ['all', 'dangerous_grant', 'mass_ban', 'preset:moderation']);
        assert.deepEqual(ticked(both), ['all', 'dangerous_grant']);
        assert.match(text(both), /\*\*2\. Allowed:\*\* \*\*Everything\*\* \(full bypass\) \+ \*\*Grant protected permissions\*\*\n/);

        const everythingOnly = await press(start, 2, 0, ['all', 'mass_ban', 'preset:moderation']);
        assert.deepEqual(ticked(everythingOnly), ['all']);
        assert.match(text(everythingOnly), /\*\*2\. Allowed:\*\* \*\*Everything\*\* \(full bypass\)\n/);

        // Ticking the grant entry next to Everything that is already ticked, in either order.
        assert.deepEqual(ticked(await press(everythingOnly, 2, 0, ['all', 'dangerous_grant'])), ['all', 'dangerous_grant']);
        assert.deepEqual(ticked(await press(everythingOnly, 2, 0, ['dangerous_grant', 'all'])), ['all', 'dangerous_grant']);

        // Without Everything nothing is dropped.
        const some = await press(start, 2, 0, ['dangerous_grant', 'mass_ban']);
        assert.deepEqual(ticked(some).sort(), ['dangerous_grant', 'mass_ban']);
    } finally { store.close(); }
});

test('whitelist dropdown: saving Everything with the grant entry stores both and says so', async () => {
    const { store, ctx, logs, press } = setup();
    try {
        const start = trustPanel(ctx, GUILD, USER, panelFor(ctx, GUILD, TARGET, false));
        const picked = await press(start, 2, 0, ['all', 'dangerous_grant']);
        const saved = await press(picked, 4, 0);
        assert.equal(store.hasGrant(GUILD, TARGET, 'trust'), true);
        assert.equal(store.hasGrant(GUILD, TARGET, 'trust:dangerous_grant'), true);
        assert.match(text(saved), /✅ Saved: <@444444444444444444> may now do \*\*everything \(full bypass\) and permission grants\*\* \(until removed\)\./);
        assert.match(text(saved), /\*\*Saved right now:\*\* \*\*Everything\*\* \(full bypass\) \+ \*\*Permission grants\*\*\n/, 'no stray "only" after the plus sign');
        assert.deepEqual(ticked(saved), ['all', 'dangerous_grant'], 'the saved choice comes back ticked');
        assert.match(JSON.stringify(logs.at(-1).toJSON()), /may now: \*\*everything \(full bypass\) and permission grants\*\*/);

        // Everything alone must not turn into a grant entry, and replaces the old pair.
        const justAll = await press(saved, 2, 0, ['all']);
        const savedAll = await press(justAll, 4, 0);
        assert.equal(store.hasGrant(GUILD, TARGET, 'trust'), true);
        assert.equal(store.hasGrant(GUILD, TARGET, 'trust:dangerous_grant'), false);
        assert.match(text(savedAll), /may now do \*\*everything \(full bypass\)\*\* \(until removed\)/);
        assert.doesNotMatch(text(savedAll), /permission grants/);
    } finally { store.close(); }
});
