import { KeyedQueue } from '../core.js';
import { logEvent } from '../errors.js';
/** One active personal reply per user/server. Audit and incident messages never enter here. */
export class ReplyPanels {
    replies = new Map();
    queue = new KeyedQueue();
    wrap(interaction) {
        const i = interaction;
        const key = `${i.guildId ?? 'dm'}:${i.user.id}`;
        return new Proxy(interaction, { get: (target, property) => {
                const value = Reflect.get(target, property);
                if (['reply', 'editReply', 'followUp'].includes(String(property)) && typeof value === 'function')
                    return async (payload) => {
                        return this.queue.run(key, async () => {
                            const result = await value.call(target, payload);
                            if (!payload?.embeds?.length)
                                return result;
                            const id = property === 'followUp' ? result?.id : `original:${i.id}`;
                            if (!id)
                                return result;
                            const previous = this.replies.get(key);
                            if (previous && previous.id !== id && previous.at > Date.now() - 15 * 60 * 1000) {
                                try {
                                    await previous.remove();
                                }
                                catch (error) {
                                    // A deleted reply or expired interaction webhook is already unavailable.
                                    if (error?.code !== 10008 && error?.code !== 10015 && error?.code !== 10062)
                                        logEvent('old_reply_cleanup_unavailable', { guildId: i.guildId, userId: i.user.id });
                                }
                            }
                            const remove = property === 'followUp' ? () => i.webhook.deleteMessage(id) : () => i.deleteReply();
                            this.replies.set(key, { id, at: Date.now(), remove });
                            // Do not retain old interaction tokens indefinitely.
                            for (const [scope, reply] of this.replies)
                                if (reply.at < Date.now() - 15 * 60 * 1000)
                                    this.replies.delete(scope);
                            return result;
                        });
                    };
                return typeof value === 'function' ? value.bind(target) : value;
            } });
    }
    clearGuild(guild) {
        for (const key of this.replies.keys())
            if (key.startsWith(guild + ':'))
                this.replies.delete(key);
    }
}
