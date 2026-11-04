import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection, Colors } from 'discord.js';
import { Store } from '../src/database/db.js';
import { Snapshots, layoutHash, recoveryLabel } from '../src/recovery/snapshots.js';
import { LayoutSync, CALM_MS, SYNC_EVERY_MS, SYNC_KEEP, SYNC_MIN_GAP_MS, spread } from '../src/recovery/sync.js';
import { cleanupPlan, CLEANUP_TYPES } from '../src/recovery/cleanup.js';
import { setRaidMode } from '../src/security/raidmode.js';
import { PLUS_DEFAULTS } from '../src/features/plus-settings.js';
import { setFeature } from '../src/features/settings.js';
import { authorize } from './helpers.js';

const TEXT = ChannelType.GuildText, CATEGORY = ChannelType.GuildCategory;

function world() {
    const store = new Store(':memory:');
    authorize(store);
    const settings = store.settings('g');
    settings.enabled = true;
    store.save(settings);
    const snapshots = new Snapshots(store, 0);
    const cards: string[] = [], audits: string[] = [];
    snapshots.onAudit = (_g, title) => { audits.push(title); };
    const roles = new Collection<string, any>(), channels = new Collection<string, any>();
    const addRole = (id: string, name: string, position: number, permissions = 0n) => roles.set(id, { id, name, color: 0, hoist: false, mentionable: false, permissions: { bitfield: permissions }, rawPosition: position, managed: false });
    const addChannel = (id: string, name: string, position: number, parent: string | null = null, type: number = TEXT, overwrites: any[] = []) =>
        channels.set(id, { id, name, type, parentId: parent, rawPosition: position, topic: null, nsfw: false, rateLimitPerUser: 0, isThread: () => false,
            permissionOverwrites: { cache: new Collection(overwrites.map(o => [o.id, { id: o.id, type: o.type, allow: { bitfield: BigInt(o.allow) }, deny: { bitfield: BigInt(o.deny) } }])) } });
    addRole('g', '@everyone', 0);
    addRole('mods', 'Mods', 1);
    addChannel('cat', 'Community', 0, null, CATEGORY);
    addChannel('rules', 'rules', 1, 'cat');
    addChannel('chat', 'chat', 2, 'cat');
    const fetches = { roles: 0, channels: 0 };
    const guild: any = { id: 'g', name: 'Guild', client: { user: { id: 'bot-user' } }, afkTimeout: 300, verificationLevel: 0, explicitContentFilter: 0, defaultMessageNotifications: 0, preferredLocale: 'en-US', afkChannelId: null, systemChannelId: null, rulesChannelId: null, publicUpdatesChannelId: null };
    guild.roles = { cache: roles, fetch: async () => { fetches.roles++; return roles; } };
    guild.channels = { cache: channels, fetch: async () => { fetches.channels++; return channels; } };
    const posted: any[] = [];
    let clock = Date.now();
    const sync = new LayoutSync({ store, snapshots, post: (_g, card) => { posted.push(card.toJSON()); }, now: () => clock });
    const advance = (ms: number) => { clock += ms; return clock; };
    const rows = (purpose?: string) => store.all(`SELECT s.id, s.at, m.kind, m.purpose FROM snapshots s JOIN snapshot_metadata m ON m.snapshot_id=s.id WHERE s.guild_id='g'${purpose ? ` AND m.purpose='${purpose}'` : ''} ORDER BY s.id`);
    const look = () => sync.check(guild, clock);
    /** Look twice, as the timer would five minutes apart: the first sees the change, the second sees it settled. */
    const settle = async () => { await look(); advance(SYNC_EVERY_MS); return look(); };
    return { store, snapshots, sync, guild, addRole, addChannel, roles, channels, fetches, posted, audits, cards, advance, rows, look, settle, now: () => clock };
}

test('the layout hash is about channels and roles only, and notices every change to them', () => {
    const w = world();
    try {
        const base = { roles: [{ id: 'a', name: 'A', color: 0, hoist: false, mentionable: false, permissions: '8', position: 1, managed: false }], channels: [{ id: 'c', name: 'c', type: 0, parent: null, position: 0, overwrites: [{ id: 'a', type: 0, allow: '1', deny: '0' }] }] };
        const same = layoutHash(base);
        assert.equal(layoutHash(structuredClone(base)), same, 'stable');
        const changed: Record<string, any> = {
            'a role is renamed': (d: any) => { d.roles[0].name = 'B'; },
            'a role loses a permission': (d: any) => { d.roles[0].permissions = '0'; },
            'a role moves': (d: any) => { d.roles[0].position = 2; },
            'a channel is renamed': (d: any) => { d.channels[0].name = 'd'; },
            'a channel moves': (d: any) => { d.channels[0].position = 5; },
            'a channel changes category': (d: any) => { d.channels[0].parent = 'x'; },
            'an overwrite changes': (d: any) => { d.channels[0].overwrites[0].deny = '2'; },
            'a channel is added': (d: any) => { d.channels.push({ id: 'd', name: 'd', type: 0, parent: null, position: 1, overwrites: [] }); },
        };
        for (const [what, edit] of Object.entries(changed)) {
            const copy = structuredClone(base);
            edit(copy);
            assert.notEqual(layoutHash(copy), same, what);
        }
        // Mappings, the name and the settings are not part of the layout.
        assert.equal(layoutHash({ ...base, roleMap: { a: 'b' }, channelMap: { c: 'd' }, name: 'Renamed', settings: { afkTimeout: 60 } } as any), same);
    } finally { w.store.close(); }
});

test('a cached capture asks Discord for nothing and matches what a full capture sees', async () => {
    const w = world();
    try {
        const cached = await w.snapshots.capture(w.guild, { cached: true });
        assert.deepEqual(w.fetches, { roles: 0, channels: 0 });
        const full = await w.snapshots.capture(w.guild);
        assert.deepEqual(w.fetches, { roles: 1, channels: 1 });
        assert.deepEqual(cached, full, 'so a layout seen from the cache can be compared with a saved backup');
        assert.equal(layoutHash(cached), layoutHash(full));
    } finally { w.store.close(); }
});

test('a server with no backup gets a synced one once its layout has held still for two looks', async () => {
    const w = world();
    try {
        assert.equal(await w.look(), 'waiting', 'the first look only notes the layout');
        assert.deepEqual(w.rows(), []);
        w.advance(SYNC_EVERY_MS);
        // The save holds the server's recovery lock, so it cannot overlap a restore.
        const save = w.snapshots.save.bind(w.snapshots);
        const lockedDuringSave: boolean[] = [];
        w.snapshots.save = (async (...args: Parameters<Snapshots['save']>) => { lockedDuringSave.push(w.snapshots.locks.busy('g')); return save(...args); }) as any;
        assert.equal(await w.look(), 'saved');
        assert.deepEqual(lockedDuringSave, [true]);
        const [row] = w.rows();
        assert.deepEqual([row!.kind, row!.purpose], ['backup', 'synced']);
        assert.equal(recoveryLabel('backup', 'synced'), 'Synced backup');
        assert.deepEqual(w.audits, [], 'saving is silent: no card in the server\'s log every few minutes');
        assert.equal(w.store.all("SELECT event FROM recovery_events WHERE event='backup_created'").length, 1, 'but it is in the audit trail');
        w.advance(SYNC_EVERY_MS);
        assert.equal(await w.look(), 'unchanged', 'nothing to save while the server matches its newest backup');
        assert.equal(w.rows().length, 1);
    } finally { w.store.close(); }
});

test('a burst of edits is one backup, a change that keeps moving waits, and backups are at least 15 minutes apart', async () => {
    const w = world();
    try {
        await w.settle();
        assert.equal(w.rows().length, 1);
        // A new channel: seen, then still the same → but only 5 minutes since the last save.
        w.addChannel('new', 'new', 3, 'cat');
        w.advance(SYNC_EVERY_MS);
        assert.equal(await w.look(), 'waiting');
        w.advance(SYNC_EVERY_MS);
        assert.equal(await w.look(), 'waiting', 'the same layout twice, but it is too soon after the last backup');
        w.advance(SYNC_MIN_GAP_MS);
        assert.equal(await w.look(), 'saved');
        assert.equal(w.rows().length, 2);
        // Edits on every look never settle.
        for (let n = 0; n < 4; n++) {
            w.addChannel(`busy${n}`, `busy${n}`, 10 + n, 'cat');
            w.advance(SYNC_MIN_GAP_MS);
            assert.equal(await w.look(), 'waiting', `look ${n}`);
        }
        assert.equal(w.rows().length, 2, 'a layout that never holds still is never saved');
    } finally { w.store.close(); }
});

test('nothing is saved while the server looks like it is under attack, locked down or in raid mode', async () => {
    const scenes: [string, (w: ReturnType<typeof world>) => void][] = [
        ['raid mode', w => { setRaidMode(w.store, 'g', true, 'owner', { hours: 1 }); }],
        ['lockdown', w => { w.store.run("INSERT INTO lockdowns(guild_id,started_by,started_at,reason,channel_count) VALUES('g','owner',?,'test',3)", Date.now()); }],
        ['an anti-nuke incident an hour ago or less', w => { w.store.incident('g', 'nuker', 'channel_delete', 'enforce', 'Contained'); }],
        ['a warning', w => { w.store.incident('g', 'someone', 'channel_delete', 'warn', 'Warned'); }],
        ['three deletions just now', w => { for (let n = 0; n < 3; n++) w.store.observe(`d${n}`, 'g', 'someone', n === 2 ? 'role_delete' : 'channel_delete', `x${n}`, Date.now() - 1000); }],
    ];
    for (const [what, setup] of scenes) {
        const w = world();
        try {
            setup(w);
            w.addChannel('new', 'new', 3, 'cat');
            assert.equal(await w.look(), 'not-calm', what);
            w.advance(SYNC_EVERY_MS);
            assert.equal(await w.look(), 'not-calm', what);
            assert.deepEqual(w.rows(), [], what);
        } finally { w.store.close(); }
    }
    // Things that are not trouble do not hold it up.
    const w = world();
    try {
        w.store.incident('g', 'owner', 'channel_delete', 'exempt', 'Not punished: the server owner');
        const old = w.store.incident('g', 'nuker', 'channel_delete', 'enforce', 'Contained');
        // A full minute past the cutoff, so a slow machine cannot bring it back inside the window.
        w.store.run('UPDATE incidents SET at=? WHERE id=?', Date.now() - CALM_MS - 60_000, old);
        w.store.observe('d0', 'g', 'someone', 'channel_delete', 'x0', Date.now() - 1000);
        w.store.observe('d1', 'g', 'someone', 'channel_delete', 'x1', Date.now() - 1000);
        w.store.observe('d2', 'g', 'someone', 'channel_delete', 'x2', Date.now() - 11 * 60_000);
        assert.equal(await w.settle(), 'saved', 'an exempt incident, an old one and two recent deletions are all fine');
    } finally { w.store.close(); }
});

test('the looks start over once things are calm again', async () => {
    const w = world();
    try {
        await w.look();
        setRaidMode(w.store, 'g', true, 'owner', { hours: 1 });
        w.advance(SYNC_EVERY_MS);
        assert.equal(await w.look(), 'not-calm');
        setRaidMode(w.store, 'g', false, 'owner');
        w.advance(SYNC_EVERY_MS);
        assert.equal(await w.look(), 'waiting', 'a layout seen before the trouble does not count as settled');
        w.advance(SYNC_EVERY_MS);
        assert.equal(await w.look(), 'saved');
    } finally { w.store.close(); }
});

test('it stays out of servers where anti-nuke, the layer, or backups are switched off', async () => {
    const cases: [string, (w: ReturnType<typeof world>) => void][] = [
        ['anti-nuke is off', w => { const s = w.store.settings('g'); s.enabled = false; w.store.save(s); }],
        ['the layer is off', w => { setFeature(w.store, 'g', 'antinukeplus', PLUS_DEFAULTS, { backupSync: false }); }],
        ['backups are off for the server', w => { w.store.run("INSERT INTO feature_settings(guild_id,feature,enabled) VALUES('g','snapshots',0)"); }],
    ];
    for (const [what, setup] of cases) {
        const w = world();
        try {
            setup(w);
            assert.equal(await w.settle(), 'off', what);
            assert.deepEqual(w.rows(), [], what);
        } finally { w.store.close(); }
    }
    const legacy = world();
    try {
        legacy.store.run("INSERT INTO guild_features(guild_id,key,json) VALUES('g','antinukeplus',?)", JSON.stringify({ raidAuto: true }));
        assert.equal(await legacy.settle(), 'saved', 'a server saved before the switch existed counts as on');
    } finally { legacy.store.close(); }
});

test('it waits while a restore or another backup holds the recovery lock', async () => {
    const w = world();
    try {
        await w.look();
        w.advance(SYNC_EVERY_MS);
        let status = '';
        await w.snapshots.locks.run(['g'], async () => { status = await w.look(); });
        assert.equal(status, 'busy');
        assert.equal(await w.look(), 'saved', 'and carries on once it is free');
    } finally { w.store.close(); }
});

test('a server that suddenly has far fewer channels keeps its backup and is told why, once', async () => {
    const w = world();
    try {
        for (let n = 0; n < 18; n++) w.addChannel(`extra${n}`, `extra${n}`, 10 + n, 'cat');
        assert.equal(await w.settle(), 'saved', 'a big server is backed up as usual');
        const before = w.rows().length;
        // Someone, without setting anything off, deletes 12 of its 21 channels.
        for (let n = 0; n < 12; n++) w.channels.delete(`extra${n}`);
        w.advance(SYNC_MIN_GAP_MS);
        assert.equal(await w.look(), 'waiting');
        w.advance(SYNC_EVERY_MS);
        assert.equal(await w.look(), 'paused');
        assert.equal(w.rows().length, before, 'the good backup is not pushed out by a copy of the smaller server');
        assert.equal(w.posted.length, 1);
        assert.equal(w.posted[0].title, 'Backup sync paused');
        assert.match(w.posted[0].description, /^The server has 12 fewer channels than backup #\d+, so Vanguard is not saving this layout over it\./);
        assert.match(w.posted[0].description, /\/recovery backup create.*\/recovery backup restore/s);
        assert.equal(w.posted[0].color, Colors.Orange);
        w.advance(SYNC_EVERY_MS);
        assert.equal(await w.look(), 'paused');
        assert.equal(w.posted.length, 1, 'said once');
        // Saving a backup by hand says the smaller server is meant; syncing carries on from there.
        await w.snapshots.locks.run(['g'], () => w.snapshots.save(w.guild, 'owner', 'backup', 'manual'));
        w.advance(SYNC_EVERY_MS);
        assert.equal(await w.look(), 'unchanged');
        w.addChannel('fresh', 'fresh', 99, 'cat');
        w.advance(SYNC_MIN_GAP_MS);
        await w.look();
        w.advance(SYNC_EVERY_MS);
        assert.equal(await w.look(), 'saved');
    } finally { w.store.close(); }
});

test('a server that suddenly has far fewer roles pauses the sync too', async () => {
    const w = world();
    try {
        for (let n = 0; n < 14; n++) w.addRole(`extra${n}`, `Extra ${n}`, 5 + n);
        assert.equal(await w.settle(), 'saved');
        for (let n = 0; n < 9; n++) w.roles.delete(`extra${n}`);
        w.advance(SYNC_MIN_GAP_MS);
        await w.look();
        w.advance(SYNC_EVERY_MS);
        assert.equal(await w.look(), 'paused');
        assert.match(w.posted[0].description, /^The server has 9 fewer roles than backup #\d+, so Vanguard/);
    } finally { w.store.close(); }
});

test('the gap between two backups survives a restart, and an ordinary look asks Discord for nothing', async () => {
    const w = world();
    try {
        assert.equal(await w.settle(), 'saved');
        // The save is stamped with real time; line it up with the test clock so no assertion sits on a boundary.
        w.store.run("UPDATE snapshots SET at=? WHERE guild_id='g'", w.now());
        const asked = { ...w.fetches };
        w.addChannel('new', 'new', 3, 'cat');
        // A new process has no memory of this run; the gap has to come from the database.
        const restarted = new LayoutSync({ store: w.store, snapshots: w.snapshots, post: () => { }, now: () => w.now() });
        w.advance(SYNC_EVERY_MS);
        assert.equal(await restarted.check(w.guild, w.now()), 'waiting', 'the new layout is seen for the first time');
        assert.deepEqual(w.fetches, asked, 'comparing the layout with the newest backup uses the cache only');
        w.advance(SYNC_EVERY_MS);
        assert.equal(await restarted.check(w.guild, w.now()), 'waiting', 'the same layout twice, but the newest backup is only 10 minutes old');
        w.advance(SYNC_MIN_GAP_MS);
        assert.equal(await restarted.check(w.guild, w.now()), 'saved', 'and it is saved once 15 minutes have passed');
        assert.ok(w.fetches.roles > asked.roles && w.fetches.channels > asked.channels, 'saving does read the server');
    } finally { w.store.close(); }
});

test('losing a few channels, or less than a third of them, is ordinary editing', async () => {
    const w = world();
    try {
        for (let n = 0; n < 40; n++) w.addChannel(`extra${n}`, `extra${n}`, 10 + n, 'cat');
        await w.settle();
        for (let n = 0; n < 8; n++) w.channels.delete(`extra${n}`);
        w.advance(SYNC_MIN_GAP_MS);
        await w.look();
        w.advance(SYNC_EVERY_MS);
        assert.equal(await w.look(), 'saved', '8 of 43 is under a third');
        const small = world();
        try {
            await small.settle();
            small.channels.delete('chat');
            small.advance(SYNC_MIN_GAP_MS);
            await small.look();
            small.advance(SYNC_EVERY_MS);
            assert.equal(await small.look(), 'saved', 'one of three channels is a small server tidying up');
        } finally { small.store.close(); }
    } finally { w.store.close(); }
});

test('layout copies from other servers never count as the newest backup', async () => {
    const w = world();
    try {
        const live = await w.snapshots.capture(w.guild, { cached: true });
        const id = Number(w.store.run('INSERT INTO snapshots(guild_id,by_id,at,json) VALUES(?,?,?,?)', 'g', 'owner', Date.now(), JSON.stringify(live)).lastInsertRowid);
        w.store.run("INSERT INTO snapshot_metadata(snapshot_id,guild_id,kind,source_guild) VALUES(?,?,'copy','other')", id, 'g');
        assert.equal(await w.settle(), 'saved', 'a template that happens to match is not a backup of this server');
    } finally { w.store.close(); }
});

test('only the newest five synced backups are kept; every other kind is left alone', async () => {
    const w = world();
    try {
        const save = (kind: 'snapshot' | 'backup', purpose: any) => w.snapshots.save(w.guild, 'owner', kind, purpose);
        const manual = await save('backup', 'manual'), scheduled = await save('backup', 'scheduled'), baseline = await save('snapshot', 'baseline'), rollback = await save('backup', 'rollback');
        w.audits.length = 0; // those four were saved by hand and do post cards
        for (let n = 0; n < SYNC_KEEP + 3; n++) {
            w.addChannel(`n${n}`, `n${n}`, 20 + n, 'cat');
            w.advance(SYNC_MIN_GAP_MS);
            await w.look();
            w.advance(SYNC_EVERY_MS);
            assert.equal(await w.look(), 'saved', `round ${n}`);
        }
        const synced = w.rows('synced');
        assert.equal(synced.length, SYNC_KEEP);
        const all = w.rows().map(r => Number(r.id));
        for (const kept of [manual, scheduled, baseline, rollback]) assert.ok(all.includes(kept), 'the other kinds are untouched');
        assert.deepEqual(w.store.all("SELECT COUNT(*) AS n FROM recovery_events WHERE event='synced_snapshot_expired'").map(r => r.n), [3]);
        assert.deepEqual(w.audits, [], 'none of it posts a card');
        // They can be cleaned up as their own kind.
        assert.ok(CLEANUP_TYPES.includes('synced' as any));
        const plan = cleanupPlan(w.store, 'g', { olderThanDays: 0, type: 'synced', keepLatest: 0 });
        assert.deepEqual(plan.ids.sort(), synced.map(r => Number(r.id)).sort());
    } finally { w.store.close(); }
});

test('the timer looks at each server once every five minutes, at a time of its own, and only when it is ready', async () => {
    const w = world();
    try {
        const looked: string[] = [];
        w.sync.check = (async (guild: any) => { looked.push(guild.id); return 'unchanged'; }) as any;
        const t0 = w.now();
        let ready = false;
        for (let minute = 0; minute <= 12; minute++)
            await w.sync.tick([w.guild], () => ready, t0 + minute * 60_000);
        assert.deepEqual(looked, [], 'a server that is not ready is skipped');
        // A server is first looked at after its own delay, never in the same tick it was first seen.
        const turn = spread('g');
        assert.ok(turn > 0 && turn < SYNC_EVERY_MS);
        const fresh = world(), seen: number[] = [];
        try {
            fresh.sync.check = (async () => { seen.push(1); return 'unchanged'; }) as any;
            const t = fresh.now();
            await fresh.sync.tick([fresh.guild], () => true, t);
            await fresh.sync.tick([fresh.guild], () => true, t + turn - 1);
            assert.deepEqual(seen, [], 'not yet');
            await fresh.sync.tick([fresh.guild], () => true, t + turn);
            assert.deepEqual(seen, [1], 'its turn');
            await fresh.sync.tick([fresh.guild], () => true, t + turn + SYNC_EVERY_MS - 1);
            assert.deepEqual(seen, [1], 'and then not again for five minutes');
            await fresh.sync.tick([fresh.guild], () => true, t + turn + SYNC_EVERY_MS);
            assert.deepEqual(seen, [1, 1]);
        } finally { fresh.store.close(); }
        ready = true;
        for (let minute = 13; minute <= 40; minute++)
            await w.sync.tick([w.guild], () => ready, t0 + minute * 60_000);
        assert.ok(looked.length >= 5 && looked.length <= 6, `about once every ${SYNC_EVERY_MS / 60000} minutes, not every minute: ${looked.length}`);
        // Each server's first turn is spread over the interval by its ID, so a restart does not look at every server at once.
        const turns = ['1170000000000000001', '1170000000000000002', '1170000000000000003', '1170000000000000004', '1170000000000000005', '1170000000000000006'].map(spread);
        assert.ok(turns.every(t => t >= 0 && t < SYNC_EVERY_MS), 'always inside the interval');
        assert.ok(new Set(turns).size > 3, 'and not the same for every server');
        assert.equal(spread('1170000000000000001'), turns[0], 'and the same every time');
    } finally { w.store.close(); }
});

test('the timer runs each look inside the server\'s authorization scope and still reads and saves what it needs', async () => {
    const w = world();
    try {
        const t0 = w.now();
        await w.sync.tick([w.guild], () => true, t0);
        await w.sync.tick([w.guild], () => true, t0 + SYNC_EVERY_MS);
        assert.deepEqual(w.rows(), [], 'the first real look only notes the layout');
        await w.sync.tick([w.guild], () => true, t0 + 2 * SYNC_EVERY_MS);
        assert.equal(w.rows('synced').length, 1, 'the scoped database reads and the save all went through');
    } finally { w.store.close(); }
});

test('a failure while looking at one server is logged and the next server is still looked at', async () => {
    const w = world();
    try {
        const other: any = { ...w.guild, id: 'h' };
        authorize(w.store, 'h');
        const seen: string[] = [];
        w.sync.check = (async (guild: any) => { seen.push(guild.id); if (guild.id === 'g') throw new Error('boom'); return 'unchanged'; }) as any;
        const t0 = w.now();
        await w.sync.tick([w.guild, other], () => true, t0);
        await w.sync.tick([w.guild, other], () => true, t0 + SYNC_EVERY_MS * 2);
        assert.deepEqual(seen, ['g', 'h']);
    } finally { w.store.close(); }
});

test('a removed server is forgotten, so it starts fresh if the bot returns', async () => {
    const w = world();
    try {
        await w.look();
        w.sync.forget('g');
        w.advance(SYNC_EVERY_MS);
        assert.equal(await w.look(), 'waiting', 'the earlier look is gone');
    } finally { w.store.close(); }
});

test('the numbers in the docs are the numbers in the code', () => {
    assert.equal(SYNC_EVERY_MS, 5 * 60_000, 'checked every five minutes');
    assert.equal(SYNC_MIN_GAP_MS, 15 * 60_000, 'at least 15 minutes apart');
    assert.equal(SYNC_KEEP, 5, 'the newest five are kept');
    assert.equal(CALM_MS, 60 * 60_000, 'an incident holds it back for an hour');
});
