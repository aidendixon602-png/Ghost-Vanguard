import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { defaults } from '../src/bot/registry.js';
import { Registry } from '../src/bot/registry.js';
import { confirmDanger, registerDangerConfirm, armedCount } from '../src/ui/danger-ui.js';

/**
 * The gate exists so an irreversible developer command cannot fire on one keystroke.
 * These tests pin the properties that matter: nothing runs before the click, the click
 * runs it exactly once, and the prompt cannot be claimed by someone else.
 */

const DEV = '1277709272041394187';
const OTHER = '999999999999999999';
const GUILD = '123456789012345678';
config.developers.add(DEV);
const testContext=()=>({store:{get:()=>undefined,hasGrant:()=>false},policy:{...defaults,developerOnly:true,requiresAuthorization:false}} as any);

function interaction(user = DEV, guildId: string | null = GUILD) {
    const replies: any[] = [];
    const member:any={id:user,guild:{id:guildId,ownerId:DEV},roles:{cache:new Map()},permissions:{has:()=>true}};
    return {inCachedGuild:()=>true, member,guild:{members:{me:{permissions:{has:()=>true}},fetch:async()=>member}}, user: { id: user }, guildId, customId: '', replies, editReply: async (payload: any) => void replies.push(payload) };
}

function handlers() {
    const registry = new Registry();
    registerDangerConfirm(registry);
    const confirm = registry.components.find(c => c.prefix === 'dangerconfirm:')!;
    const cancel = registry.components.find(c => c.prefix === 'dangercancel:')!;
    return { confirm, cancel };
}

const token = (i: any) => String(i.replies[0].components[0].components[0].data.custom_id).slice('dangerconfirm:'.length);

const spec = (ran: string[]) => ({
    title: 'Ban a server', summary: 'Test server', consequences: ['The bot leaves.'],
    label: 'Ban server', reversal: 'Unban re-admits it.',
    run: async () => {
        ran.push('ran');
        return 'banned';
    },
});

test('the prompt warns and arms the action without running it', async () => {
    const ran: string[] = [];
    const i = interaction();
    await confirmDanger(testContext(), i, spec(ran));
    assert.deepEqual(ran, [], 'nothing runs before the confirming click');
    const body = String(i.replies[0].embeds[0].data.description);
    assert.match(body, /Nothing has happened yet/);
    assert.match(body, /Reversal:/);
    assert.match(String(i.replies[0].embeds[0].data.title), /^⚠/);
    assert.equal(i.replies[0].components[0].components[0].data.label, 'Ban server', 'the button names the action, not just "Confirm"');
    assert.equal(i.replies[0].components[0].components[0].data.style, 4, 'the confirm button is danger-styled');
});

test('confirming runs the action exactly once, and a second click is refused', async () => {
    const ran: string[] = [];
    const i = interaction();
    await confirmDanger(testContext(), i, spec(ran));
    const { confirm } = handlers();
    const click: any = interaction();
    click.customId = `dangerconfirm:${token(i)}`;
    await confirm.execute(testContext(), click);
    assert.deepEqual(ran, ['ran']);
    assert.match(String(click.replies[0].embeds[0].data.description), /banned/);
    await assert.rejects(confirm.execute(testContext(), click), /expired or was already used/);
    assert.deepEqual(ran, ['ran'], 'a double click cannot run it twice');
});

test('cancelling runs nothing and disarms the confirmation', async () => {
    const ran: string[] = [];
    const i = interaction();
    await confirmDanger(testContext(), i, spec(ran));
    const { confirm, cancel } = handlers();
    const click: any = interaction();
    click.customId = `dangercancel:${token(i)}`;
    await cancel.execute(testContext(), click);
    assert.deepEqual(ran, []);
    assert.match(String(click.replies[0].embeds[0].data.description), /Nothing was changed/);
    click.customId = `dangerconfirm:${token(i)}`;
    await assert.rejects(confirm.execute(testContext(), click), /expired or was already used/);
});

test('another developer cannot confirm someone else\'s prompt', async () => {
    const ran: string[] = [];
    const i = interaction(DEV);
    await confirmDanger(testContext(), i, spec(ran));
    const { confirm } = handlers();
    const click: any = interaction(OTHER);
    click.customId = `dangerconfirm:${token(i)}`;
    await assert.rejects(confirm.execute(testContext(), click), /belongs to another user/);
    assert.deepEqual(ran, []);
});

test('a confirmation cannot be carried into another server', async () => {
    const ran: string[] = [];
    const i = interaction(DEV, GUILD);
    await confirmDanger(testContext(), i, spec(ran));
    const { confirm } = handlers();
    const click: any = interaction(DEV, '555555555555555555');
    click.customId = `dangerconfirm:${token(i)}`;
    await assert.rejects(confirm.execute(testContext(), click), /different server/);
    assert.deepEqual(ran, []);
});

test('an unknown token is refused rather than ignored', async () => {
    const { confirm } = handlers();
    const click: any = interaction();
    click.customId = 'dangerconfirm:neverissuedatall0000';
    await assert.rejects(confirm.execute(testContext(), click), /expired or was already used/);
});

test('armed confirmations do not accumulate once used', async () => {
    const before = armedCount();
    const i = interaction();
    await confirmDanger(testContext(), i, spec([]));
    assert.equal(armedCount(), before + 1);
    const { cancel } = handlers();
    const click: any = interaction();
    click.customId = `dangercancel:${token(i)}`;
    await cancel.execute(testContext(), click);
    assert.equal(armedCount(), before);
});
