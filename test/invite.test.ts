import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { Store } from '../src/database/db.js';
import { generateServerSpecificInvite, serverScopedInviteLink } from '../src/bot/invite.js';

test('invite requests a guild installation with bot and command scopes and required permissions', () => {
    const link = serverScopedInviteLink('123456789012345678');
    assert.match(link, /oauth2\/authorize/);
    assert.match(link, /client_id=123456789012345678/);
    assert.match(link, /scope=bot%20applications\.commands/);
    assert.match(link, /permissions=8/);
    assert.match(link, /integration_type=0/);
});

test('server-specific recovery link selects the affected guild and rejects invalid app IDs', () => {
    assert.match(generateServerSpecificInvite('123456789012345678', '987654321098765432'), /guild_id=987654321098765432/);
    assert.match(generateServerSpecificInvite('123456789012345678', '987654321098765432'), /disable_guild_select=true/);
    assert.equal(generateServerSpecificInvite('not-an-id', '987654321098765432'), null);
    assert.equal(generateServerSpecificInvite('123456789012345678', 'bad-guild'), null);
});

test('startup prints a usable invite and zero-server guidance without exposing configured secrets', async () => {
    const { startupGuidance } = await import('../src/bot/invite.js');
    const lines = startupGuidance('123456789012345678');
    assert.ok(lines.some(line => line.includes('oauth2/authorize')));
    assert.ok(lines.some(line => line.includes('Use this link')));
});

test('uncached server interactions return a targeted recovery link and never authorize', async () => {
    const store = new Store(':memory:');
    const { Router } = await import('../src/bot/router.js');
    const router = new Router(store as any, {} as any, {} as any, {} as any);
    const previous = config.clientId;
    config.clientId = '123456789012345678';
    try {
        const guild = '999999999999999999';
        let sent: any = null;
        await router.handle({
            guildId: guild,
            guild: null,
            user: { id: '111111111111111111' },
            isChatInputCommand: () => true,
            commandName: 'ping',
            reply: async (payload: any) => { sent = payload; },
        } as any);
        assert.ok(sent);
        assert.match(sent.content, /guild_id=999999999999999999/);
        assert.equal(store.isAuthorized(guild), false);
    } finally {
        config.clientId = previous;
        store.close();
    }
});

test('console: roles-above-bot warnings are grouped under one heading and backups are one short line', async () => {
    const { logEvent } = await import('../src/errors.js');
    const original = console.log, lines: string[] = [];
    console.log = (...args) => lines.push(args.join(' '));
    try {
        logEvent('protection_warning', { server: 'Cafe', rolesAboveBot: ['Owner', 'admin'] });
        logEvent('protection_warning', { server: 'Bank', rolesAboveBot: ['Founder'], missingPermissions: ['ManageWebhooks'] });
        logEvent('protection_warning', { server: 'Exempt', bypassedRolesAboveBot: ['Senior Staff'] });
        logEvent('database_backup_verified', { id: '762646f5-0a94-446b-9cb3-752ee410bb33', kind: 'startup', size: 1153433 });
    } finally { console.log = original; }
    const text = lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    assert.equal((text.match(/Roles above the bot/g) ?? []).length, 1, 'one heading for all servers');
    assert.match(text, /Cafe.*Owner, admin/);
    assert.match(text, /Bank.*Founder.*ManageWebhooks/);
    assert.match(text, /Exempt.*bypassed\/exempt: Senior Staff/);
    assert.match(text, /Database backup saved.*startup.*1\.1 MB/);
    assert.doesNotMatch(text, /762646f5/, 'no backup UUID noise');
});