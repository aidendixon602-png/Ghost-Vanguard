import { PermissionFlagsBits, type Guild } from 'discord.js';
import type { Store } from '../database/db.js';

export function readiness(guild: Guild, logChannelId: string | null, store: Pick<Store, 'hasGrant'>) {
    const bot = guild.members?.me;
    const required = ['ViewAuditLog','ManageRoles','ManageChannels','BanMembers','KickMembers','ModerateMembers','ManageWebhooks'] as const;
    const missing = required.filter(name => !bot?.permissions.has(PermissionFlagsBits[name])).map(String);
    const channel = logChannelId ? guild.channels?.cache?.get(logChannelId) : null;
    if (!channel || !channel.isTextBased() || !('permissionsFor' in channel)) missing.push('Accessible security log channel');
    else {
        const permissions = bot ? channel.permissionsFor(bot) : null;
        for (const name of ['ViewChannel','SendMessages','EmbedLinks'] as const)
            if (!permissions?.has(PermissionFlagsBits[name])) missing.push(`Log channel: ${name}`);
    }
    const above = [...(guild.roles?.cache?.values() ?? [])].filter(role => role.id !== guild.id && !role.managed && role.id !== bot?.roles.highest.id && (!bot || role.position >= bot.roles.highest.position));
    // Only an active anti-nuke ROLE grant exempts everyone holding this role.
    // Individual user grants and verification-bot grants do not exempt a role.
    const bypassed = above.filter(role => store.hasGrant(guild.id, role.id, 'trust_role'));
    const unprotected = above.filter(role => !bypassed.includes(role));
    return {missing, above:unprotected.map(role => role.name), bypassed:bypassed.map(role => role.name), text: `${missing.length ? '**Missing:** ' + missing.join(', ') : '**Permissions:** ready'}\n${unprotected.length ? '**Hierarchy warning:** ' + unprotected.length + ' role(s) are at or above Vanguard: ' + unprotected.slice(0,10).map(role => role.name).join(', ') + '. Vanguard cannot contain those members.' : '**Role hierarchy:** ready'}${bypassed.length ? '\n**Bypassed roles above Vanguard:** ' + bypassed.slice(0,10).map(role => role.name).join(', ') + ' · exempt from anti-nuke enforcement.' : ''}`};
}
