import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, Collection, PermissionFlagsBits } from 'discord.js';
import { Store } from '../src/database/db.js';
import { Security } from '../src/security/security.js';
import { isTrustedBot, parseTrustedBots, trustedBotName, trustedBotReport } from '../src/bot/trusted-bots.js';
import { quarantineNewBot } from '../src/features/antinuke-plus.js';
import { reportWebhook } from '../src/features/webhooks.js';
import { authorize } from './helpers.js';

const PARTNER = '1563480035493417021';
const STRANGER = '222222222222222222';

/** The list lives in .env, so a test sets it like an operator would. */
function withTrustedBots(raw: string | null) {
    const before = process.env.TRUSTED_BOTS;
    if (raw === null) delete process.env.TRUSTED_BOTS; else process.env.TRUSTED_BOTS = raw;
    return () => { if (before === undefined) delete process.env.TRUSTED_BOTS; else process.env.TRUSTED_BOTS = before; };
}

test('no bot is trusted unless .env lists it: nothing is built in', () => {
    const restore = withTrustedBots(null);
    try {
        assert.ok(!isTrustedBot(PARTNER), 'a bot that is not listed is an ordinary bot');
        assert.ok(!isTrustedBot(STRANGER) && !isTrustedBot(null) && !isTrustedBot(undefined));
        assert.equal(trustedBotName(PARTNER), undefined);
    } finally { restore(); }
});

test('TRUSTED_BOTS takes id:name pairs, separated by commas or semicolons', () => {
    assert.deepEqual([...parseTrustedBots(`${PARTNER}:Veil Utilities; 333333333333333333 = Other Bot`)],
        [[PARTNER, 'Veil Utilities'], ['333333333333333333', 'Other Bot']]);
    assert.deepEqual([...parseTrustedBots(`${PARTNER}`)], [[PARTNER, 'unnamed bot']], 'a bare ID is still trusted');
    assert.deepEqual([...parseTrustedBots('not-an-id:Weird, 123')], [], 'anything that is not a snowflake is ignored');
    assert.equal(parseTrustedBots('').size, 0);
});

function fixture() {
    const store = new Store(':memory:'); authorize(store, 'g');
    const settings = store.settings('g'); settings.enabled = true; settings.mode = 'enforce'; store.save(settings);
    const security = new Security(store, { push: () => undefined } as any);
    const guild: any = {
        id: 'g', name: 'Test Guild', ownerId: 'owner', client: { user: { id: 'bot' } },
        roles: { cache: new Collection<string, any>() },
        members: { cache: new Collection(), fetch: async () => null },
    };
    const calls = { punished: 0, reverted: 0 };
    security.punish = async () => { calls.punished++; return 'punished'; };
    security.revert = async () => { calls.reverted++; return 'reverted'; };
    return { store, security, guild, calls };
}

const grant = (id: string, executorId: string) => ({
    id, executorId, targetId: 'role', action: AuditLogEvent.RoleUpdate, createdTimestamp: Date.now(),
    changes: [{ key: 'permissions', old: '0', new: String(PermissionFlagsBits.BanMembers) }],
}) as any;

test('startup names each trusted account and flags an ID that is not a bot or cannot be fetched', async () => {
    // These IDs are exempt from anti-nuke everywhere, so a stale ID must be visible at startup.
    const fake = (users: Record<string, any>) => ({ users: { fetch: async (id: string) => { if (!(id in users)) throw new Error('Unknown User'); return users[id]; } } }) as any;
    const restore = withTrustedBots(`${PARTNER}:Veil Utilities`);
    try {
        const good = await trustedBotReport(fake({ [PARTNER]: { id: PARTNER, bot: true, username: 'veilutilities' } }));
        assert.equal(good.length, 1);
        assert.match(good[0]!, /Veil Utilities: @veilutilities \(1563480035493417021\)/);

        const notABot = await trustedBotReport(fake({ [PARTNER]: { id: PARTNER, bot: false, username: 'someone' } }));
        assert.match(notABot[0]!, /that account is a user, not a bot/);

        const missing = await trustedBotReport(fake({}));
        assert.match(missing[0]!, /could not be fetched/);
        assert.match(missing[0]!, /TRUSTED_BOTS/);
    } finally { restore(); }
});

test('anti-nuke trusts a listed bot in every server and leaves its actions alone', async () => {
    const restore = withTrustedBots(`${PARTNER}:Veil Utilities`);
    const f = fixture();
    try {
        assert.ok(f.security.trusted(f.guild, PARTNER));
        assert.equal(f.security.exemptReason(f.guild, PARTNER), 'a trusted bot (Veil Utilities)');
        await f.security.audit(grant('partner', PARTNER), f.guild);
        assert.deepEqual(f.calls, { punished: 0, reverted: 0 }, 'nothing a trusted bot does is reverted or punished');
        assert.equal(f.store.get('SELECT COUNT(*) AS n FROM incidents')!.n, 0, 'and it is not even recorded as an incident');
        await f.security.audit(grant('stranger', STRANGER), f.guild);
        assert.equal(f.calls.reverted, 1, 'anyone else is still handled as before');
    } finally { f.store.close(); restore(); }
});

test('a bot that is not listed is watched like anyone else', async () => {
    const restore = withTrustedBots(null);
    const f = fixture();
    try {
        assert.ok(!f.security.trusted(f.guild, PARTNER));
        await f.security.audit(grant('partner', PARTNER), f.guild);
        assert.equal(f.calls.reverted, 1, 'nothing is exempt by default');
    } finally { f.store.close(); restore(); }
});

test('a trusted bot is not held for approval when it joins', async () => {
    const restore = withTrustedBots(`${PARTNER}:Veil Utilities`);
    const f = fixture();
    try {
        let touched = false;
        const member: any = {
            id: PARTNER, user: { bot: true }, guild: f.guild,
            get roles() { touched = true; return { botRole: null }; },
        };
        await quarantineNewBot(f.store, { push: () => undefined } as any, member);
        assert.equal(touched, false, 'returns before looking at its role');
    } finally { f.store.close(); restore(); }
});

test('a webhook a trusted bot creates does not raise an alert', () => {
    const restore = withTrustedBots(`${PARTNER}:Veil Utilities`);
    try {
        const pushed: unknown[] = [];
        const entry: any = { action: AuditLogEvent.WebhookCreate, targetId: 'hook', executorId: PARTNER, target: { name: 'Veil' } };
        reportWebhook({} as any, { push: (...a: unknown[]) => pushed.push(a) } as any, entry, { id: 'g', client: { user: { id: 'bot' } } } as any);
        assert.equal(pushed.length, 0);
    } finally { restore(); }
});
