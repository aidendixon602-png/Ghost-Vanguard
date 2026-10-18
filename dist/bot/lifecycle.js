import { AuditLogEvent, PermissionFlagsBits } from 'discord.js';
import { setTimeout as delay } from 'node:timers/promises';
import { CONFIG_VERSION, VERSION } from '../config.js';
import { KeyedQueue } from '../core.js';
import { developers } from './developers.js';
import { AppError, logEvent } from '../errors.js';
import { pendingPanel, WELCOME_COOLDOWN_MS, welcomePanel } from '../ui/setup-tips.js';
export class GuildLifecycle {
    store;
    client;
    cleanup;
    initialize;
    queue = new KeyedQueue();
    timers = new Map();
    leaving = new Set();
    initialized = new Set();
    closed = false;
    constructor(store, client, cleanup = () => { }, initialize = async () => { }) {
        this.store = store;
        this.client = client;
        this.cleanup = cleanup;
        this.initialize = initialize;
    }
    cancel(id) {
        const timer = this.timers.get(id);
        if (timer)
            clearTimeout(timer);
        this.timers.delete(id);
    }
    arm(guild) {
        this.cancel(guild.id);
        const row = this.store.authorization(guild.id);
        if (row?.state !== 'PENDING_AUTHORIZATION' || this.closed)
            return;
        const timer = setTimeout(() => {
            void this.expire(guild).catch(error => {
                logEvent('authorization_expiry_error', { guildId: guild.id, error: error instanceof Error ? error.stack : String(error) });
                if (!this.closed) {
                    const retry = setTimeout(() => this.arm(guild), 5000);
                    retry.unref();
                    this.timers.set(guild.id, retry);
                }
            });
        }, Math.max(0, row.deadline - Date.now()));
        timer.unref();
        this.timers.set(guild.id, timer);
    }
    transition(id, state, actor) {
        this.store.transaction(() => {
            this.store.run('UPDATE guild_authorization SET state=?,removed_by=?,removed_at=?,generation=generation+1 WHERE guild_id=?', state, actor, Date.now(), id);
            const s = this.store.settings(id);
            s.enabled = false;
            s.mode = 'observe';
            this.store.save(s);
            this.store.auditAuthorization(id, state, actor);
        });
        this.cancel(id);
        this.initialized.delete(id);
        this.store.clearTemporary(id);
        this.cleanup(id);
        logEvent('server_state', { guildId: id, state, actor });
    }
    async notice(guild, message) {
        try {
            const channel = this.postChannel(guild, false);
            if (channel?.isSendable())
                await channel.send({ content: message, allowedMentions: { parse: [] } });
            else
                await this.dmOwner(guild, { content: message });
        }
        catch {
            logEvent('authorization_notice_unavailable', { guildId: guild.id });
        }
    }
    /** A channel Vanguard can post in, preferring the system channel; `embeds` also needs Embed Links. */
    /**
     * Where Vanguard's own setup messages go: only a staff-only channel that @everyone cannot see.
     * In order: the server's Vanguard logging channel, its security log channel, then a private
     * channel named like admin/staff/mod/logs, then any private text channel. Never a public one.
     */
    postChannel(guild, embeds) {
        const me = guild.members.me;
        const need = embeds ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] : [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
        const usable = (c) => !!c?.isSendable?.() && (!me || !!c.permissionsFor?.(me)?.has(need));
        const everyone = guild.roles?.everyone ?? guild.id;
        const isPrivate = (c) => !c.permissionsFor?.(everyone)?.has(PermissionFlagsBits.ViewChannel);
        const ok = (c) => usable(c) && isPrivate(c);
        const configured = this.isAuthorizedSafe(guild.id)
            ? [this.store.readGuild(guild.id, () => this.store.get('SELECT channel_id FROM event_log_config WHERE guild_id=?', guild.id)?.channel_id), this.store.settings(guild.id).logChannelId].filter(Boolean)
            : [];
        for (const id of configured) {
            const c = guild.channels.cache.get(String(id));
            if (ok(c))
                return c;
        }
        const channels = [...guild.channels.cache.values()].filter(ok).sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0));
        return channels.find((c) => /admin|staff|mod|management|log|vanguard|bot|owner|hr\b/i.test(c.name ?? '')) ?? channels[0];
    }
    isAuthorizedSafe(id) { try {
        return this.store.isAuthorized(id);
    }
    catch {
        return false;
    } }
    /** No staff-only channel at all: DM the server owner instead of posting in public. */
    async dmOwner(guild, payload) {
        try {
            const owner = await guild.fetchOwner();
            await owner.send({ ...payload, content: [`**${guild.name}:**`, payload.content].filter(Boolean).join(' '), allowedMentions: { parse: [] } });
            return { id: null, channelId: '' };
        }
        catch {
            logEvent('owner_dm_unavailable', { guildId: guild.id });
            return null;
        }
    }
    messageKey = (guild) => `welcome:message:${guild}`;
    /** The countdown message posted for this join, if it is still there. */
    async pendingMessage(guild) {
        const saved = String(this.store.get('SELECT value FROM runtime_meta WHERE key=?', this.messageKey(guild.id))?.value ?? '');
        this.store.run('DELETE FROM runtime_meta WHERE key=?', this.messageKey(guild.id));
        const [channelId, messageId] = saved.split(':');
        if (!channelId || !messageId)
            return null;
        const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
        return channel?.isTextBased() ? await channel.messages.fetch(messageId).catch(() => null) : null;
    }
    /**
     * One message per join, in one channel. The countdown posted while waiting for authorization
     * is edited into the welcome panel (or into a "left" note) instead of posting again. A new
     * message is posted at most once every 6 hours per server, remembered across restarts.
     */
    async welcome(guild, kind, inviter = null, now = Date.now()) {
        try {
            if (kind === 'ready') {
                const countdown = await this.pendingMessage(guild);
                if (countdown) {
                    await countdown.edit(welcomePanel(this.store, guild, inviter));
                    return true;
                }
            }
            const key = `welcome:${kind}:${guild.id}`;
            const last = Number(this.store.get('SELECT value FROM runtime_meta WHERE key=?', key)?.value ?? 0);
            if (now - last < WELCOME_COOLDOWN_MS) {
                logEvent('welcome_skipped_cooldown', { guildId: guild.id, kind });
                return false;
            }
            const channel = this.postChannel(guild, true);
            let sent = null;
            if (channel?.isSendable()) {
                const deadline = this.store.authorization(guild.id)?.deadline ?? now + 120000;
                sent = await channel.send(kind === 'pending' ? pendingPanel(guild, deadline) : welcomePanel(this.store, guild, inviter));
            }
            else if (this.postChannel(guild, false)?.isSendable()) {
                // A staff-only channel without Embed Links: a short plain-text version instead.
                const plain = this.postChannel(guild, false);
                if (!plain.isSendable())
                    return false;
                sent = await plain.send({ content: kind === 'pending'
                        ? 'Ghost Vanguard is waiting for an approved developer to run ,authserver within 120 seconds of joining; otherwise it leaves.'
                        : 'Ghost Vanguard is online. Anti-nuke starts in observe mode; run /setup logs setup, then /antinuke check and /antinuke enable after readiness passes.', allowedMentions: { parse: [] } });
            }
            else {
                // No staff-only channel: tell the owner privately rather than posting in public.
                const deadline = this.store.authorization(guild.id)?.deadline ?? now + 120000;
                const panel = kind === 'pending' ? pendingPanel(guild, deadline) : welcomePanel(this.store, guild, inviter);
                if (!await this.dmOwner(guild, { embeds: panel.embeds, content: 'No staff-only channel was found, so this was sent to you instead.' }))
                    return false;
            }
            this.store.run('INSERT INTO runtime_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(now));
            if (kind === 'pending' && sent?.id)
                this.store.run('INSERT INTO runtime_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', this.messageKey(guild.id), `${sent.channelId}:${sent.id}`);
            return true;
        }
        catch {
            logEvent('welcome_unavailable', { guildId: guild.id, kind });
            return false;
        }
    }
    async developerInviter(guild) {
        const me = guild.members.me;
        const joined = me?.joinedTimestamp;
        const botId = this.client.user?.id ?? me?.id;
        if (!botId || !joined || !me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
            logEvent('developer_invite_unverified', { guildId: guild.id, reason: 'Missing bot membership or View Audit Log permission; ,authserver is required.' });
            return;
        }
        // Bounded reads only when joining/pending after restart, never continuous polling.
        const attempts = Date.now() - joined < 120000 ? 3 : 1;
        for (let attempt = 0; attempt < attempts; attempt++) {
            let timer;
            try {
                const logs = await Promise.race([
                    guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 25 }),
                    new Promise((_, reject) => {
                        timer = setTimeout(() => reject(new Error('Invite audit lookup timed out')), 2500);
                    }),
                ]);
                // Check the latest matching installation, not any historic developer invite.
                const entry = [...logs.entries.values()]
                    .filter(e => e.action === AuditLogEvent.BotAdd && e.targetId === botId
                    && e.createdTimestamp >= joined - 1000 && e.createdTimestamp <= joined + 15000)
                    .sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];
                if (entry)
                    return entry.executorId && developers.has(entry.executorId) ? entry.executorId : undefined;
            }
            catch (error) {
                logEvent('developer_invite_unverified', { guildId: guild.id, reason: error instanceof Error ? error.message : 'Audit lookup failed; ,authserver is required.' });
                return;
            }
            finally {
                if (timer)
                    clearTimeout(timer);
            }
            if (attempt + 1 < attempts)
                await delay(750);
        }
        return;
    }
    async joined(guild, freshInvite = false) {
        this.store.markGuild(guild.id, guild.name, true);
        await this.queue.run(guild.id, async () => {
            if (this.store.get('SELECT 1 FROM server_bans WHERE guild_id=?', guild.id)) {
                this.ensureRow(guild);
                this.transition(guild.id, 'BANNED', null);
                logEvent('banned_server_invite', { guildId: guild.id });
                await this.leave(guild);
                return;
            }
            const row = this.store.authorization(guild.id);
            if (row?.state === 'AUTHORIZED') {
                this.store.run('UPDATE guild_authorization SET name=? WHERE guild_id=?', guild.name, guild.id);
                await this.start(guild);
                // Re-added after being removed: the role is new, so repeat the setup advice.
                if (freshInvite)
                    void this.welcome(guild, 'ready');
                return;
            }
            if (row && !freshInvite && row.state !== 'PENDING_AUTHORIZATION') {
                await this.leave(guild);
                return;
            }
            const joinedAt = guild.members.me?.joinedTimestamp;
            const renewedInvite = freshInvite && (row?.state !== 'PENDING_AUTHORIZATION' || joinedAt && joinedAt !== row.joined_at);
            if (!row || renewedInvite) {
                const joined = guild.members.me?.joinedTimestamp ?? Date.now();
                this.store.transaction(() => {
                    this.store.run(`INSERT INTO guild_authorization(guild_id,name,state,joined_at,deadline,version,config_version)
            VALUES(?,?,'PENDING_AUTHORIZATION',?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET name=excluded.name,state=excluded.state,joined_at=excluded.joined_at,deadline=excluded.deadline,generation=generation+1`, guild.id, guild.name, joined, joined + 120000, VERSION, CONFIG_VERSION);
                    this.store.auditAuthorization(guild.id, 'PENDING_AUTHORIZATION', null);
                });
                logEvent('server_pending', { guildId: guild.id, deadline: joined + 120000 });
            }
            const inviter = await this.developerInviter(guild);
            if (inviter && this.store.authorization(guild.id)?.state === 'PENDING_AUTHORIZATION') {
                await this.authorizeCurrent(guild, inviter);
                logEvent('developer_invite_authorized', { guildId: guild.id, actor: inviter });
                if (freshInvite || !row)
                    void this.welcome(guild, 'ready', inviter);
                return;
            }
            // The original join deadline remains fixed while verifying the inviter.
            this.arm(guild);
            if (!row || renewedInvite)
                void this.welcome(guild, 'pending');
        });
        if (this.store.authorization(guild.id)?.state === 'PENDING_AUTHORIZATION' && this.store.authorization(guild.id).deadline <= Date.now())
            await this.expire(guild);
    }
    ensureRow(guild) {
        this.store.run(`INSERT OR IGNORE INTO guild_authorization(guild_id,name,state,joined_at,version,config_version) VALUES(?,?,'PENDING_AUTHORIZATION',?,?,?)`, guild.id, guild.name, Date.now(), VERSION, CONFIG_VERSION);
    }
    isReady(id) {
        return this.initialized.has(id) && this.store.isAuthorized(id);
    }
    async start(guild) {
        this.store.assertAuthorized(guild.id);
        if (this.initialized.has(guild.id))
            return;
        await this.store.withAuthorized(guild.id, () => this.initialize(guild));
        this.store.assertAuthorized(guild.id);
        this.initialized.add(guild.id);
        logEvent('server_initialized', { guildId: guild.id });
    }
    async authorize(guild, actor) {
        developers.require(actor);
        const result = await this.queue.run(guild.id, () => this.authorizeCurrent(guild, actor));
        // Manual ,authserver: show the setup panel too (same 6-hour cooldown).
        if (this.store.isAuthorized(guild.id))
            void this.welcome(guild, 'ready', actor);
        return result;
    }
    // Caller holds the guild lifecycle queue; also used for verified developer invites.
    async authorizeCurrent(guild, actor) {
        developers.require(actor);
        if (this.leaving.has(guild.id))
            throw new AppError('AUTHORIZATION_ERROR', 'This server is already leaving. Invite the bot again.');
        if (this.store.get('SELECT 1 FROM server_bans WHERE guild_id=?', guild.id))
            throw new AppError('AUTHORIZATION_ERROR', 'This server is banned from Ghost Vanguard.');
        const row = this.store.authorization(guild.id);
        if (!row || !['PENDING_AUTHORIZATION', 'AUTHORIZED'].includes(row.state))
            throw new AppError('AUTHORIZATION_ERROR', 'The authorization window is closed. Invite the bot again.');
        if (row.state === 'AUTHORIZED') {
            await this.start(guild);
            return 'This server is already authorized and initialized.';
        }
        this.store.transaction(() => {
            this.store.run(`UPDATE guild_authorization SET state='AUTHORIZED',name=?,authorized_by=?,authorized_at=?,removed_by=NULL,removed_at=NULL,version=?,config_version=?,generation=generation+1 WHERE guild_id=?`, guild.name, actor, Date.now(), VERSION, CONFIG_VERSION, guild.id);
            this.store.auditAuthorization(guild.id, 'AUTHORIZED', actor);
        });
        this.cancel(guild.id);
        await this.start(guild);
        logEvent('server_authorized', { guildId: guild.id, actor });
        return `**${guild.name}** is authorized. New or unconfigured servers start in anti-nuke observe mode. Run /setup logs setup and /antinuke check; then use /antinuke enable and confirm to start enforcement. Existing staff opt-outs stay off.`;
    }
    async expire(guild) {
        return this.queue.run(guild.id, async () => {
            // The final DB read and synchronous transition share the authorization lock.
            const row = this.store.authorization(guild.id);
            if (!row || row.state !== 'PENDING_AUTHORIZATION' || row.deadline > Date.now() || this.store.isAuthorized(guild.id))
                return;
            this.transition(guild.id, 'EXPIRED', null);
            const leaving = async () => {
                // Turn the countdown into the goodbye, rather than posting another message.
                const countdown = await this.pendingMessage(guild).catch(() => null);
                if (countdown)
                    await countdown.edit({ content: 'Ghost Vanguard was not authorized within 120 seconds and has left this server.', embeds: [], components: [] }).catch(() => undefined);
                else
                    await this.notice(guild, 'Ghost Vanguard was not authorized within 120 seconds and is leaving this server.');
            };
            await Promise.race([leaving(), new Promise(resolve => {
                    const timer = setTimeout(resolve, 3000);
                    timer.unref();
                })]);
            await this.leave(guild);
        });
    }
    async deauthorize(guild, actor) {
        developers.require(actor);
        // Revoke before awaiting queues/network; in-flight work checks this DB state.
        this.ensureRow(guild);
        this.transition(guild.id, 'DEAUTHORIZED', actor);
        void this.queue.run(guild.id, () => this.leave(guild)).catch(error => logEvent('server_leave_error', { guildId: guild.id, error: String(error) }));
        return 'Authorization revoked. Protected work is canceled and the bot is leaving.';
    }
    async ban(id, name, reason, actor) {
        developers.require(actor);
        this.store.run('INSERT OR REPLACE INTO server_bans VALUES(?,?,?,?,?)', id, name, reason, actor, Date.now());
        const guild = this.client.guilds.cache.get(id);
        if (!this.store.authorization(id))
            this.store.run(`INSERT INTO guild_authorization(guild_id,name,state,joined_at) VALUES(?,?,'BANNED',?)`, id, name, Date.now());
        this.transition(id, 'BANNED', actor);
        if (guild)
            void this.queue.run(id, () => this.leave(guild)).catch(error => logEvent('server_leave_error', { guildId: id, error: String(error) }));
        return `Server **${name}** (${id}) is banned.`;
    }
    unban(id, actor) {
        developers.require(actor);
        this.store.transaction(() => {
            this.store.run('DELETE FROM server_bans WHERE guild_id=?', id);
            if (this.store.authorization(id)?.state === 'BANNED')
                this.store.run("UPDATE guild_authorization SET state='DEAUTHORIZED',generation=generation+1 WHERE guild_id=?", id);
            this.store.auditAuthorization(id, 'DEAUTHORIZED', actor, 'Server ban removed; new invite and authorization required.');
        });
        logEvent('server_unbanned', { guildId: id, actor });
        return `Server ${id} is unbanned. A new invite and ,authserver are required.`;
    }
    async leave(guild) {
        if (this.store.isAuthorized(guild.id) || !this.client.guilds.cache.has(guild.id))
            return;
        this.leaving.add(guild.id);
        try {
            await guild.leave();
        }
        catch (error) {
            logEvent('server_leave_retry', { guildId: guild.id, error: String(error) });
            if (!this.closed) {
                const timer = setTimeout(() => {
                    void this.queue.run(guild.id, () => this.leave(guild)).catch(() => { });
                }, 5000);
                timer.unref();
                this.timers.set(guild.id, timer);
            }
        }
    }
    departed(id) {
        this.store.markGuild(id, this.store.authorization(id)?.name ?? '', false);
        this.cancel(id);
        this.initialized.delete(id);
        this.cleanup(id);
        this.leaving.delete(id);
    }
    close() {
        this.closed = true;
        for (const id of this.timers.keys())
            this.cancel(id);
    }
}
