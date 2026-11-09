import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, Collection, PermissionFlagsBits } from 'discord.js';
import { Store } from '../src/database/db.js';
import { Security } from '../src/security/security.js';
import { age, freshness, FRESH_ACCOUNT_DAYS, FRESH_MEMBER_HOURS } from '../src/security/fresh-guard.js';
import { approveRoleChange } from '../src/security/role-authorizations.js';
import { PLUS_DEFAULTS } from '../src/features/plus-settings.js';
import { setFeature } from '../src/features/settings.js';
import { config } from '../src/config.js';
import { authorize } from './helpers.js';

const HOUR = 3600000, DAY = 24 * HOUR;
const GRANTER = '333333333333333333', TARGET = '444444444444444444';

test('age reads like a person would say it', () => {
    assert.equal(age(0), 'under a minute');
    assert.equal(age(59_999), 'under a minute');
    assert.equal(age(60_000), '1 minute');
    assert.equal(age(12 * 60_000), '12 minutes');
    assert.equal(age(HOUR), '1 hour');
    assert.equal(age(47 * HOUR), '47 hours');
    assert.equal(age(48 * HOUR), '2 days');
    assert.equal(age(-5), 'under a minute', 'a clock that runs ahead never prints a negative age');
});

test('someone is new when the account is under 7 days old or they joined under 24 hours ago', () => {
    const now = Date.now();
    const member = (accountMs: number, joinedMs: number | null, bot = false) => ({ user: { bot, createdTimestamp: now - accountMs }, joinedTimestamp: joinedMs === null ? null : now - joinedMs });
    assert.deepEqual(freshness(member(2 * DAY, 10 * DAY), now), { kind: 'account', text: 'their Discord account is 2 days old', wait: 'until the account is 7 days old' });
    assert.deepEqual(freshness(member(90 * DAY, 3 * HOUR), now), { kind: 'member', text: 'they joined the server 3 hours ago', wait: 'until they have been in the server for 24 hours' });
    assert.equal(freshness(member(90 * DAY, 3 * DAY), now), null, 'old account, been here a while');
    assert.equal(freshness(member(FRESH_ACCOUNT_DAYS * DAY, 3 * DAY), now), null, 'exactly 7 days is old enough');
    assert.equal(freshness(member(90 * DAY, FRESH_MEMBER_HOURS * HOUR), now), null, 'exactly 24 hours is long enough');
    assert.equal(freshness(member(90 * DAY, null), now), null, 'an unknown join time is not treated as new');
    assert.equal(freshness(member(1000, 1000, true), now), null, 'a bot is never new here; Bot Add handles bots');
    // Both windows can apply at once; waiting out only one of them would leave the guard in place, so both are named.
    assert.deepEqual(freshness(member(2 * DAY, 3 * HOUR), now), { kind: 'both', text: 'their Discord account is 2 days old and they joined the server 3 hours ago', wait: 'until the account is 7 days old and they have been in the server for 24 hours' });
});

interface Options { mode?: 'enforce' | 'observe'; accountMs?: number; joinedMs?: number; bot?: boolean; editable?: boolean; permission?: bigint; managed?: boolean }

function fixture(options: Options = {}) {
    const store = new Store(':memory:');
    authorize(store, 'g');
    const settings = store.settings('g');
    settings.enabled = true;
    settings.mode = options.mode ?? 'enforce';
    store.save(settings);
    const cards: any[] = [];
    const security = new Security(store, { push: (_guild: string, card: any) => { cards.push(card.toJSON()); } } as any);
    const punished: string[] = [];
    security.punish = async (_guild: any, actor: string) => { punished.push(actor); return 'Removed 1 dangerous role(s).'; };
    security.revert = async () => 'Removed the newly granted permissions.';
    const now = Date.now();
    const removed: { ids: string[]; reason: string }[] = [], dms: any[] = [];
    const roles = new Collection<string, any>([['g', { id: 'g', managed: false, editable: false, permissions: { bitfield: 0n } }]]);
    const privileged = { id: 'privileged', managed: options.managed ?? false, editable: options.editable ?? true, permissions: { bitfield: options.permission ?? BigInt(PermissionFlagsBits.Administrator) } };
    roles.set('privileged', privileged);
    const member: any = {
        id: TARGET,
        user: { bot: options.bot ?? false, createdTimestamp: now - (options.accountMs ?? 2 * DAY) },
        joinedTimestamp: now - (options.joinedMs ?? 10 * DAY),
        roles: { cache: new Collection<string, any>([['privileged', privileged]]), remove: async (ids: string[], reason: string) => { removed.push({ ids, reason }); } },
        send: async (message: any) => { dms.push(message.embeds[0].toJSON()); },
    };
    const guild: any = {
        id: 'g', name: 'Test Guild', ownerId: 'owner', client: { user: { id: 'bot' } },
        roles: { cache: roles },
        members: { cache: new Collection<string, any>([[TARGET, member]]), fetch: async (arg: any) => (typeof arg === 'string' ? arg : arg?.user) === TARGET ? member : null },
    };
    const grant = (id = 'e1', by = GRANTER) => ({
        id, executorId: by, targetId: TARGET, action: AuditLogEvent.MemberRoleUpdate, createdTimestamp: Date.now(),
        changes: [{ key: '$add', new: [{ id: 'privileged' }] }],
    }) as any;
    return { store, security, guild, member, cards, punished, removed, dms, grant, privileged };
}

test('a powerful role given to a 2-day-old account is taken back, and the person who gave it is left alone', async () => {
    const f = fixture();
    try {
        await f.security.audit(f.grant(), f.guild);
        assert.deepEqual(f.removed, [{ ids: ['privileged'], reason: 'Ghost Vanguard: new-account guard' }]);
        const card = f.cards.find(c => c.title === 'New account got a powerful role');
        assert.ok(card, 'staff get a card');
        assert.match(card.description, new RegExp(`<@${GRANTER}> gave <@${TARGET}> <@&privileged>\\. It carries Administrator\\.`));
        assert.match(card.description, /Since their Discord account is 2 days old, Vanguard took the role back\./);
        assert.match(card.description, /whitelist them with `\/antinuke whitelist add`, wait until the account is 7 days old, or turn the guard off with `\/antinuke settings`/);
        assert.equal(f.dms.length, 1, 'the new account is told why');
        assert.match(f.dms[0].description, /you were given <@&privileged>, and Vanguard took it back/);
        assert.match(f.dms[0].description, /under 7 days old and from members who joined less than 24 hours ago\. This is automatic\./);
    } finally { f.store.close(); }
});

test('the server owner and a whitelisted admin are not exempt as the giver: a taken-over account is the case this exists for', async () => {
    for (const giver of ['owner', GRANTER]) {
        const f = fixture();
        try {
            if (giver === GRANTER) f.store.grant('g', GRANTER, 'trust', 'owner');
            await f.security.audit(f.grant('e-' + giver, giver), f.guild);
            assert.equal(f.removed.length, 1, `${giver} cannot hand a powerful role to a new account`);
            assert.deepEqual(f.punished, [], 'the giver is never punished by the guard');
            assert.equal(f.store.get("SELECT COUNT(*) AS n FROM incidents WHERE mode='enforce'")!.n, 0);
        } finally { f.store.close(); }
    }
});

test('when the account is young and they only just joined, the card names both things to wait for', async () => {
    const f = fixture({ accountMs: 6 * DAY + 22 * HOUR, joinedMs: 2 * HOUR });
    try {
        await f.security.audit(f.grant('both', 'owner'), f.guild);
        const card = f.cards.find(c => c.title === 'New account got a powerful role');
        assert.match(card.description, /Since their Discord account is 6 days old and they joined the server 2 hours ago, Vanguard took the role back\./);
        assert.match(card.description, /wait until the account is 7 days old and they have been in the server for 24 hours,/);
    } finally { f.store.close(); }
});

test('a member who joined 3 hours ago on an old account is held back too, and the card says why', async () => {
    const f = fixture({ accountMs: 400 * DAY, joinedMs: 3 * HOUR });
    try {
        await f.security.audit(f.grant(), f.guild);
        assert.equal(f.removed.length, 1);
        assert.match(f.cards.find(c => c.title === 'New account got a powerful role').description, /Since they joined the server 3 hours ago, Vanguard took the role back\..*wait until they have been in the server for 24 hours/s);
    } finally { f.store.close(); }
});

test('an established member keeps the role', async () => {
    const f = fixture({ accountMs: 400 * DAY, joinedMs: 30 * DAY });
    try {
        await f.security.audit(f.grant('owner-gives', 'owner'), f.guild);
        assert.deepEqual(f.removed, []);
        assert.equal(f.cards.filter(c => c.title === 'New account got a powerful role').length, 0);
    } finally { f.store.close(); }
});

test('a new account that is on the whitelist, the owner, or a bot is left alone', async () => {
    const whitelisted = fixture();
    try {
        whitelisted.store.grant('g', TARGET, 'trust', 'owner');
        await whitelisted.security.audit(whitelisted.grant('w', 'owner'), whitelisted.guild);
        assert.deepEqual(whitelisted.removed, [], 'whitelisting the person is how staff allow it');
    } finally { whitelisted.store.close(); }
    const bot = fixture({ bot: true });
    try {
        await bot.security.audit(bot.grant('b', 'owner'), bot.guild);
        assert.deepEqual(bot.removed, [], 'bots are the Bot Add rule\'s business');
    } finally { bot.store.close(); }
    const owner = fixture();
    try {
        (owner.guild as any).ownerId = TARGET;
        await owner.security.audit(owner.grant('o', GRANTER), owner.guild);
        assert.deepEqual(owner.removed, [], 'the owner is never held back');
    } finally { owner.store.close(); }
});

test('a role that is the whitelist entry cannot clear the person it was just given to', async () => {
    const f = fixture();
    try {
        f.store.grant('g', 'privileged', 'trust_role', 'owner');
        await f.security.audit(f.grant('self-trust', 'owner'), f.guild);
        assert.equal(f.removed.length, 1, 'the new role is ignored when asking whether they are already whitelisted');
        // Another whitelisted role they already held still counts.
        const g = fixture();
        try {
            g.store.grant('g', 'old', 'trust_role', 'owner');
            g.member.roles.cache.set('old', { id: 'old' });
            await g.security.audit(g.grant('held', 'owner'), g.guild);
            assert.deepEqual(g.removed, []);
        } finally { g.store.close(); }
    } finally { f.store.close(); }
});

test('roles that carry nothing powerful are not touched', async () => {
    const f = fixture({ permission: BigInt(PermissionFlagsBits.SendMessages) });
    try {
        await f.security.audit(f.grant('plain', 'owner'), f.guild);
        assert.deepEqual(f.removed, []);
        assert.equal(f.cards.length, 0);
    } finally { f.store.close(); }
});

test('turning the guard off in /antinuke settings stops it', async () => {
    const f = fixture();
    try {
        setFeature(f.store, 'g', 'antinukeplus', PLUS_DEFAULTS, { freshGuard: false });
        await f.security.audit(f.grant('off', 'owner'), f.guild);
        assert.deepEqual(f.removed, []);
        // A server saved before the switch existed has no value at all and counts as on.
        f.store.run("UPDATE guild_features SET json=? WHERE guild_id='g' AND key='antinukeplus'", JSON.stringify({ raidAuto: true }));
        await f.security.audit(f.grant('legacy', 'owner'), f.guild);
        assert.equal(f.removed.length, 1);
    } finally { f.store.close(); }
});

test('in observe mode the guard reports what it would have done and removes nothing', async () => {
    const f = fixture({ mode: 'observe' });
    try {
        await f.security.audit(f.grant('observe', 'owner'), f.guild);
        assert.deepEqual(f.removed, []);
        assert.deepEqual(f.dms, []);
        const card = f.cards.find(c => /New-account guard/.test(c.title));
        assert.match(card.title, /observe mode/);
        assert.match(card.description, /Vanguard would have taken the role back\.\nObserved only: nothing was removed\./);
    } finally { f.store.close(); }
});

test('with anti-nuke off for the server the guard stays out of it', async () => {
    const f = fixture();
    try {
        const settings = f.store.settings('g'); settings.enabled = false; f.store.save(settings);
        await f.security.audit(f.grant('disabled', 'owner'), f.guild);
        assert.deepEqual(f.removed, []);
    } finally { f.store.close(); }
});

test('a role Vanguard cannot manage is reported as a failure, with no DM to the new account', async () => {
    const f = fixture({ editable: false });
    try {
        await f.security.audit(f.grant('high', 'owner'), f.guild);
        assert.deepEqual(f.removed, []);
        const card = f.cards.find(c => c.title === 'New account got a powerful role');
        assert.match(card.description, /Vanguard could not take the role back\. Move its role above that role and check that it has Manage Roles\./);
        assert.deepEqual(f.dms, []);
    } finally { f.store.close(); }
});

test('a role change someone approved through /role is not second-guessed', async () => {
    const f = fixture();
    try {
        approveRoleChange('g', TARGET, 'privileged', 'add');
        await f.security.audit({ ...f.grant('approved', 'bot'), reason: `${GRANTER}: promoted` }, f.guild);
        assert.deepEqual(f.removed, []);
    } finally { f.store.close(); }
});

test('someone who is not in the server any more cannot be given anything and nothing breaks', async () => {
    const f = fixture();
    try {
        (f.guild.members as any).fetch = async () => { throw Object.assign(new Error('Unknown Member'), { code: 10007 }); };
        f.guild.members.cache.clear();
        await f.security.audit(f.grant('gone', 'owner'), f.guild);
        assert.deepEqual(f.removed, []);
    } finally { f.store.close(); }
});

test('a failure inside the guard never stops the anti-nuke rules from running', async () => {
    const f = fixture();
    try {
        f.member.roles.remove = async () => { throw new Error('Missing Permissions'); };
        // A non-whitelisted giver still reaches the Permission Grant rule after the guard failed to remove the role.
        await f.security.audit(f.grant('rules-still-run', GRANTER), f.guild);
        assert.equal(f.store.get("SELECT COUNT(*) AS n FROM incidents WHERE rule='dangerous_grant'")!.n, 1);
        const card = f.cards.find(c => c.title === 'New account got a powerful role');
        assert.match(card.description, /could not take the role back/);
    } finally { f.store.close(); }
});

test('when the member lookup fails for a reason other than having left, the failure is logged and the anti-nuke rules still run', async () => {
    const f = fixture();
    const original = console.log, level = config.logLevel, format = config.logFormat, lines: string[] = [];
    try {
        config.logLevel = 'info';
        config.logFormat = 'json';
        console.log = (line: unknown) => { lines.push(String(line)); };
        // Discord is unavailable: the lookup fails with no "unknown member" code.
        f.guild.members.fetch = async () => { throw new Error('Service Unavailable'); };
        await f.security.audit(f.grant('outage', GRANTER), f.guild);
    } finally {
        console.log = original; config.logLevel = level; config.logFormat = format;
    }
    try {
        const events = lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
        const failure = events.find(e => e.event === 'fresh_guard_failure');
        assert.ok(failure, `a failed guard says so in the log: ${lines.join(' | ')}`);
        assert.equal(failure.guildId, 'g');
        assert.deepEqual(f.removed, [], 'nothing could be removed without the member');
        assert.equal(f.store.get("SELECT COUNT(*) AS n FROM incidents WHERE rule='dangerous_grant'")!.n, 1, 'the Permission Grant rule still ran');
    } finally { f.store.close(); }
});
