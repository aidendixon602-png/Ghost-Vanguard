import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, Collection, PermissionFlagsBits } from 'discord.js';
import { Store } from '../src/database/db.js';
import { Security } from '../src/security/security.js';
import { isTrustedBot, TRUSTED_BOTS } from '../src/bot/trusted-bots.js';
import { quarantineNewBot } from '../src/features/antinuke-plus.js';
import { reportWebhook } from '../src/features/webhooks.js';
import { authorize } from './helpers.js';

const VEIL = '1563480035493417021';
const STRANGER = '222222222222222222';

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

test('Veil Utilities is a built-in trusted bot', () => {
    assert.equal(TRUSTED_BOTS.get(VEIL), 'Veil Utilities');
    assert.ok(isTrustedBot(VEIL));
    assert.ok(!isTrustedBot(STRANGER) && !isTrustedBot(null) && !isTrustedBot(undefined));
});

test('anti-nuke trusts Veil Utilities in every server and leaves its actions alone', async () => {
    const f = fixture();
    try {
        assert.ok(f.security.trusted(f.guild, VEIL));
        assert.equal(f.security.exemptReason(f.guild, VEIL), 'a trusted bot (Veil Utilities)');
        await f.security.audit(grant('veil', VEIL), f.guild);
        assert.deepEqual(f.calls, { punished: 0, reverted: 0 }, 'nothing Veil does is reverted or punished');
        assert.equal(f.store.get('SELECT COUNT(*) AS n FROM incidents')!.n, 0, 'and it is not even recorded as an incident');
        await f.security.audit(grant('stranger', STRANGER), f.guild);
        assert.equal(f.calls.reverted, 1, 'anyone else is still handled as before');
    } finally { f.store.close(); }
});

test('Veil Utilities is not held for approval when it joins', async () => {
    const f = fixture();
    try {
        let touched = false;
        const member: any = {
            id: VEIL, user: { bot: true }, guild: f.guild,
            get roles() { touched = true; return { botRole: null }; },
        };
        await quarantineNewBot(f.store, { push: () => undefined } as any, member);
        assert.equal(touched, false, 'returns before looking at its role');
    } finally { f.store.close(); }
});

test('a webhook Veil Utilities creates does not raise an alert', () => {
    const pushed: unknown[] = [];
    const entry: any = { action: AuditLogEvent.WebhookCreate, targetId: 'hook', executorId: VEIL, target: { name: 'Veil' } };
    reportWebhook({} as any, { push: (...a: unknown[]) => pushed.push(a) } as any, entry, { id: 'g', client: { user: { id: 'bot' } } } as any);
    assert.equal(pushed.length, 0);
});
