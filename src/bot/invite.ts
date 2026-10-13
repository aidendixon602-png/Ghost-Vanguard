import { PermissionsBitField } from 'discord.js';
import { config } from '../config.js';
import { REQUIRED_PERMISSIONS } from '../ui/ui.js';
import { style } from '../console-ui.js';

export function inviteUrl(clientId = config.clientId, guildId?: string): string {
    if (!/^\d{17,20}$/.test(clientId))
        throw new Error('A valid DISCORD_CLIENT_ID is required to generate an invite.');
    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('scope', 'bot applications.commands');
    url.searchParams.set('integration_type', '0');
    url.searchParams.set('permissions', new PermissionsBitField(REQUIRED_PERMISSIONS).bitfield.toString());
    if (guildId && /^\d{17,20}$/.test(guildId)) {
        url.searchParams.set('guild_id', guildId);
        url.searchParams.set('disable_guild_select', 'true');
    }
    return url.toString();
}

export function printStartupInvite(serverCount: number, clientId = config.clientId): void {
    if (serverCount === 0)
        console.log(`  ${style.yellow('!')} Connected to 0 servers. Invite the bot with the link below before using server commands.`);
    console.log(`  ${style.bold('Invite link')}`);
    // A public installation URL only. Keep this separate from redacted diagnostic logs.
    console.log(`  ${inviteUrl(clientId)}`);
    console.log(style.dim('  Invite with an account listed in DEVELOPER_IDS to authorize automatically,'));
    console.log(style.dim('  otherwise run /dev server authorize within 120 seconds of inviting.'));
}
