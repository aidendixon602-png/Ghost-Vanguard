import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { inviteUrl, printStartupInvite } from '../src/bot/invite.js';
import { REQUIRED_PERMISSIONS } from '../src/ui/ui.js';
import { config } from '../src/config.js';
import { Guard } from '../src/bot/guard.js';
import { Store } from '../src/database/db.js';
import { defaults } from '../src/bot/registry.js';

const app = '999999999999999999', guild = '123456789012345678';

test('invite requests a guild installation with bot and command scopes and required permissions', () => {
    const url = new URL(inviteUrl(app));
    assert.equal(url.origin, 'https://discord.com');
    assert.equal(url.pathname, '/oauth2/authorize');
    assert.equal(url.searchParams.get('client_id'), app);
    assert.equal(url.searchParams.get('scope'), 'bot applications.commands');
    assert.equal(url.searchParams.get('integration_type'), '0');
    assert.equal(url.searchParams.has('guild_id'), false);
    const permissions = new PermissionsBitField(BigInt(url.searchParams.get('permissions')!));
    assert.equal(permissions.has(REQUIRED_PERMISSIONS), true);
    assert.equal(permissions.has(PermissionFlagsBits.ViewAuditLog), true);
    assert.equal(permissions.has(PermissionFlagsBits.Administrator), false);
});

test('server-specific recovery link selects the affected guild and rejects invalid app IDs', () => {
    const url = new URL(inviteUrl(app, guild));
    assert.equal(url.searchParams.get('guild_id'), guild);
    assert.equal(url.searchParams.get('disable_guild_select'), 'true');
    assert.throws(() => inviteUrl(''), /DISCORD_CLIENT_ID/);
    assert.equal(new URL(inviteUrl(app, 'bad')).searchParams.has('guild_id'), false);
});

test('startup prints a usable invite and zero-server guidance without exposing configured secrets', () => {
    const original = console.log, lines: string[] = [];
    console.log = (...args) => lines.push(args.join(' '));
    try {
        printStartupInvite(0, app);
    } finally {
        console.log = original;
    }
    assert.ok(lines.some(line => line.includes('0 servers')));
    assert.ok(lines.some(line => line.trim() === inviteUrl(app)), 'the invite link is on its own line so it is easy to copy');
    assert.ok(lines.some(line => line.includes('DEVELOPER_IDS')));
    assert.ok(!lines.join('\n').includes('DISCORD_TOKEN'));
});

test('uncached server interactions return a targeted recovery link and never authorize', async () => {
    const previous = config.clientId;
    config.clientId = app;
    const store = new Store(':memory:');
    try {
        await assert.rejects(new Guard(store).check({ guildId: guild, inCachedGuild: () => false } as any, defaults, 'authserver'), error => {
            assert.ok(error instanceof Error);
            assert.ok(error.message.includes('not connected'));
            assert.ok(error.message.includes(inviteUrl(app, guild)));
            return true;
        });
        assert.equal(store.isAuthorized(guild), false);
    } finally {
        config.clientId = previous;
        store.close();
    }
});
