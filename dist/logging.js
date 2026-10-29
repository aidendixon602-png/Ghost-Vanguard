import { gvText } from './ui/gv-names.js';
/** After this many failures a row waits 30 minutes between attempts; after KEEP_MS it is dropped. */
export const FAST_ATTEMPTS = 8;
export const SLOW_RETRY_MS = 30 * 60000;
export const KEEP_MS = 7 * 86400000;
export class LogQueue {
    store;
    client;
    busy = false;
    canDeliver = id => this.store.isAuthorized(id);
    refs = new Map();
    constructor(store, client) {
        this.store = store;
        this.client = client;
    }
    /** Queue an alert for the guild's log channel, or for `channelId` when a feature has its own channel. */
    push(guildId, e, rows = [], channelId) {
        if (!this.store.isAuthorized(guildId))
            return;
        const channel = channelId || this.store.settings(guildId).logChannelId;
        // Plain alerts keep the original format (a bare embed); alerts with buttons wrap both.
        const json = rows.length ? { embed: e.toJSON(), components: rows.map(r => r.toJSON()) } : e.toJSON();
        if (channel)
            this.insert(guildId, channel, json);
    }
    /** Queue a live record: posted once, rendered from the database when it is sent. */
    pushRef(guildId, channelId, ref, id) {
        if (!this.store.isAuthorized(guildId))
            return;
        // Never queue the same record twice.
        if (this.store.get("SELECT 1 FROM outbox WHERE guild_id=? AND json=?", guildId, JSON.stringify({ ref, id })))
            return;
        this.insert(guildId, channelId, { ref, id });
    }
    /** Update a record's posted message to its current state. */
    refreshRef(guildId, ref, id) {
        if (!this.store.isAuthorized(guildId))
            return;
        const json = JSON.stringify({ ref, id, edit: true });
        if (this.store.get('SELECT 1 FROM outbox WHERE guild_id=? AND json=?', guildId, json))
            return;
        const where = this.refs.get(ref)?.location(guildId, id);
        this.insert(guildId, where?.channelId ?? '0', JSON.parse(json));
    }
    insert(guildId, channel, json) {
        this.store.run('INSERT INTO outbox(guild_id,channel_id,json,created_at) VALUES(?,?,?,?)', guildId, channel, JSON.stringify(json), Date.now());
    }
    async flush() {
        if (this.busy || !this.client.isReady())
            return;
        this.busy = true;
        try {
            const now = Date.now();
            this.store.run('DELETE FROM outbox WHERE created_at IS NOT NULL AND created_at<?', now - KEEP_MS);
            for (const row of this.store.all('SELECT * FROM outbox WHERE next_at<=? ORDER BY id LIMIT 5', now)) {
                if (!this.store.isAuthorized(row.guild_id)) {
                    this.store.run('DELETE FROM outbox WHERE id=?', row.id);
                    continue;
                }
                if (!this.canDeliver(row.guild_id))
                    continue;
                try {
                    const stored = JSON.parse(row.json);
                    if (stored.ref) {
                        await this.deliverRef(row, stored);
                        continue;
                    }
                    const channel = await this.client.channels.fetch(row.channel_id);
                    if (!channel?.isSendable())
                        throw new Error('Log channel missing or not sendable');
                    if (!this.store.isAuthorized(row.guild_id))
                        continue;
                    const message = stored.embed ? { embeds: [stored.embed], components: stored.components ?? [] } : { embeds: [stored] };
                    await channel.send({ ...gvText(message), allowedMentions: { parse: [] }, nonce: `mv${row.id}`, enforceNonce: true });
                    this.store.run('DELETE FROM outbox WHERE id=?', row.id);
                }
                catch (error) {
                    this.failed(row, error);
                }
            }
        }
        finally {
            this.busy = false;
        }
    }
    async deliverRef(row, stored) {
        const renderer = this.refs.get(stored.ref);
        const payload = renderer?.render(row.guild_id, stored.id);
        if (!renderer || !payload) {
            this.store.run('DELETE FROM outbox WHERE id=?', row.id);
            return;
        }
        const message = { ...gvText(payload), allowedMentions: { parse: [] } };
        if (stored.edit) {
            const where = renderer.location(row.guild_id, stored.id);
            // Not posted yet: the pending post renders the latest state anyway.
            if (!where) {
                this.store.run('DELETE FROM outbox WHERE id=?', row.id);
                return;
            }
            const channel = await this.client.channels.fetch(where.channelId);
            if (!channel?.isTextBased())
                throw new Error('Log channel missing');
            try {
                await channel.messages.edit(where.messageId, message);
            }
            catch (error) {
                // The posted message was deleted: post it again so the record stays visible.
                if (error?.code !== 10008)
                    throw error;
                renderer.posted(row.guild_id, stored.id, null, null);
                this.pushRef(row.guild_id, where.channelId, stored.ref, stored.id);
            }
            this.store.run('DELETE FROM outbox WHERE id=?', row.id);
            return;
        }
        const channel = await this.client.channels.fetch(row.channel_id);
        if (!channel?.isSendable())
            throw new Error('Log channel missing or not sendable');
        const sent = await channel.send({ ...message, nonce: `mv${row.id}`, enforceNonce: true });
        renderer.posted(row.guild_id, stored.id, channel.id, sent.id);
        this.store.run('DELETE FROM outbox WHERE id=?', row.id);
    }
    failed(row, error) {
        const attempts = Number(row.attempts) + 1;
        const wait = attempts >= FAST_ATTEMPTS ? SLOW_RETRY_MS : Math.min(300000, 5000 * 2 ** attempts);
        this.store.run('UPDATE outbox SET attempts=?,next_at=?,created_at=COALESCE(created_at,?) WHERE id=?', attempts, Date.now() + wait, Date.now(), row.id);
        if (attempts === FAST_ATTEMPTS)
            console.error(`[logs] Delivery ${row.id} keeps failing (${error instanceof Error ? error.message : 'unknown error'}); retrying every 30 minutes for up to 7 days. Check /setup logs check.`);
    }
}
