import type { Client, User } from 'discord.js';
import { config } from '../config.js';

/**
 * The only people the bot ever DMs about the bot itself: database backup files, "back online",
 * backup failures, empty-database warnings and genreban exceptions. Set with TRUSTED_DM_IDS;
 * defaults to BOT_OWNER_ID alone. Ranks (Supreme Leader, developer) never add anyone to this list.
 */
export const trustedRecipients = (): string[] => [...config.trustedDmIds].filter(id => /^\d{17,20}$/.test(id));

export async function dmTrusted(client: Client | undefined, payload: Parameters<User['send']>[0]): Promise<number> {
    if (!client?.users) return 0;
    let sent = 0;
    for (const id of trustedRecipients()) {
        const user = await client.users.fetch(id).catch(() => null);
        if (user && await user.send(payload).then(() => true, () => false)) sent++;
    }
    return sent;
}
