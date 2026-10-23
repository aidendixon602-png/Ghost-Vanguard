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

/**
 * Who gets security alerts by DM (anti-nuke strips, protected roles, protected users): the bot's Developers
 * (BOT_OWNER_ID and DEVELOPER_IDS) plus TRUSTED_DM_IDS. Backup files and other bot DMs still go only to
 * TRUSTED_DM_IDS. Each person is DMed once even if they are on both lists.
 */
export const securityAlertRecipients = (): string[] =>
    [...new Set([config.ownerId, ...config.developers, ...trustedRecipients()])].filter(id => /^\d{17,20}$/.test(id ?? ''));

export async function dmSecurityAlert(client: Client | undefined, payload: Parameters<User['send']>[0]): Promise<number> {
    if (!client?.users) return 0;
    let sent = 0;
    for (const id of securityAlertRecipients()) {
        const user = await client.users.fetch(id).catch(() => null);
        if (user && await user.send(payload).then(() => true, () => false)) sent++;
    }
    return sent;
}
