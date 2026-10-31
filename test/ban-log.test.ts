import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogEvent, Collection, PermissionFlagsBits } from 'discord.js';
import { authorize } from './helpers.js';
import { Store } from '../src/database/db.js';
import { LogQueue } from '../src/logging.js';
import { config } from '../src/config.js';
import { caseId, getRecord, handleBanLogInteraction, latestRecord, onBanAdd, onBanRemove, registerBanLogRenderer, renderRecord, timing } from '../src/audit/ban-log.js';
import { setLogChannels } from '../src/audit/log-setup.js';
import { createBan } from '../src/security/network-ban.js';

/**
 * #bans: every ban gets one record (whoever made it), unbans update that record, nothing is
 * guessed, and only the server owner or Developers can use Unban / Reban buttons, with confirmation.
 */

timing.settleMs = 0;
const G = '500000000000000001', BOT = '600000000000000001', STAFF = '223456789012345678', DEV = '1277709272041394187';
const USER = '400000000000000001', MANUAL = '323456789012345678';

function world(o: { auditAccess?: boolean } = {}) {
    const store = new Store(':memory:');
    authorize(store, G);
    const bans = new Map<string, string>();
    const audit: any[] = [];
    const sent: any[] = [], edits: any[] = [], announcements: any[] = [];
    const users = new Collection<string, any>([[BOT, { id: BOT, bot: true }], [MANUAL, { id: MANUAL, bot: false }]]);
    const channel = {
        id: 'bans-channel', isSendable: () => true, isTextBased: () => true,
        send: async (p: any) => { sent.push(p); return { id: `m${sent.length}` }; },
        messages: { edit: async (id: string, p: any) => { edits.push({ id, p }); } },
    };
    const client: any = { user: { id: BOT }, users: { cache: users }, isReady: () => true, channels: { fetch: async () => channel } };
    const guild: any = {
        id: G, ownerId: 'owner', client,
        members: {
            me: { permissions: { has: (bit: bigint) => bit !== PermissionFlagsBits.ViewAuditLog || o.auditAccess !== false } },
            ban: async (id: string, opts: any) => { bans.set(id, opts.reason); audit.unshift({ action: AuditLogEvent.MemberBanAdd, targetId: id, executorId: BOT, reason: opts.reason, createdTimestamp: Date.now() }); },
            unban: async (id: string, reason: string) => { bans.delete(id); audit.unshift({ action: AuditLogEvent.MemberBanRemove, targetId: id, executorId: BOT, reason, createdTimestamp: Date.now() }); },
        },
        bans: {
            fetch: async ({ user }: any) => { if (!bans.has(user)) throw { code: 10026 }; return { reason: bans.get(user) }; },
        },
        fetchAuditLogs: async ({ type }: any) => ({ entries: new Collection(audit.filter(e => e.action === type).map((e, n) => [String(n), e])) }),
    };
    const logs = new LogQueue(store, client);
    logs.canDeliver = () => true;
    registerBanLogRenderer(store, logs);
    store.withAuthorized(G, async () => setLogChannels(store, G, { bansChannelId: 'bans-channel' }));
    const user = { id: USER, tag: 'urloffy', username: 'urloffy', displayAvatarURL: () => 'https://cdn.discordapp.com/avatar.png' } as any;
    /** Something banned or unbanned the user outside Vanguard's buttons: Discord fires the event. */
    const discordBan = async (executorId: string | null, reason: string) => {
        bans.set(USER, reason);
        if (executorId) audit.unshift({ action: AuditLogEvent.MemberBanAdd, targetId: USER, executorId, reason, createdTimestamp: Date.now() });
        return store.withAuthorized(G, () => onBanAdd(store, logs, guild, user, reason));
    };
    const discordUnban = async (executorId: string | null, reason: string | null) => {
        bans.delete(USER);
        if (executorId) audit.unshift({ action: AuditLogEvent.MemberBanRemove, targetId: USER, executorId, reason, createdTimestamp: Date.now() });
        return store.withAuthorized(G, () => onBanRemove(store, logs, guild, user));
    };
    return { store, logs, guild, bans, audit, sent, edits, announcements, user, discordBan, discordUnban };
}

const fieldsOf = (payload: any) => Object.fromEntries(payload.embeds[0].fields.map((f: any) => [f.name, f.value]));
const buttons = (payload: any) => payload.components[0].components.map((b: any) => ({ label: b.label, disabled: !!b.disabled, style: b.style }));

test('a ban made with a Vanguard command is recorded once with the staff member, evidence and buttons', async () => {
    const w = world();
    try {
        await w.store.withAuthorized(G, async () => w.store.recordCase(G, USER, STAFF, 'ban', 'faking payments for free roles', { username: 'urloffy', evidence: 'https://imgur.com/proof' }));
        const record = await w.discordBan(BOT, `${STAFF}: faking payments for free roles`);
        assert.match(caseId(record!), /^BAN-\d{4}$/);
        assert.equal(await w.discordBan(BOT, `${STAFF}: faking payments for free roles`), null, 'a duplicate ban event does not create a second record');
        await w.logs.flush();
        assert.equal(w.sent.length, 1, 'posted to #bans exactly once');
        const posted = w.sent[0];
        assert.equal(posted.embeds[0].author.name, '• urloffy - Banned');
        assert.equal(posted.embeds[0].author.icon_url, 'https://cdn.discordapp.com/avatar.png');
        const f = fieldsOf(posted);
        assert.equal(f.User, `<@${USER}>\n( ${USER} )`);
        assert.equal(f['Moderator (via bot)'], `<@${STAFF}> ( ${STAFF} )`);
        assert.equal(f.Reason, 'faking payments for free roles');
        assert.equal(f.Evidence, 'https://imgur.com/proof');
        assert.equal(f.Duration, 'Permanent');
        assert.match(posted.embeds[0].footer.text, new RegExp(`User ID: ${USER}`));
        assert.deepEqual(buttons(posted), [{ label: 'Unban', disabled: false, style: 3 }, { label: 'Reban', disabled: true, style: 4 }], 'Unban only while banned; Reban is red');
        assert.equal(posted.nonce, `mv1`, 'each post carries a nonce so a retry cannot double-post');
        assert.equal(getRecord(w.store, G, record!.id)!.message_id, 'm1', 'the message is remembered for later updates');
    } finally { w.store.close(); }
});

test('a ban done directly in Discord is credited to the verified person; with no audit access it says unavailable', async () => {
    const w = world();
    try {
        await w.discordBan(MANUAL, 'alt account');
        const f = fieldsOf(renderRecord(latestRecord(w.store, G, USER)!));
        assert.equal(f['Banned By'], `<@${MANUAL}> ( ${MANUAL} )`);
        assert.equal(f.Reason, 'alt account');
    } finally { w.store.close(); }
    const blind = world({ auditAccess: false });
    try {
        await blind.discordBan(MANUAL, 'alt account');
        const f = fieldsOf(renderRecord(latestRecord(blind.store, G, USER)!));
        assert.equal(f['Banned By'], 'Unavailable (could not be verified)', 'never guesses who did it');
        assert.equal(f.Reason, 'alt account', 'the reason still comes from Discord’s ban entry');
    } finally { blind.store.close(); }
});

test('tempbans show duration and expiry; when they expire the same record is updated, not duplicated', async () => {
    const w = world();
    try {
        const until = Date.now() + 86400000;
        await w.store.withAuthorized(G, async () => {
            w.store.run('INSERT INTO tempbans VALUES(?,?,?,?,?,?)', G, USER, until, STAFF, 'spam', 1);
        });
        await w.discordBan(BOT, `${STAFF}: tempban 1 day: spam`);
        let f = fieldsOf(renderRecord(latestRecord(w.store, G, USER)!));
        assert.equal(f.Duration, '1 day');
        assert.equal(f.Type, 'Temporary ban');
        assert.match(f.Expires, new RegExp(`<t:${Math.floor(until / 1000)}:f>`));
        assert.equal(f.Reason, 'spam');
        await w.logs.flush();
        await w.discordUnban(BOT, 'Midtown Vanguard: temporary ban expired (case #1)')  // old name: still recognized;
        const record = latestRecord(w.store, G, USER)!;
        assert.equal(record.status, 'expired');
        assert.equal(w.store.get('SELECT COUNT(*) AS n FROM ban_records')!.n, 1);
        await w.logs.flush();
        assert.equal(w.sent.length, 1, 'no second post');
        assert.equal(w.edits.length, 1, 'the original message was edited');
        f = fieldsOf(w.edits[0].p);
        assert.match(f.Status, /Expired by Ghost Vanguard \(automatic\)/);
        assert.equal(f.Reason, 'spam', 'the original ban details are kept');
        assert.equal(w.edits[0].p.embeds[0].author.name, '• urloffy - Ban expired');
    } finally { w.store.close(); }
});

test('genrebans and hardbans show the developer approval and evidence', async () => {
    const w = world();
    try {
        const ban = createBan(w.store, { kind: 'genreban', user: { id: USER, tag: 'urloffy' } as any, reason: 'scamming', evidence: 'ticket 42', moderator: { id: DEV, tag: 'dev' } as any });
        await w.discordBan(BOT, `[Vanguard genreban] GB-0000${ban.id} ${DEV}: scamming`);
        const f = fieldsOf(renderRecord(latestRecord(w.store, G, USER)!));
        assert.equal(f.Type, 'Genreban');
        assert.equal(f.Evidence, 'ticket 42');
        assert.match(f['Approved by'], new RegExp(`<@${DEV}> \\(developer\\) · GB-0000${ban.id}`));
        assert.equal(f['Moderator (via bot)'], `<@${DEV}> ( ${DEV} )`);
    } finally { w.store.close(); }
});

test('an unban of a ban that predates the ban log is still recorded, with the unknown parts marked unavailable', async () => {
    const w = world();
    try {
        w.bans.set(USER, 'old');
        await w.discordUnban(MANUAL, 'appeal accepted');
        const f = fieldsOf(renderRecord(latestRecord(w.store, G, USER)!));
        assert.equal(f['Banned By'], 'Unavailable (banned before ban logging started)');
        assert.match(f.Status, new RegExp(`^Unbanned by <@${MANUAL}>`));
        assert.match(f.Status, /appeal accepted/);
    } finally { w.store.close(); }
});

// ------------------------------------------------------------ buttons

function click(w: ReturnType<typeof world>, customId: string, userId: string, extra: any = {}) {
    const replies: any[] = [];
    const i: any = {
        customId, user: { id: userId }, guildId: G, guild: w.guild, channel: { isSendable: () => true, send: async (payload: any) => { w.announcements.push(payload); return { id: `announcement-${w.announcements.length}` }; } }, replied: false, deferred: false,
        isButton: () => !extra.modal, isModalSubmit: () => !!extra.modal,
        reply: async (p: any) => { replies.push({ kind: 'reply', ...p }); i.replied = true; },
        followUp: async (p: any) => replies.push({ kind: 'followUp', ...p }),
        update: async (p: any) => replies.push({ kind: 'update', ...p }),
        showModal: async (m: any) => replies.push({ kind: 'modal', modal: m.toJSON() }),
        fields: { getTextInputValue: () => extra.reason ?? '' },
        message: { embeds: extra.embeds ?? [] },
    };
    return { i, replies };
}
const run = (w: ReturnType<typeof world>, c: { i: any }) => handleBanLogInteraction(c.i, { store: w.store, logs: w.logs, assertLocalUnban: async () => undefined });

test('even Admins cannot press Unban or Reban; the owner or a Developer is required on every click', async () => {
    const w = world();
    try {
        const record = (await w.discordBan(MANUAL, 'raid'))!;
        w.store.grant(G, STAFF, 'admin', 'owner');
        for (const id of [`banrec:unban:${record.id}`, `banrec:cunban:${record.id}`, `banrec:reban:${record.id}`, `banrec:creban:${record.id}`]) {
            const c = click(w, id, STAFF);
            await run(w, c);
            assert.match(c.replies[0].content, /Only the server owner and Ghost Vanguard developers/);
        }
        assert.ok(w.bans.has(USER), 'nothing changed');
    } finally { w.store.close(); }
});

test('the server owner can use local ban-log buttons, but cannot lift a network ban', async () => {
    const w = world();
    try {
        const record = (await w.discordBan(MANUAL, 'raid'))!;
        w.store.grant(G, STAFF, 'admin', 'owner');
        const admin = click(w, `banrec:unban:${record.id}`, STAFF);
        await run(w, admin);
        assert.match(admin.replies[0].content, /Only the server owner and Ghost Vanguard developers/);
        assert.ok(w.bans.has(USER), 'an Admin cannot use the log button');

        const ask = click(w, `banrec:unban:${record.id}`, 'owner');
        await run(w, ask);
        assert.equal(ask.replies[0].embeds[0].data.title, '🔓 Unban urloffy?');
        const rapidRepeat = click(w, `banrec:unban:${record.id}`, 'owner');
        await run(w, rapidRepeat);
        assert.match(rapidRepeat.replies[0].content, /wait half a second/);
        const ok = click(w, `banrec:cunban:${record.id}`, 'owner');
        await run(w, ok);
        assert.equal(ok.replies[0].embeds[0].data.title, '✅ urloffy unbanned');
        assert.ok(!w.bans.has(USER));
        assert.equal(w.announcements.length, 1, 'successful actions send one public audit note');
        assert.match(w.announcements[0].content, new RegExp(`<@owner> used the ban-log \\*\\*Unban\\*\\* button for <@${USER}>`));
        assert.deepEqual(w.announcements[0].allowedMentions, { parse: [] }, 'the audit note does not ping users');

        const again = (await w.discordBan(MANUAL, 'raid again'))!;
        for (const kind of ['genreban', 'hardban'] as const) {
            const deps = { store: w.store, logs: w.logs, assertLocalUnban: async () => undefined,
                network: { active: () => ({ kind, record: 'X-1' }), lift: async () => { throw new Error('must not lift'); } } };
            for (const id of [`banrec:unban:${again.id}`, `banrec:cunban:${again.id}`]) {
                const c = click(w, id, 'owner');
                await handleBanLogInteraction(c.i, deps as any);
                assert.match(c.replies[0].content, new RegExp(`Midtown-wide \\*\\*${kind}\\*\\*: only a Developer`));
            }
            assert.ok(w.bans.has(USER), `${kind}: the server owner cannot lift a network ban`);
            if (kind === 'genreban') await new Promise(resolve => setTimeout(resolve, 510)); // let the action cooldown expire before the hardban check
        }

        await w.discordUnban(MANUAL, 'reban button access check');
        const reban = click(w, `banrec:reban:${again.id}`, 'owner');
        await run(w, reban);
        assert.equal(reban.replies[0].kind, 'modal', 'the server owner can open the Reban form');
    } finally { w.store.close(); }
});

test('only a Developer can lift either network-ban type from its record', async () => {
    const w = world();
    const JUNIOR = '823456789012345678';
    config.supremeExtra.add(JUNIOR);
    config.developers.add(DEV);
    try {
        const record = (await w.discordBan(MANUAL, 'raid'))!;
        const lifted: string[] = [];
        const deps = (kind: 'genreban' | 'hardban') => ({ store: w.store, logs: w.logs, assertLocalUnban: async () => undefined,
            network: { active: () => ({ kind, record: 'X-00005' }), lift: async (u: string) => { lifted.push(kind); w.bans.delete(u); return { lifted: 1, failed: 0, servers: 1 }; } } });
        for (const kind of ['genreban', 'hardban'] as const) {
            const before = lifted.length;
            const blocked = click(w, `banrec:cunban:${record.id}`, JUNIOR);
            await handleBanLogInteraction(blocked.i, deps(kind) as any);
            assert.match(blocked.replies[0].content, /Only the server owner and Ghost Vanguard developers/);
            assert.equal(lifted.length, before, `${kind}: Supreme Leader is refused`);
            assert.ok(w.bans.has(USER));

            const allowed = click(w, `banrec:cunban:${record.id}`, DEV);
            allowed.i.editReply = async (p: any) => allowed.replies.push(p);
            await handleBanLogInteraction(allowed.i, deps(kind) as any);
            assert.deepEqual(lifted.slice(before), [kind], `${kind}: Developer can lift it`);
            assert.match(w.announcements.at(-1).content, new RegExp(`<@${DEV}> lifted the \\*\\*${kind}\\*\\*`), `${kind}: public note shows who pressed`);
            w.bans.set(USER, 'raid'); // restore Discord's fake ban before checking the next kind
        }
    } finally { config.supremeExtra.delete(JUNIOR); config.developers.delete(DEV); w.store.close(); }
});

test('Unban asks to confirm, re-checks the real ban, then updates the original record with who and when', async () => {
    const w = world();
    config.developers.add(DEV);
    try {
        const record = (await w.discordBan(MANUAL, 'raid'))!;
        await w.logs.flush();
        const first = click(w, `banrec:unban:${record.id}`, DEV);
        await run(w, first);
        assert.equal(first.replies[0].embeds[0].data.title, '🔓 Unban urloffy?', 'a confirmation comes first');
        assert.ok(w.bans.has(USER), 'not unbanned before confirming');
        const confirm = click(w, `banrec:cunban:${record.id}`, DEV);
        await run(w, confirm);
        assert.equal(confirm.replies[0].embeds[0].data.title, '✅ urloffy unbanned');
        assert.equal(w.bans.has(USER), false);
        const updated = getRecord(w.store, G, record.id)!;
        assert.deepEqual([updated.status, updated.status_by, updated.reason], ['unbanned', DEV, 'raid'], 'original details kept, status added');
        // Discord's unban event arrives afterwards: no second update, no new record.
        await w.discordUnban(null, null);
        assert.equal(w.store.get('SELECT COUNT(*) AS n FROM ban_records')!.n, 1);
        await w.logs.flush();
        const edited = w.edits.at(-1)!.p;
        assert.deepEqual(buttons(edited).map((b: any) => b.disabled), [true, false], 'now only Reban is enabled');
        assert.match(fieldsOf(edited).Status, new RegExp(`^Unbanned by <@${DEV}>`));
    } finally { config.developers.delete(DEV); w.store.close(); }
});

test('Reban needs a reason, confirms, records the developer, and never starts a second record', async () => {
    const w = world();
    config.developers.add(DEV);
    try {
        const record = (await w.discordBan(MANUAL, 'raid'))!;
        await w.discordUnban(MANUAL, 'mistake');
        const open = click(w, `banrec:reban:${record.id}`, DEV);
        await run(w, open);
        assert.equal(open.replies[0].kind, 'modal');
        assert.equal(open.replies[0].modal.components[0].components[0].required, true, 'the reason is required');
        const form = click(w, `banrec:rebanform:${record.id}`, DEV, { modal: true, reason: 'came back and raided again' });
        await run(w, form);
        const confirmEmbed = form.replies[0].embeds[0].data;
        assert.equal(confirmEmbed.title, '🔨 Reban urloffy?');
        assert.equal(w.bans.has(USER), false, 'not banned before confirming');
        const confirm = click(w, `banrec:creban:${record.id}`, DEV, { embeds: [{ fields: confirmEmbed.fields }] });
        await run(w, confirm);
        assert.equal(confirm.replies[0].embeds[0].data.title, '🔨 urloffy rebanned');
        assert.ok(w.bans.has(USER));
        assert.match(w.bans.get(USER)!, new RegExp(`^${DEV}: Reban: came back and raided again`));
        // Discord's ban event for the reban: the open record already covers it.
        assert.equal(await w.store.withAuthorized(G, () => onBanAdd(w.store, w.logs, w.guild, w.user)), null);
        const updated = getRecord(w.store, G, record.id)!;
        assert.deepEqual([updated.status, updated.status_by, updated.status_reason], ['banned', DEV, 'came back and raided again']);
        assert.match(w.announcements.at(-1).content, new RegExp(`<@${DEV}> used the ban-log \\*\\*Reban\\*\\* button for <@${USER}>`));
        assert.equal(w.store.get('SELECT COUNT(*) AS n FROM ban_records')!.n, 1);
        assert.equal(JSON.parse(updated.history).map((h: any) => h.action).join(','), 'banned,unbanned,rebanned');
    } finally { config.developers.delete(DEV); w.store.close(); }
});

test('if Discord and the record disagree, the record is corrected (marked unverified) and nothing else happens', async () => {
    const w = world();
    config.developers.add(DEV);
    try {
        const record = (await w.discordBan(MANUAL, 'raid'))!;
        w.bans.delete(USER); // unbanned while the bot was offline: no event
        const c = click(w, `banrec:unban:${record.id}`, DEV);
        await run(w, c);
        assert.match(c.replies[0].content, /no longer banned on Discord, so the record was corrected/);
        const fixed = getRecord(w.store, G, record.id)!;
        assert.deepEqual([fixed.status, fixed.status_by, fixed.status_by_role], ['unbanned', null, 'unverified']);
        assert.match(fieldsOf(renderRecord(fixed)).Status, /Unavailable \(could not be verified\)/);
    } finally { config.developers.delete(DEV); w.store.close(); }
});

test('buttons keep working after a restart: everything they need is in the database', async () => {
    const w = world();
    config.developers.add(DEV);
    try {
        const record = (await w.discordBan(MANUAL, 'raid'))!;
        // A fresh queue and renderer, as after a restart.
        const logs = new LogQueue(w.store, w.guild.client);
        registerBanLogRenderer(w.store, logs);
        const c = click(w, `banrec:cunban:${record.id}`, DEV);
        await handleBanLogInteraction(c.i, { store: w.store, logs, assertLocalUnban: async () => undefined });
        assert.equal(c.replies[0].embeds[0].data.title, '✅ urloffy unbanned');
    } finally { config.developers.delete(DEV); w.store.close(); }
});

test('a Developer can lift a hardban straight from its record: it confirms, then revokes it everywhere', async () => {
    const w = world();
    config.developers.add(DEV);
    try {
        const record = (await w.discordBan(BOT, `[Vanguard hardban] HB-00005 ${DEV}: threats`))!;
        const lifted: any[] = [];
        const deps = { store: w.store, logs: w.logs, assertLocalUnban: async () => { throw new Error('only a developer can, with /unhardban'); },
            network: { active: () => ({ kind: 'hardban' as const, record: 'HB-00005' }),
                lift: async (userId: string, by: any, reason: string) => { lifted.push({ userId, by: by.id, reason }); w.bans.delete(userId); return { lifted: 3, failed: 0, servers: 3 }; } } };
        const ask = click(w, `banrec:unban:${record.id}`, DEV);
        await handleBanLogInteraction(ask.i, deps);
        assert.equal(ask.replies[0].embeds[0].data.title, '🔓 Unban urloffy?');
        assert.match(JSON.stringify(ask.replies[0]), /every\*\* Midtown server/, 'the confirmation says it is network-wide');
        assert.match(JSON.stringify(ask.replies[0]), /Unban everywhere/);
        assert.equal(lifted.length, 0, 'nothing happens before confirming');
        const confirm = click(w, `banrec:cunban:${record.id}`, DEV);
        confirm.i.editReply = async (p: any) => confirm.replies.push({ kind: 'edit', ...p });
        await handleBanLogInteraction(confirm.i, deps);
        assert.deepEqual(lifted.map(l => [l.userId, l.by]), [[USER, DEV]]);
        assert.equal(confirm.replies.at(-1).embeds[0].data.title, '✅ urloffy unbanned');
        assert.match(JSON.stringify(confirm.replies.at(-1)), /Unbanned in \*\*3 of 3/);
        assert.equal(getRecord(w.store, G, record.id)!.status, 'unbanned');
        const staff = click(w, `banrec:cunban:${record.id}`, STAFF);
        await handleBanLogInteraction(staff.i, deps);
        assert.match(staff.replies[0].content, /Only the server owner and Ghost Vanguard developers/, 'ordinary staff still cannot');
    } finally { config.developers.delete(DEV); w.store.close(); }
});

test('a normal ban that gets a hardban on top: the same record is upgraded, and goes back if the hardban is lifted', async () => {
    const { coverWithNetwork, uncoverNetwork } = await import('../src/audit/ban-log.js');
    const w = world();
    try {
        const record = (await w.discordBan(MANUAL, 'raid'))!;
        const ban = { id: 5, kind: 'hardban' as const, reason: 'threats', moderator_id: DEV, evidence: 'ticket 9', evidence_file: null };
        await w.store.withAuthorized(G, async () => coverWithNetwork(w.store, w.logs, G, { id: USER }, ban));
        let r = getRecord(w.store, G, record.id)!;
        assert.equal(w.store.get('SELECT COUNT(*) AS n FROM ban_records')!.n, 1, 'no second record');
        assert.deepEqual([r.kind, r.network_record, r.number], ['hardban', 'HB-00005', 1], 'same case ID, now showing the hardban');
        const f = fieldsOf(renderRecord(r));
        assert.match(f['Approved by'], /HB-00005/); assert.equal(f.Type, 'Hardban'); assert.equal(f.Evidence, 'ticket 9');
        assert.match(renderRecord(r).embeds[0].footer.text, /HB-00005/);
        assert.equal(f.Reason, 'raid', 'the original reason is kept');
        await w.store.withAuthorized(G, async () => uncoverNetwork(w.store, w.logs, G, USER, ban, DEV));
        r = getRecord(w.store, G, record.id)!;
        assert.deepEqual([r.kind, r.network_record, r.status], ['manual', null, 'banned'], "the server's own ban is shown again and stays");
        assert.match(r.history, /HB-00005 lifted; this server's own ban stays/);
    } finally { w.store.close(); }
});
