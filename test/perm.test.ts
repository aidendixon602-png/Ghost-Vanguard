import test from 'node:test';
import assert from 'node:assert/strict';
import { authorize } from './helpers.js';
import { Store } from '../src/database/db.js';
import { Colors, PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import { discordPermPage, permPage } from '../src/ui/perm-ui.js';

const GUILD = '111111111111111111';
const USER = '444444444444444444';

function fixture(count: number, presentRoles = count) {
    const store = new Store(':memory:');
    authorize(store, GUILD);
    const roles = new Map<string, { position: number }>();
    store.readGuild(GUILD, () => {
        for (let n = 0; n < count; n++) {
            const roleId = String(900000000000000000n + BigInt(n));
            store.run('INSERT INTO permission_roles VALUES(?,?,?,?)', GUILD, roleId, n % 2 ? 'moderator' : 'admin', USER);
            if (n < presentRoles)
                roles.set(roleId, { position: count - n });
        }
    });
    const ctx: any = { store, client: { guilds: { cache: new Map([[GUILD, { roles: { cache: roles } }]]) } } };
    return { store, ctx };
}

const body = (page: any) => String(page.embeds[0].data.description);

test('the listing pages ten roles at a time and reports the total', () => {
    const f = fixture(13);
    const first = f.store.readGuild(GUILD, () => permPage(f.ctx, GUILD, USER, 1));
    assert.match(body(first), /page 1\/2 · 13 assigned roles/);
    assert.equal((body(first).match(/Granted by/g) ?? []).length, 10);
    const second = f.store.readGuild(GUILD, () => permPage(f.ctx, GUILD, USER, 2));
    assert.match(body(second), /page 2\/2 · 13 assigned roles/);
    assert.equal((body(second).match(/Granted by/g) ?? []).length, 3);
    f.store.close();
});

test('the buttons are disabled at each end and carry the requesting user', () => {
    const f = fixture(13);
    const first: any = f.store.readGuild(GUILD, () => permPage(f.ctx, GUILD, USER, 1));
    const last: any = f.store.readGuild(GUILD, () => permPage(f.ctx, GUILD, USER, 2));
    assert.equal(first.components[0].components[0].data.disabled, true, 'Prev is disabled on page one');
    assert.equal(first.components[0].components[1].data.disabled, false);
    assert.equal(last.components[0].components[1].data.disabled, true, 'Next is disabled on the last page');
    assert.ok(first.components[0].components[1].data.custom_id.startsWith(`perm:${USER}:`));
    f.store.close();
});

test('a page beyond the end clamps instead of showing an empty list', () => {
    const f = fixture(3);
    const page = f.store.readGuild(GUILD, () => permPage(f.ctx, GUILD, USER, 99));
    assert.match(body(page), /page 1\/1 · 3 assigned roles/);
    f.store.close();
});

test('roles deleted from the server are listed and counted', () => {
    const f = fixture(4, 2);
    const page = f.store.readGuild(GUILD, () => permPage(f.ctx, GUILD, USER, 1));
    assert.match(body(page), /role deleted/);
    assert.match(body(page), /· 2 deleted/);
    f.store.close();
});

test('an empty guild renders no buttons and points at the setup command', () => {
    const f = fixture(0);
    const page: any = f.store.readGuild(GUILD, () => permPage(f.ctx, GUILD, USER, 1));
    assert.equal(page.components.length, 0);
    assert.match(body(page), /setup config permission-role/);
    f.store.close();
});

test('role mentions are rendered but never pinged', () => {
    const f = fixture(2);
    const page: any = f.store.readGuild(GUILD, () => permPage(f.ctx, GUILD, USER, 1));
    assert.match(body(page), /<@&9000000000000000\d{2}>/);
    assert.deepEqual(page.allowedMentions, { parse: [] });
    f.store.close();
});

function guildWith(roles: { id: string; name: string; position: number; admin?: boolean; manage?: boolean; members?: number; managed?: boolean }[], botPosition = 100) {
    const cache = new Map(roles.map(r => [r.id, {
        id: r.id, name: r.name, position: r.position, managed: !!r.managed,
        members: { size: r.members ?? 0 },
        permissions: new PermissionsBitField(
            (r.admin ? PermissionFlagsBits.Administrator : 0n) | (r.manage ? PermissionFlagsBits.ManageRoles : 0n)),
    }]));
    return { roles: { cache }, members: { me: { roles: { highest: { position: botPosition } } } } };
}

test('only roles that can move the hierarchy are listed, highest first', () => {
    const store = new Store(':memory:');
    const ctx: any = { store, client: { guilds: { cache: new Map([[GUILD, guildWith([
        { id: '1', name: 'Owner', position: 90, admin: true, members: 2 },
        { id: '2', name: 'Staff', position: 50, manage: true, members: 7 },
        { id: '3', name: 'Member', position: 10 },
    ])]]) } } };
    const body = String(discordPermPage(ctx, GUILD, USER, 1).embeds[0].data.description);
    assert.match(body, /· 2 roles/);
    assert.ok(body.indexOf('<@&1>') < body.indexOf('<@&2>'), 'higher roles come first');
    assert.doesNotMatch(body, /<@&3>/, 'roles without either permission are omitted');
    assert.match(body, /Administrator/);
    assert.match(body, /Manage Roles/);
    store.close();
});

test('roles above the bot are flagged, because the bot cannot revert them', () => {
    const store = new Store(':memory:');
    const ctx: any = { store, client: { guilds: { cache: new Map([[GUILD, guildWith([
        { id: '1', name: 'Above', position: 200, admin: true },
        { id: '2', name: 'Below', position: 20, manage: true },
    ], 100)]]) } } };
    const page: any = discordPermPage(ctx, GUILD, USER, 1);
    const body = String(page.embeds[0].data.description);
    assert.match(body, /above the bot/);
    assert.match(body, /1 of these sit above the bot/);
    assert.equal(page.embeds[0].data.color, Colors.Orange, 'the warning colour is used');
    store.close();
});
